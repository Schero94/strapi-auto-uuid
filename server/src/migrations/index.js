/**
 * Migration Support for strapi-auto-uuid
 *
 * Handles migration, data integrity checks, export/import of UUID mappings.
 * Uses paginated queries and transactions for safe bulk operations.
 */

import { v4 as uuidv4, validate as validateUuid } from 'uuid';

const MAX_QUERY_LIMIT = 10000;

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
   * Checks migration status across all UUID fields.
   * @returns {Promise<Object>}
   */
  async checkMigrationStatus() {
    const { contentTypes } = strapi;
    const report = {
      needsMigration: false,
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
            } else if (!validateUuid(uuidValue)) {
              invalidCount++;
              fieldInfo.issues.push({
                type: 'invalid',
                documentId: entry.documentId,
                value: uuidValue,
              });
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
              fieldInfo.issues.push({
                type: 'duplicate',
                uuid,
                count: docIds.length,
                documentIds: docIds,
              });
            }
          }

          fieldInfo.emptyCount = emptyCount;
          fieldInfo.invalidCount = invalidCount;
          fieldInfo.duplicateCount = duplicateCount;

          if (emptyCount > 0 || invalidCount > 0 || duplicateCount > 0) {
            report.needsMigration = true;
          }
        } catch (err) {
          fieldInfo.error = err.message;
          report.issues.push(`Failed to check ${uid}.${attrName}: ${err.message}`);
        }

        report.contentTypes.push(fieldInfo);
        report.totalFields++;
      }
    }

    return report;
  },

  /**
   * Runs full migration to fix all UUID issues.
   * Wrapped in a database transaction for atomicity.
   * @param {Object} options
   * @param {boolean} [options.dryRun=true]
   * @param {boolean} [options.fixEmpty=true]
   * @param {boolean} [options.fixInvalid=true]
   * @param {boolean} [options.fixDuplicates=true]
   * @returns {Promise<Object>}
   */
  async runMigration({
    dryRun = true,
    fixEmpty = true,
    fixInvalid = true,
    fixDuplicates = true,
  } = {}) {
    const status = await this.checkMigrationStatus();
    const result = {
      dryRun,
      startedAt: new Date().toISOString(),
      fixed: { empty: 0, invalid: 0, duplicates: 0 },
      errors: [],
      changes: [],
    };

    const executeMigration = async () => {
      for (const ctInfo of status.contentTypes) {
        const { uid, field, issues } = ctInfo;

        if (fixEmpty && ctInfo.emptyCount > 0) {
          try {
            const emptyEntries = await fetchAllEntries(strapi, uid, ['documentId'], {
              $or: [
                { [field]: { $null: true } },
                { [field]: '' },
              ],
            });

            for (const entry of emptyEntries) {
              const newUuid = uuidv4();
              result.changes.push({
                type: 'empty_fix',
                uid,
                field,
                documentId: entry.documentId,
                oldValue: null,
                newValue: newUuid,
              });

              if (!dryRun) {
                await strapi.documents(uid).update({
                  documentId: entry.documentId,
                  data: { [field]: newUuid },
                });
              }
              result.fixed.empty++;
            }
          } catch (err) {
            result.errors.push(`Failed to fix empty UUIDs in ${uid}.${field}: ${err.message}`);
          }
        }

        if (fixInvalid) {
          const invalidIssues = issues.filter((i) => i.type === 'invalid');
          for (const issue of invalidIssues) {
            const newUuid = uuidv4();
            result.changes.push({
              type: 'invalid_fix',
              uid,
              field,
              documentId: issue.documentId,
              oldValue: issue.value,
              newValue: newUuid,
            });

            if (!dryRun) {
              try {
                await strapi.documents(uid).update({
                  documentId: issue.documentId,
                  data: { [field]: newUuid },
                });
              } catch (err) {
                result.errors.push(`Failed to fix invalid UUID in ${uid}.${field} (${issue.documentId}): ${err.message}`);
                continue;
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
              const newUuid = uuidv4();
              result.changes.push({
                type: 'duplicate_fix',
                uid,
                field,
                documentId: docId,
                oldValue: issue.uuid,
                newValue: newUuid,
                keptDocumentId: issue.documentIds[0],
              });

              if (!dryRun) {
                try {
                  await strapi.documents(uid).update({
                    documentId: docId,
                    data: { [field]: newUuid },
                  });
                } catch (err) {
                  result.errors.push(`Failed to fix duplicate UUID in ${uid}.${field} (${docId}): ${err.message}`);
                  continue;
                }
              }
              result.fixed.duplicates++;
            }
          }
        }
      }
    };

    if (dryRun) {
      await executeMigration();
    } else {
      await strapi.db.transaction(async () => {
        await executeMigration();
      });
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
   * Validates that imported values are valid UUIDs.
   * @param {Object} importData
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=true]
   * @param {boolean} [options.overwrite=false]
   * @returns {Promise<Object>}
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
      result.errors.push('Invalid import data: missing mappings');
      return result;
    }

    const serviceInstance = strapi.plugin('field-uuid').service('service');

    const executeImport = async () => {
      for (const [uid, ctData] of Object.entries(importData.mappings)) {
        for (const [field, entries] of Object.entries(ctData.fields)) {
          const validation = serviceInstance.validateUuidField(uid, field);
          if (!validation.valid) {
            result.errors.push(`Skipping ${uid}.${field}: ${validation.error}`);
            result.skipped += entries.length;
            continue;
          }

          for (const entry of entries) {
            if (!entry.documentId || !entry.uuid) {
              result.skipped++;
              continue;
            }

            if (!validateUuid(entry.uuid)) {
              result.skipped++;
              result.errors.push(`Invalid UUID format for ${uid} ${entry.documentId}: '${entry.uuid}'`);
              continue;
            }

            try {
              const existing = await strapi.documents(uid).findFirst({
                filters: { documentId: entry.documentId },
                fields: ['documentId', field],
              });

              if (!existing) {
                result.skipped++;
                result.errors.push(`Entry not found: ${uid} ${entry.documentId}`);
                continue;
              }

              if (existing[field] && !overwrite) {
                result.skipped++;
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
                await strapi.documents(uid).update({
                  documentId: entry.documentId,
                  data: { [field]: entry.uuid },
                });
              }
              result.imported++;
            } catch (err) {
              result.errors.push(`Failed to import ${uid}.${entry.documentId}: ${err.message}`);
            }
          }
        }
      }
    };

    if (dryRun) {
      await executeImport();
    } else {
      await strapi.db.transaction(async () => {
        await executeImport();
      });
    }

    return result;
  },
});

export default migrations;
