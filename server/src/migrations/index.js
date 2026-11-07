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
 * process-wide lock. The plan is computed inside that transaction, so values
 * an editor changed after the preview are never overwritten with a stale plan.
 */

import { classifyUuidFieldValue } from '../../../shared/uuid-field.js';
import { getPluginConfig } from '../config/index.js';
import { withUuidRepairContext } from '../utils/repair-context.js';
import { runExclusiveRepair } from '../utils/repair-lock.js';
import {
  fetchFieldRows,
  getUuidModels,
  groupDuplicates,
  resolveFieldOptions,
} from '../utils/uuid-models.js';

export const EXPORT_FORMAT = 2;
export const MAX_REPORTED_ERRORS = 20;

const isEmpty = (value) => value === null || value === undefined || value === '';
const EMPTY_WHERE = (field) => ({ $or: [{ [field]: { $null: true } }, { [field]: '' }] });

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
 * @param {Array<Record<string, unknown>>} rows Rows from fetchFieldRows.
 * @param {string} field UUID field name.
 * @param {{ version: string, prefix: string, disableAutoGenerate: boolean }} options Field options.
 * @returns {Object} Counts and the per-document data needed to plan a repair.
 */
export function analyseFieldRows(rows, field, options) {
  const documents = new Map();
  for (const row of rows) {
    let doc = documents.get(row.documentId);
    if (!doc) {
      doc = { firstId: row.id, values: new Set(), hasEmpty: false };
      documents.set(row.documentId, doc);
    }
    if (isEmpty(row[field])) doc.hasEmpty = true;
    else doc.values.add(row[field]);
  }

  const malformed = [];
  const legacy = [];
  const emptyDocuments = [];
  for (const [documentId, doc] of documents) {
    if (doc.hasEmpty) emptyDocuments.push(documentId);
    for (const value of doc.values) {
      const kind = classifyUuidFieldValue(value, options);
      if (kind === 'malformed') malformed.push({ documentId, value });
      if (kind === 'legacy') legacy.push({ documentId, value });
    }
  }

  const duplicates = groupDuplicates(rows, field);
  const manual = options.disableAutoGenerate;

  return {
    documents,
    entryCount: documents.size,
    emptyCount: manual ? 0 : emptyDocuments.length,
    manualEmptyCount: manual ? emptyDocuments.length : 0,
    invalidCount: malformed.length,
    legacyCount: legacy.length,
    duplicateCount: duplicates.reduce((sum, group) => sum + group.count - 1, 0),
    duplicateGroups: duplicates.length,
    emptyDocuments: manual ? [] : emptyDocuments,
    malformed,
    legacy,
    duplicates,
  };
}

const migrations = ({ strapi }) => {
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
          fields.push({ uid, field, options, analysis: analyseFieldRows(rows, field, options) });
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
      const replacements = new Map();
      const query = strapi.db.query(uid);

      const replace = async (type, documentId, oldValue, newValue, extra = {}) => {
        result.changes.push({ type, uid, field, documentId, oldValue, newValue, ...extra });
        if (!write) return;
        try {
          await query.updateMany({
            where: isEmpty(oldValue)
              ? { $and: [{ documentId }, EMPTY_WHERE(field)] }
              : { documentId, [field]: oldValue },
            data: { [field]: newValue },
          });
        } catch {
          throw new RepairWriteError(uid, field, 'write');
        }
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

      const replaceList = async (list, type, category) => {
        for (const { documentId, value } of list) {
          const key = `${documentId}\u0000${value}`;
          if (handled.has(key)) continue;
          handled.add(key);
          const next = await fresh();
          replacements.set(key, next);
          await replace(type, documentId, value, next);
          result.fixed[category] += 1;
        }
      };

      if (flags.fixInvalid) await replaceList(analysis.malformed, 'invalid_fix', 'invalid');
      if (flags.fixLegacy) await replaceList(analysis.legacy, 'legacy_fix', 'legacy');

      if (flags.fixDuplicates) {
        for (const group of analysis.duplicates) {
          const [kept, ...others] = group.documentIds;
          for (const documentId of others) {
            const key = `${documentId}\u0000${group.uuid}`;
            if (handled.has(key)) continue;
            handled.add(key);
            const next = await fresh();
            replacements.set(key, next);
            await replace('duplicate_fix', documentId, group.uuid, next, {
              keptDocumentId: kept,
            });
            result.fixed.duplicates += 1;
          }
        }
      }

      if (flags.fixEmpty) {
        for (const documentId of analysis.emptyDocuments) {
          // Reuse the document's own value (for example a draft that has a
          // value while the published row predates the field) when it has
          // exactly one, taking a replacement made above into account.
          const own = [...analysis.documents.get(documentId).values].map(
            (value) => replacements.get(`${documentId}\u0000${value}`) ?? value
          );
          const reusable =
            own.length === 1 && classifyUuidFieldValue(own[0], options) !== 'malformed'
              ? own[0]
              : null;
          await replace('empty_fix', documentId, null, reusable ?? (await fresh()));
          result.fixed.empty += 1;
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

      for (const { uid, field, analysis } of fields) {
        const { entryCount, emptyCount, manualEmptyCount, invalidCount, legacyCount } = analysis;
        const { duplicateCount, duplicateGroups } = analysis;
        report.totalEntries += entryCount;
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
            withUuidRepairContext(() => strapi.db.transaction(execute))
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
            const seenValues = new Map();
            const seenTargets = new Set();
            const query = strapi.db.query(uid);

            for (const entry of entries) {
              const skip = (code, message) => {
                result.skipped += 1;
                if (code) collector.add({ uid, field, code, message });
              };
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
              const owner = seenValues.get(entry.uuid);
              if (owner !== undefined && owner !== entry.documentId) {
                skip('DUPLICATE_VALUE', 'An imported UUID value is repeated in this file.');
                continue;
              }
              seenValues.set(entry.uuid, entry.documentId);

              try {
                const where = { documentId: entry.documentId };
                if (entry.locale) where.locale = entry.locale;
                const rows = await query.findMany({ where, select: ['id', field] });
                if (rows.length === 0) {
                  skip(
                    'TARGET_NOT_FOUND',
                    'A target entry was not found. Its mapping was skipped.'
                  );
                  continue;
                }
                const current = rows.map((row) => row[field]).filter((value) => !isEmpty(value));
                if (current.length === rows.length && current.every((v) => v === entry.uuid)) {
                  result.unchanged += 1;
                  continue;
                }
                if (current.some((value) => value !== entry.uuid)) {
                  skip(
                    'TARGET_HAS_VALUE',
                    'A target entry already has a different UUID. Existing values are never replaced.'
                  );
                  continue;
                }
                const conflict = await query.findOne({
                  where: { [field]: entry.uuid, documentId: { $ne: entry.documentId } },
                  select: ['id'],
                });
                if (conflict) {
                  skip('IMPORT_CONFLICT', 'The imported UUID is already used by another entry.');
                  continue;
                }

                result.changes.push({
                  uid,
                  field,
                  documentId: entry.documentId,
                  newValue: entry.uuid,
                });
                if (!dryRun) {
                  await query.updateMany({
                    where: { $and: [where, EMPTY_WHERE(field)] },
                    data: { [field]: entry.uuid },
                  });
                }
                result.imported += 1;
              } catch {
                throw new RepairWriteError(uid, field, 'import');
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
            withUuidRepairContext(() => strapi.db.transaction(execute))
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
