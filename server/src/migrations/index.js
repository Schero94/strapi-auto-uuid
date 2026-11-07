/**
 * Scanning, repair, export and import of UUID field values.
 *
 * Every scan reads all database rows of a content type (all locales, drafts
 * and published versions) through the transaction-aware query engine, in
 * primary-key order. A "document" is one Strapi documentId; its draft,
 * published version and locales may share a value. Repairs write with
 * `updateMany` per document and old value, so draft and published rows stay
 * in sync and no other field is touched.
 *
 * Real writes run in one transaction, inside the repair context (which lets
 * the lifecycle hooks accept replacements of immutable values) and under a
 * process-local lock plus a cross-process database lock (see
 * `utils/cluster-lock.js`). The plan is computed inside that transaction, so
 * values an editor changed after the preview are never overwritten with a
 * stale plan.
 *
 * Every write is guarded by the value it expects (old value, or empty). When
 * an editor on another process changed the row between scan and write, the
 * guarded write matches no row; it is then not counted as fixed or imported
 * and is reported as skipped with code CONCURRENT_CHANGE.
 */

import {
  canonicalUuidValue,
  classifyUuidFieldValue,
  uuidValueSpellings,
} from '../../../shared/uuid-field.js';
import { getPluginConfig } from '../config/index.js';
import { withUuidRepairContext } from '../utils/repair-context.js';
import { LOCK_SPACES, getDialect, lockKeys, valueLockKey } from '../utils/cluster-lock.js';
import { assertClusterRepairLock, runExclusiveRepair } from '../utils/repair-lock.js';
import {
  fetchFieldRows,
  getUuidModels,
  groupDuplicates,
  isLocalizedAttribute,
  resolveFieldOptions,
} from '../utils/uuid-models.js';

export const EXPORT_FORMAT = 2;
export const MAX_REPORTED_ERRORS = 20;
/** Entries looked up per batched query during an import. */
export const IMPORT_LOOKUP_CHUNK = 500;

const isEmpty = (value) => value === null || value === undefined || value === '';
const EMPTY_WHERE = (field) => ({ $or: [{ [field]: { $null: true } }, { [field]: '' }] });
const CONCURRENT_MESSAGE =
  'An entry changed while the operation ran (for example on another server instance). It was skipped.';

/**
 * Reads the affected-row count of a query-engine `updateMany` result.
 * Unknown result shapes count as written, so a missing count never hides a
 * write.
 *
 * @param {unknown} result `updateMany` result (`{ count }`).
 * @returns {number} Affected rows.
 */
export const affectedRows = (result) =>
  Number.isFinite(result?.count) ? result.count : Number.isFinite(result) ? result : 1;

/** Carries safe context when a batch must abort and roll back. */
class RepairWriteError extends Error {
  /**
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {string} operation Failed operation category.
   */
  constructor(uid, field, operation) {
    super('UUID repair write failed.');
    this.name = 'RepairWriteError';
    this.uid = uid;
    this.field = field;
    this.operation = operation;
  }
}

/**
 * Maps a failure to a user-safe message and stable code without exposing
 * database errors, identifiers or stored values.
 *
 * @param {Error} error Failure.
 * @returns {{ code: string, message: string }} Safe description.
 */
function safeFieldFailure(error) {
  if (error?.code === 'INVALID_UUID_FIELD_CONFIG') {
    return {
      code: 'INVALID_UUID_FIELD_CONFIG',
      message: 'UUID field configuration is invalid. Check its version and prefix.',
    };
  }
  return {
    code: 'SCAN_FAILED',
    message: 'Could not scan this UUID field. No repairs were attempted.',
  };
}

/**
 * Collects errors as counts per code plus a bounded list of samples, so the
 * response size does not grow with the payload.
 */
function createErrorCollector() {
  const errors = [];
  const errorCounts = {};
  return {
    errors,
    errorCounts,
    add(error) {
      errorCounts[error.code] = (errorCounts[error.code] || 0) + 1;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(error);
    },
  };
}

/**
 * Analyses the rows of one UUID field.
 *
 * A "unit" is the set of rows that must hold the same value: all rows of a
 * document for a non-localized field (locales, draft and published), or the
 * draft and published row of one locale for a localized field. This mirrors
 * the lifecycle hooks, which give every locale of a localized field its own
 * value. Repairs never copy a value from one unit to another.
 *
 * @param {Array<Record<string, unknown>>} rows Rows from fetchFieldRows.
 * @param {string} field UUID field name.
 * @param {{ version: string, prefix: string, disableAutoGenerate: boolean }} options Field options.
 * @param {{ localized?: boolean }} [shape] Whether the field has a value per locale.
 * @returns {Object} Counts and the per-unit data needed to plan a repair.
 */
export function analyseFieldRows(rows, field, options, { localized = false } = {}) {
  const units = new Map();
  const byDocument = new Map();
  for (const row of rows) {
    const key = localized ? `${row.documentId}\u0000${row.locale ?? ''}` : row.documentId;
    let unit = units.get(key);
    if (!unit) {
      unit = { key, documentId: row.documentId, values: new Set(), hasEmpty: false };
      if (localized && !isEmpty(row.locale)) unit.locale = row.locale;
      units.set(key, unit);
      const keys = byDocument.get(row.documentId);
      if (keys) keys.push(key);
      else byDocument.set(row.documentId, [key]);
    }
    if (isEmpty(row[field])) unit.hasEmpty = true;
    else unit.values.add(row[field]);
  }

  const malformed = [];
  const legacy = [];
  const emptyUnits = [];
  for (const unit of units.values()) {
    if (unit.hasEmpty) emptyUnits.push(unit);
    for (const value of unit.values) {
      const kind = classifyUuidFieldValue(value, options);
      if (kind === 'malformed') malformed.push({ unit, value });
      if (kind === 'legacy') legacy.push({ unit, value });
    }
  }

  const duplicates = groupDuplicates(rows, field);
  const manual = options.disableAutoGenerate;

  return {
    units,
    byDocument,
    entryCount: byDocument.size,
    emptyCount: manual ? 0 : emptyUnits.length,
    manualEmptyCount: manual ? emptyUnits.length : 0,
    invalidCount: malformed.length,
    legacyCount: legacy.length,
    duplicateCount: duplicates.reduce((sum, group) => sum + group.count - 1, 0),
    duplicateGroups: duplicates.length,
    emptyUnits: manual ? [] : emptyUnits,
    malformed,
    legacy,
    duplicates,
  };
}

/**
 * Builds the query-engine filter for the rows of one unit.
 *
 * @param {{ documentId: string, locale?: string }} unit Unit from analyseFieldRows.
 * @returns {Array<Object>} `$and` conditions.
 */
const unitWhere = (unit) =>
  unit.locale === undefined
    ? [{ documentId: unit.documentId }]
    : [{ documentId: unit.documentId }, { locale: unit.locale }];

const migrations = ({ strapi }) => {
  /**
   * findMany that returns the latest committed rows. MySQL runs transactions
   * in REPEATABLE READ, where a plain read returns the snapshot taken at the
   * first read; a locking read returns the latest version. PostgreSQL runs
   * READ COMMITTED, where every statement sees the latest committed rows.
   */
  const readLatest = (uid, params) =>
    getDialect(strapi) === 'mysql' && strapi.db.inTransaction()
      ? strapi.db.queryBuilder(uid).init(params).forUpdate().execute()
      : strapi.db.query(uid).findMany(params);

  const getOptions = (uid, field) =>
    resolveFieldOptions(strapi, uid, field, getPluginConfig(strapi).defaultVersion);

  const generateValue = (uid, field, reserved) =>
    strapi.plugin('field-uuid').service('service').generateUniqueFieldValue(uid, field, reserved);

  /**
   * Scans every UUID field. Field failures are reported and mark the report
   * as incomplete instead of clean.
   *
   * @returns {Promise<{ fields: Array<Object>, failures: Array<Object> }>}
   */
  const scanAll = async () => {
    const fields = [];
    const failures = [];
    for (const [uid, names] of Object.entries(getUuidModels(strapi))) {
      for (const field of names) {
        try {
          const options = getOptions(uid, field);
          const rows = await fetchFieldRows(strapi, uid, field);
          const localized = isLocalizedAttribute(strapi.contentTypes[uid]?.attributes?.[field]);
          fields.push({
            uid,
            field,
            options,
            analysis: analyseFieldRows(rows, field, options, { localized }),
          });
        } catch (error) {
          failures.push({ uid, field, ...safeFieldFailure(error) });
        }
      }
    }
    return { fields, failures };
  };

  /**
   * Builds and optionally applies the repair plan for the scanned fields.
   *
   * @param {Array<Object>} fields Scan result.
   * @param {Object} flags Which categories to repair.
   * @param {boolean} write Whether to write.
   * @param {Object} result Result to fill.
   */
  const applyPlan = async (fields, flags, write, result) => {
    for (const { uid, field, options, analysis } of fields) {
      const reserved = new Set();
      const handled = new Set();
      // `${unit.key}\u0000${oldValue}` -> new value, for the empty-field step.
      const replacements = new Map();
      const query = strapi.db.query(uid);
      const addSkipped = (entry) => {
        if (result.skippedChanges.length < MAX_REPORTED_ERRORS) result.skippedChanges.push(entry);
      };

      /**
       * Records and (when writing) applies one change.
       *
       * @returns {Promise<boolean>} False when the guarded write matched no
       *   row because the value changed concurrently.
       */
      const replace = async (type, unit, oldValue, newValue, extra = {}) => {
        const change = { type, uid, field, documentId: unit.documentId, oldValue, newValue };
        if (unit.locale !== undefined) change.locale = unit.locale;
        let written;
        if (write) {
          try {
            written = await query.updateMany({
              where: {
                $and: [
                  ...unitWhere(unit),
                  isEmpty(oldValue) ? EMPTY_WHERE(field) : { [field]: oldValue },
                ],
              },
              data: { [field]: newValue },
            });
          } catch {
            throw new RepairWriteError(uid, field, 'write');
          }
          if (affectedRows(written) === 0) {
            result.skipped += 1;
            addSkipped({ uid, field, code: 'CONCURRENT_CHANGE', message: CONCURRENT_MESSAGE });
            return false;
          }
        }
        result.changes.push({ ...change, ...extra });
        return true;
      };

      const fresh = async () => {
        try {
          const value = await generateValue(uid, field, reserved);
          reserved.add(value);
          return value;
        } catch {
          throw new RepairWriteError(uid, field, 'generate');
        }
      };

      const replaceValue = async (unit, value, type, category, extra) => {
        const key = `${unit.key}\u0000${value}`;
        if (handled.has(key)) return;
        handled.add(key);
        const next = await fresh();
        if (!(await replace(type, unit, value, next, extra))) return;
        replacements.set(key, next);
        result.fixed[category] += 1;
      };

      if (flags.fixInvalid) {
        for (const { unit, value } of analysis.malformed) {
          await replaceValue(unit, value, 'invalid_fix', 'invalid');
        }
      }
      if (flags.fixLegacy) {
        for (const { unit, value } of analysis.legacy) {
          await replaceValue(unit, value, 'legacy_fix', 'legacy');
        }
      }

      if (flags.fixDuplicates) {
        for (const group of analysis.duplicates) {
          const [kept, ...others] = group.documentIds;
          for (const documentId of others) {
            // Every spelling of the value held by the document (draft,
            // published, locales) is replaced; one new value per unit.
            for (const key of analysis.byDocument.get(documentId) ?? []) {
              const unit = analysis.units.get(key);
              for (const value of unit.values) {
                if (canonicalUuidValue(value) !== group.uuid) continue;
                await replaceValue(unit, value, 'duplicate_fix', 'duplicates', {
                  keptDocumentId: kept,
                });
              }
            }
          }
        }
      }

      if (flags.fixEmpty) {
        for (const unit of analysis.emptyUnits) {
          // Reuse the unit's own value (for example a draft that has a value
          // while the published row predates the field) when it has exactly
          // one, taking a replacement made above into account. A value is
          // never taken from another locale of a localized field.
          const own = [
            ...new Set(
              [...unit.values].map(
                (value) => replacements.get(`${unit.key}\u0000${value}`) ?? value
              )
            ),
          ];
          const reusable =
            own.length === 1 && classifyUuidFieldValue(own[0], options) !== 'malformed'
              ? own[0]
              : null;
          if (await replace('empty_fix', unit, null, reusable ?? (await fresh()))) {
            result.fixed.empty += 1;
          }
        }
      }
    }
  };

  return {
    /**
     * Returns per-field counts of empty, malformed, legacy-format and
     * duplicate values. No record identifiers or values are included.
     *
     * @returns {Promise<Object>} Status report.
     */
    async checkMigrationStatus() {
      const { fields, failures } = await scanAll();
      const report = {
        needsMigration: failures.length > 0,
        hasErrors: failures.length > 0,
        contentTypes: [],
        totalFields: fields.length + failures.length,
        totalEntries: 0,
        issues: failures.map(({ uid, field, code, message }) => ({ uid, field, code, message })),
      };

      // Entries are documents, counted once per content type even when it
      // has several UUID fields (each field scans the same documents).
      const entriesPerType = new Map();
      for (const { uid, field, analysis } of fields) {
        const { entryCount, emptyCount, manualEmptyCount, invalidCount, legacyCount } = analysis;
        const { duplicateCount, duplicateGroups } = analysis;
        entriesPerType.set(uid, Math.max(entriesPerType.get(uid) ?? 0, entryCount));
        if (emptyCount > 0 || invalidCount > 0 || duplicateCount > 0) report.needsMigration = true;
        report.contentTypes.push({
          uid,
          field,
          entryCount,
          emptyCount,
          manualEmptyCount,
          invalidCount,
          legacyCount,
          duplicateCount,
          duplicateGroups,
        });
      }
      for (const { uid, field, code, message } of failures) {
        report.contentTypes.push({ uid, field, scanFailed: true, code, error: message });
      }
      report.totalEntries = [...entriesPerType.values()].reduce((sum, count) => sum + count, 0);
      return report;
    },

    /**
     * Repairs UUID values. Without `dryRun: false` only a preview is built.
     *
     * @param {Object} [options] Repair options.
     * @param {boolean} [options.dryRun=true] Preview only.
     * @param {boolean} [options.fixEmpty=true] Fill empty auto-generated fields.
     * @param {boolean} [options.fixInvalid=true] Replace malformed values.
     * @param {boolean} [options.fixDuplicates=true] Replace values shared by several documents
     *   (the oldest document keeps its value).
     * @param {boolean} [options.fixLegacy=false] Replace well-formed values whose version or prefix
     *   no longer matches the field. Off by default because existing integrations may use them.
     * @returns {Promise<Object>} Counts, changes (redacted by the controller) and safe errors.
     * @throws {import('../utils/repair-lock.js').RepairInProgressError} When another repair runs.
     */
    async runMigration({
      dryRun = true,
      fixEmpty = true,
      fixInvalid = true,
      fixDuplicates = true,
      fixLegacy = false,
    } = {}) {
      const flags = { fixEmpty, fixInvalid, fixDuplicates, fixLegacy };
      const result = {
        dryRun,
        startedAt: new Date().toISOString(),
        fixed: { empty: 0, invalid: 0, legacy: 0, duplicates: 0 },
        skipped: 0,
        skippedChanges: [],
        errors: [],
        changes: [],
      };
      const finish = () => {
        const { empty, invalid, legacy, duplicates } = result.fixed;
        result.totalFixed = empty + invalid + legacy + duplicates;
        result.completedAt = new Date().toISOString();
        return result;
      };

      const execute = async () => {
        const { fields, failures } = await scanAll();
        if (failures.length > 0) {
          result.aborted = true;
          result.errors = failures.map(({ uid, field, code, message }) => ({
            uid,
            field,
            code,
            message,
          }));
          return;
        }
        await applyPlan(fields, flags, !dryRun, result);
      };

      try {
        if (dryRun) {
          await execute();
        } else {
          await runExclusiveRepair('migration', () =>
            withUuidRepairContext(() =>
              strapi.db.transaction(async () => {
                await assertClusterRepairLock(strapi);
                await execute();
              })
            )
          );
          if (result.totalFixed !== 0 || result.changes.length > 0) {
            strapi.log.info(
              `[strapi-auto-uuid] Repair finished: ${result.changes.length} change(s)`
            );
          }
        }
      } catch (error) {
        if (error?.code === 'REPAIR_IN_PROGRESS') throw error;
        result.failed = true;
        result.rolledBack = !dryRun;
        result.errors = [
          {
            uid: error?.uid,
            field: error?.field,
            code: 'REPAIR_FAILED',
            operation: error?.operation || 'batch',
            message: dryRun
              ? 'Repair preview failed. No changes were made.'
              : 'Repair failed. The transaction was rolled back; no changes were kept.',
          },
        ];
        result.changes = [];
        result.skipped = 0;
        result.skippedChanges = [];
        result.fixed = { empty: 0, invalid: 0, legacy: 0, duplicates: 0 };
      }
      return finish();
    },

    /**
     * Exports every non-empty UUID value as `{ documentId, locale?, uuid }`
     * per content type and field. Draft and published rows with the same
     * value are listed once.
     *
     * @returns {Promise<Object>} Export document.
     */
    async exportMappings() {
      const exportData = {
        exportedAt: new Date().toISOString(),
        format: EXPORT_FORMAT,
        mappings: {},
      };

      for (const [uid, names] of Object.entries(getUuidModels(strapi))) {
        exportData.mappings[uid] = { fields: {} };
        for (const field of names) {
          const rows = await fetchFieldRows(strapi, uid, field);
          const seen = new Set();
          const entries = [];
          for (const row of rows) {
            if (isEmpty(row[field])) continue;
            const key = `${row.documentId}\u0000${row.locale ?? ''}\u0000${row[field]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const entry = { documentId: row.documentId, uuid: row[field] };
            if (row.locale) entry.locale = row.locale;
            entries.push(entry);
          }
          exportData.mappings[uid].fields[field] = entries;
        }
      }
      return exportData;
    },

    /**
     * Imports UUID values into empty fields. Existing values are never
     * replaced. A value must match the destination field's version and prefix
     * and must not be used by another document.
     *
     * @param {Object} importData Export-shaped document (validated by the controller).
     * @param {Object} [options] Import options.
     * @param {boolean} [options.dryRun=true] Preview only.
     * @returns {Promise<Object>} Counts, bounded error samples and error counts.
     * @throws {import('../utils/repair-lock.js').RepairInProgressError} When another repair runs.
     */
    async importMappings(importData, { dryRun = true } = {}) {
      const collector = createErrorCollector();
      const result = {
        dryRun,
        imported: 0,
        skipped: 0,
        unchanged: 0,
        errors: collector.errors,
        errorCounts: collector.errorCounts,
        changes: [],
      };

      if (!importData?.mappings || typeof importData.mappings !== 'object') {
        collector.add({
          code: 'INVALID_IMPORT',
          message: 'Invalid import data. A mappings object is required.',
        });
        return result;
      }

      const service = strapi.plugin('field-uuid').service('service');

      const execute = async () => {
        for (const [uid, ctData] of Object.entries(importData.mappings)) {
          for (const [field, entries] of Object.entries(ctData?.fields || {})) {
            if (!service.validateUuidField(uid, field).valid) {
              collector.add({
                uid,
                field,
                code: 'UNKNOWN_FIELD',
                message: 'The target UUID field is missing or has an invalid configuration.',
              });
              result.skipped += entries.length;
              continue;
            }
            const options = service.getFieldOptions(uid, field);
            const hasLocale = Boolean(strapi.contentTypes?.[uid]?.attributes?.locale);
            const seenValues = new Map();
            const seenTargets = new Set();
            const query = strapi.db.query(uid);
            const skip = (code, message) => {
              result.skipped += 1;
              if (code) collector.add({ uid, field, code, message });
            };

            // Checks that need no database access.
            const pending = [];
            for (const entry of entries) {
              const target = `${entry.documentId}\u0000${entry.locale ?? ''}`;
              if (classifyUuidFieldValue(entry.uuid, options) !== 'valid') {
                skip(
                  'IMPORT_VALUE_MISMATCH',
                  "An imported value does not match this field's UUID version and prefix."
                );
                continue;
              }
              if (seenTargets.has(target)) {
                skip('DUPLICATE_TARGET', 'An entry appears more than once in this file.');
                continue;
              }
              seenTargets.add(target);
              // Values are stored in canonical form (lowercase UUID part).
              const value = canonicalUuidValue(entry.uuid);
              const owner = seenValues.get(value);
              if (owner !== undefined && owner !== entry.documentId) {
                skip('DUPLICATE_VALUE', 'An imported UUID value is repeated in this file.');
                continue;
              }
              seenValues.set(value, entry.documentId);
              pending.push({ entry, value });
            }

            // Two batched lookups per chunk instead of three queries per entry.
            for (let start = 0; start < pending.length; start += IMPORT_LOOKUP_CHUNK) {
              const chunk = pending.slice(start, start + IMPORT_LOOKUP_CHUNK);
              let targetRows;
              let ownerRows;
              try {
                // Serialize with editors on other processes that claim the
                // same values (see lifecycles), then read the latest rows.
                if (!dryRun) {
                  await lockKeys(
                    strapi,
                    LOCK_SPACES.value,
                    chunk.map((i) => valueLockKey(uid, field, i.value))
                  );
                }
                targetRows = await query.findMany({
                  where: {
                    documentId: { $in: [...new Set(chunk.map((i) => i.entry.documentId))] },
                  },
                  select: ['id', 'documentId', field, ...(hasLocale ? ['locale'] : [])],
                });
                ownerRows = await readLatest(uid, {
                  where: { [field]: { $in: chunk.flatMap((i) => uuidValueSpellings(i.value)) } },
                  select: ['documentId', field],
                });
              } catch {
                throw new RepairWriteError(uid, field, 'import');
              }
              const rowsByDocument = new Map();
              for (const row of targetRows) {
                const list = rowsByDocument.get(row.documentId);
                if (list) list.push(row);
                else rowsByDocument.set(row.documentId, [row]);
              }
              const owners = new Map();
              const addOwner = (value, documentId) => {
                const set = owners.get(value);
                if (set) set.add(documentId);
                else owners.set(value, new Set([documentId]));
              };
              for (const row of ownerRows) addOwner(canonicalUuidValue(row[field]), row.documentId);

              for (const { entry, value } of chunk) {
                const rows = (rowsByDocument.get(entry.documentId) ?? []).filter(
                  (row) => !entry.locale || row.locale === entry.locale
                );
                if (rows.length === 0) {
                  skip(
                    'TARGET_NOT_FOUND',
                    'A target entry was not found. Its mapping was skipped.'
                  );
                  continue;
                }
                const current = rows.map((row) => row[field]).filter((v) => !isEmpty(v));
                const same = (v) => canonicalUuidValue(v) === value;
                if (current.length === rows.length && current.every(same)) {
                  result.unchanged += 1;
                  continue;
                }
                if (!current.every(same)) {
                  skip(
                    'TARGET_HAS_VALUE',
                    'A target entry already has a different UUID. Existing values are never replaced.'
                  );
                  continue;
                }
                if ([...(owners.get(value) ?? [])].some((id) => id !== entry.documentId)) {
                  skip('IMPORT_CONFLICT', 'The imported UUID is already used by another entry.');
                  continue;
                }

                if (!dryRun) {
                  const where = { documentId: entry.documentId };
                  if (entry.locale) where.locale = entry.locale;
                  let written;
                  try {
                    written = await query.updateMany({
                      where: { $and: [where, EMPTY_WHERE(field)] },
                      data: { [field]: value },
                    });
                  } catch {
                    throw new RepairWriteError(uid, field, 'import');
                  }
                  if (affectedRows(written) === 0) {
                    skip('CONCURRENT_CHANGE', CONCURRENT_MESSAGE);
                    continue;
                  }
                }
                result.changes.push({ uid, field, documentId: entry.documentId, newValue: value });
                for (const row of rows) if (isEmpty(row[field])) row[field] = value;
                addOwner(value, entry.documentId);
                result.imported += 1;
              }
            }
          }
        }
      };

      try {
        if (dryRun) {
          await execute();
        } else {
          await runExclusiveRepair('import', () =>
            withUuidRepairContext(() =>
              strapi.db.transaction(async () => {
                await assertClusterRepairLock(strapi);
                await execute();
              })
            )
          );
        }
      } catch (error) {
        if (error?.code === 'REPAIR_IN_PROGRESS') throw error;
        result.failed = true;
        result.rolledBack = !dryRun;
        result.imported = 0;
        result.skipped = 0;
        result.unchanged = 0;
        result.changes = [];
        collector.errors.length = 0;
        for (const key of Object.keys(collector.errorCounts)) delete collector.errorCounts[key];
        collector.add({
          uid: error?.uid,
          field: error?.field,
          code: 'IMPORT_FAILED',
          operation: error?.operation || 'batch',
          message: dryRun
            ? 'Import preview failed. No changes were made.'
            : 'Import failed. The transaction was rolled back; no changes were kept.',
        });
      }
      return result;
    },
  };
};

export default migrations;
