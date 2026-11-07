/**
 * Migration Support for strapi-auto-uuid
 *
 * Handles migration, data integrity checks, export/import of UUID mappings.
 * Uses paginated queries and transactions for safe bulk operations.
 */

import {
  isUuidFieldValue,
  resolveUuidFieldOptions,
} from '../../../shared/uuid-field.js';
import { withUuidRepairContext } from '../utils/repair-context.js';

const MAX_QUERY_LIMIT = 10000;

/**
 * Returns normalized field options from the active content-type schema.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} uid Content type UID.
 * @param {string} field UUID field name.
 * @returns {{ version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
 */
function getFieldOptions(strapi, uid, field) {
  const attribute = strapi.contentTypes[uid]?.attributes?.[field];
  const pluginConfig = strapi.config.get('plugin::field-uuid', {});
  return resolveUuidFieldOptions(attribute?.options || {}, pluginConfig.defaultVersion || 'v4');
}

/**
 * Maps a caught failure to a user-safe field message without exposing database
 * errors, record identifiers or stored UUID values.
 *
 * @param {Error} error Failure from configuration or persistence code.
 * @returns {string} Actionable message safe for an admin response.
 */
function safeFieldFailureMessage(error) {
  if (error?.code === 'INVALID_UUID_FIELD_CONFIG') {
    return 'UUID field configuration is invalid. Check its version and prefix.';
  }
  return 'Could not scan or update this UUID field. No unverified changes were applied.';
}

/** Carries safe field context when a batch must abort and roll back. */
class RepairWriteError extends Error {
  /**
   * @param {string} uid Content type UID.
   * @param {string} field UUID custom-field name.
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
 * Fetches all entries for a given UID/fields using safe pagination.
 * @param {Object} strapi
 * @param {string} uid
 * @param {string[]} fields
 * @param {Object} [filters]
 * @returns {Promise<Array>}
 */
async function fetchAllEntries(strapi, uid, fields, filters) {
  const allEntries = [];
  let start = 0;

  while (true) {
    const batch = await strapi.documents(uid).findMany({
      fields,
      filters,
      limit: MAX_QUERY_LIMIT,
      start,
    });

    allEntries.push(...batch);
    if (batch.length < MAX_QUERY_LIMIT) break;
    start += MAX_QUERY_LIMIT;
  }

  return allEntries;
}

const migrations = ({ strapi }) => ({
  /**
   * Checks every UUID field against its configured version and prefix. Scan
   * failures mark the overall report incomplete and block later repairs.
   * Record identifiers and values are omitted unless an internal repair asks
   * for them explicitly.
   *
   * @param {Object} [options] Internal report options.
   * @param {boolean} [options.includeRecordDetails=false] Include record values for internal migration logic only.
   * @returns {Promise<Object>} Counts, safe field messages and optional internal repair details.
   */
  async checkMigrationStatus({ includeRecordDetails = false } = {}) {
    const { contentTypes } = strapi;
    const report = {
      needsMigration: false,
      hasErrors: false,
      contentTypes: [],
      totalFields: 0,
      totalEntries: 0,
      issues: [],
    };

    for (const [uid, contentType] of Object.entries(contentTypes)) {
      if (!uid.startsWith('api::')) continue;

      const attributes = contentType.attributes;
      for (const [attrName, attr] of Object.entries(attributes)) {
        if (attr.customField !== 'plugin::field-uuid.uuid') continue;

        const fieldInfo = {
          uid,
          field: attrName,
          currentType: attr.type,
          issues: [],
        };

        try {
          const fieldOptions = getFieldOptions(strapi, uid, attrName);
          const entries = await fetchAllEntries(strapi, uid, ['documentId', attrName]);

          fieldInfo.entryCount = entries.length;
          report.totalEntries += entries.length;

          let emptyCount = 0;
          let invalidCount = 0;
          const duplicates = new Map();

          for (const entry of entries) {
            const uuidValue = entry[attrName];

            if (!uuidValue) {
              emptyCount++;
            } else if (!isUuidFieldValue(uuidValue, fieldOptions)) {
              invalidCount++;
              const issue = {
                type: 'invalid',
              };
              if (includeRecordDetails) {
                issue.documentId = entry.documentId;
                issue.value = uuidValue;
              }
              fieldInfo.issues.push(issue);
            }

            if (uuidValue) {
              if (!duplicates.has(uuidValue)) {
                duplicates.set(uuidValue, []);
              }
              duplicates.get(uuidValue).push(entry.documentId);
            }
          }

          let duplicateCount = 0;
          for (const [uuid, docIds] of duplicates) {
            if (docIds.length > 1) {
              duplicateCount += docIds.length - 1;
              const issue = {
                type: 'duplicate',
                count: docIds.length,
              };
              if (includeRecordDetails) {
                issue.uuid = uuid;
                issue.documentIds = docIds;
              }
              fieldInfo.issues.push(issue);
            }
          }

          fieldInfo.emptyCount = emptyCount;
          fieldInfo.invalidCount = invalidCount;
          fieldInfo.duplicateCount = duplicateCount;

          if (emptyCount > 0 || invalidCount > 0 || duplicateCount > 0) {
            report.needsMigration = true;
          }
        } catch (err) {
          fieldInfo.scanFailed = true;
          fieldInfo.error = safeFieldFailureMessage(err);
          report.hasErrors = true;
          report.needsMigration = true;
          report.issues.push({
            uid,
            field: attrName,
            operation: err?.code === 'INVALID_UUID_FIELD_CONFIG' ? 'configuration' : 'scan',
            message: fieldInfo.error,
          });
        }

        report.contentTypes.push(fieldInfo);
        report.totalFields++;
      }
    }

    return report;
  },

  /**
   * Runs a full repair only after every field has been scanned successfully.
   * Real writes use the internal repair context and one transaction. Any
   * failed write aborts the batch and returns a safe rollback result.
   *
   * @param {Object} [options] Repair options.
   * @param {boolean} [options.dryRun=true] Preview only unless explicitly disabled.
   * @param {boolean} [options.fixEmpty=true] Generate values for empty fields.
   * @param {boolean} [options.fixInvalid=true] Replace values that fail field validation.
   * @param {boolean} [options.fixDuplicates=true] Replace later entries in duplicate groups.
   * @returns {Promise<Object>} Result counts and errors; the admin controller redacts record-level details.
   */
  async runMigration({
    dryRun = true,
    fixEmpty = true,
    fixInvalid = true,
    fixDuplicates = true,
  } = {}) {
    const status = await this.checkMigrationStatus({ includeRecordDetails: true });
    const result = {
      dryRun,
      startedAt: new Date().toISOString(),
      fixed: { empty: 0, invalid: 0, duplicates: 0 },
      errors: [],
      changes: [],
    };

    if (status.hasErrors) {
      result.aborted = true;
      result.errors = status.issues;
      result.completedAt = new Date().toISOString();
      result.totalFixed = 0;
      return result;
    }

    const generateUniqueValue = async (uid, field, documentId) => {
      try {
        return await strapi.plugin('field-uuid').service('service')
          .generateUniqueFieldValue(uid, field, documentId);
      } catch {
        throw new RepairWriteError(uid, field, 'generate');
      }
    };

    const executeMigration = async () => {
      for (const ctInfo of status.contentTypes) {
        const { uid, field, issues } = ctInfo;
        const changedDocumentIds = new Set();

        if (fixEmpty && ctInfo.emptyCount > 0) {
          try {
            const emptyEntries = await fetchAllEntries(strapi, uid, ['documentId'], {
              $or: [
                { [field]: { $null: true } },
                { [field]: '' },
              ],
            });

            for (const entry of emptyEntries) {
              const newUuid = await generateUniqueValue(uid, field, entry.documentId);
              result.changes.push({
                type: 'empty_fix',
                uid,
                field,
                documentId: entry.documentId,
                oldValue: null,
                newValue: newUuid,
              });
              changedDocumentIds.add(entry.documentId);

              if (!dryRun) {
                await withUuidRepairContext(() => strapi.documents(uid).update({
                  documentId: entry.documentId,
                  data: { [field]: newUuid },
                }));
              }
              result.fixed.empty++;
            }
          } catch {
            throw new RepairWriteError(uid, field, 'repair');
          }
        }

        if (fixInvalid) {
          const invalidIssues = issues.filter((i) => i.type === 'invalid');
          for (const issue of invalidIssues) {
            const newUuid = await generateUniqueValue(uid, field, issue.documentId);
            result.changes.push({
              type: 'invalid_fix',
              uid,
              field,
              documentId: issue.documentId,
              oldValue: issue.value,
              newValue: newUuid,
            });
            changedDocumentIds.add(issue.documentId);

            if (!dryRun) {
              try {
                await withUuidRepairContext(() => strapi.documents(uid).update({
                  documentId: issue.documentId,
                  data: { [field]: newUuid },
                }));
              } catch {
                throw new RepairWriteError(uid, field, 'write');
              }
            }
            result.fixed.invalid++;
          }
        }

        if (fixDuplicates) {
          const duplicateIssues = issues.filter((i) => i.type === 'duplicate');
          for (const issue of duplicateIssues) {
            const [, ...fixDocIds] = issue.documentIds;

            for (const docId of fixDocIds) {
              if (changedDocumentIds.has(docId)) continue;
              const newUuid = await generateUniqueValue(uid, field, docId);
              result.changes.push({
                type: 'duplicate_fix',
                uid,
                field,
                documentId: docId,
                oldValue: issue.uuid,
                newValue: newUuid,
                keptDocumentId: issue.documentIds[0],
              });
              changedDocumentIds.add(docId);

              if (!dryRun) {
                try {
                  await withUuidRepairContext(() => strapi.documents(uid).update({
                    documentId: docId,
                    data: { [field]: newUuid },
                  }));
                } catch {
                  throw new RepairWriteError(uid, field, 'write');
                }
              }
              result.fixed.duplicates++;
            }
          }
        }
      }
    };

    try {
      if (dryRun) {
        await executeMigration();
      } else {
        await withUuidRepairContext(() => strapi.db.transaction(executeMigration));
      }
    } catch (error) {
      result.failed = true;
      result.rolledBack = !dryRun;
      result.errors = [{
        uid: error?.uid,
        field: error?.field,
        operation: error?.operation || 'batch',
        message: dryRun
          ? 'Repair preview failed. No changes were made.'
          : 'Repair failed. The transaction was rolled back; no changes were kept.',
      }];
      result.changes = [];
      result.fixed = { empty: 0, invalid: 0, duplicates: 0 };
      result.totalFixed = 0;
      result.completedAt = new Date().toISOString();
      return result;
    }

    result.completedAt = new Date().toISOString();
    result.totalFixed = result.fixed.empty + result.fixed.invalid + result.fixed.duplicates;

    if (!dryRun && result.totalFixed > 0) {
      strapi.log.info(`[strapi-auto-uuid] Migration completed: ${result.totalFixed} entries fixed`);
    }

    return result;
  },

  /**
   * Exports UUID mappings for backup.
   * @returns {Promise<Object>}
   */
  async exportMappings() {
    const { contentTypes } = strapi;
    const exportData = {
      exportedAt: new Date().toISOString(),
      version: '1.1.0',
      mappings: {},
    };

    for (const [uid, contentType] of Object.entries(contentTypes)) {
      if (!uid.startsWith('api::')) continue;

      const attributes = contentType.attributes;
      for (const [attrName, attr] of Object.entries(attributes)) {
        if (attr.customField !== 'plugin::field-uuid.uuid') continue;

        const entries = await fetchAllEntries(strapi, uid, ['documentId', attrName]);

        if (!exportData.mappings[uid]) {
          exportData.mappings[uid] = { fields: {} };
        }

        exportData.mappings[uid].fields[attrName] = entries.map((e) => ({
          documentId: e.documentId,
          uuid: e[attrName],
        }));
      }
    }

    return exportData;
  },

  /**
   * Imports UUID mappings with validation.
   * Only allows writing to api:: content types with actual UUID fields.
   * Imported values must match the destination field's UUID version and
   * prefix, and must not collide with another document.
   *
   * @param {Object} importData Export-shaped mapping data.
   * @param {Object} [options] Import options.
   * @param {boolean} [options.dryRun=true] Preview only unless explicitly disabled.
   * @param {boolean} [options.overwrite=false] Replace existing non-empty values.
   * @returns {Promise<Object>} Counts and safe validation/write errors.
   */
  async importMappings(importData, { dryRun = true, overwrite = false } = {}) {
    const result = {
      dryRun,
      imported: 0,
      skipped: 0,
      errors: [],
      changes: [],
    };

    if (!importData?.mappings) {
      result.errors.push({
        operation: 'validation',
        message: 'Invalid import data. A mappings object is required.',
      });
      return result;
    }

    const serviceInstance = strapi.plugin('field-uuid').service('service');
    const seenValues = new Set();

    const executeImport = async () => {
      for (const [uid, ctData] of Object.entries(importData.mappings)) {
        for (const [field, entries] of Object.entries(ctData.fields)) {
          const validation = serviceInstance.validateUuidField(uid, field);
          if (!validation.valid) {
            result.errors.push({
              uid,
              field,
              operation: 'validation',
              message: 'The target UUID field is missing or has invalid configuration.',
            });
            result.skipped += entries.length;
            continue;
          }
          const fieldOptions = serviceInstance.getFieldOptions(uid, field);

          for (const entry of entries) {
            if (!entry.documentId || !entry.uuid) {
              result.skipped++;
              continue;
            }

            if (!isUuidFieldValue(entry.uuid, fieldOptions)) {
              result.skipped++;
              result.errors.push({
                uid,
                field,
                operation: 'validation',
                message: "An imported value does not match this field's UUID version and prefix.",
              });
              continue;
            }

            const identity = `${uid}\u0000${field}\u0000${entry.uuid}`;
            if (seenValues.has(identity)) {
              result.skipped++;
              result.errors.push({
                uid,
                field,
                operation: 'uniqueness',
                message: 'An imported UUID value is repeated in this file.',
              });
              continue;
            }
            seenValues.add(identity);

            try {
              const existing = await strapi.documents(uid).findFirst({
                filters: { documentId: entry.documentId },
                fields: ['documentId', field],
              });

              if (!existing) {
                result.skipped++;
                result.errors.push({
                  uid,
                  field,
                  operation: 'lookup',
                  message: 'A target entry was not found. Its mapping was skipped.',
                });
                continue;
              }

              if (existing[field] && !overwrite) {
                result.skipped++;
                continue;
              }

              const duplicate = await serviceInstance.checkDuplicate({
                contentType: uid,
                field,
                uuid: entry.uuid,
                excludeDocumentId: entry.documentId,
              });
              if (!duplicate.valid || duplicate.exists) {
                result.skipped++;
                result.errors.push({
                  uid,
                  field,
                  operation: 'uniqueness',
                  message: 'The imported UUID conflicts with another entry or field configuration.',
                });
                continue;
              }

              result.changes.push({
                uid,
                field,
                documentId: entry.documentId,
                oldValue: existing[field],
                newValue: entry.uuid,
              });

              if (!dryRun) {
                await withUuidRepairContext(() => strapi.documents(uid).update({
                  documentId: entry.documentId,
                  data: { [field]: entry.uuid },
                }));
              }
              result.imported++;
            } catch {
              throw new RepairWriteError(uid, field, 'import');
            }
          }
        }
      }
    };

    try {
      if (dryRun) {
        await executeImport();
      } else {
        await withUuidRepairContext(() => strapi.db.transaction(executeImport));
      }
    } catch (error) {
      result.failed = true;
      result.rolledBack = !dryRun;
      result.imported = 0;
      result.skipped = 0;
      result.changes = [];
      result.errors = [{
        uid: error?.uid,
        field: error?.field,
        operation: error?.operation || 'batch',
        message: dryRun
          ? 'Import preview failed. No changes were made.'
          : 'Import failed. The transaction was rolled back; no changes were kept.',
      }];
    }

    return result;
  },
});

export default migrations;
