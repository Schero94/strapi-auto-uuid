'use strict';

/**
 * Migration Support for strapi-auto-uuid
 * 
 * Handles migration from v4 plugin (uid type) to v5 plugin (string type).
 * Also handles migration of existing data when upgrading versions.
 * 
 * Key considerations:
 * - The underlying database column is a VARCHAR/TEXT in both cases
 * - UUIDs themselves are stored as strings and should not be affected
 * - The change from 'uid' to 'string' type is a Strapi metadata change
 */

import { v4 as uuidv4, validate as validateUuid } from 'uuid';

/**
 * Migration service for UUID plugin
 */
const migrations = ({ strapi }) => ({
  /**
   * Check if migration from v4 is needed
   * This checks for content types that might have UUID fields from the old plugin
   * @returns {Promise<Object>} Migration status report
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
        // Check for our custom field
        if (attr.customField === 'plugin::field-uuid.uuid') {
          const fieldInfo = {
            uid,
            field: attrName,
            currentType: attr.type,
            issues: [],
          };

          // Count entries
          try {
            const entries = await strapi.documents(uid).findMany({
              fields: ['documentId', attrName],
              limit: -1,
            });

            fieldInfo.entryCount = entries.length;
            report.totalEntries += entries.length;

            // Check for issues
            let emptyCount = 0;
            let invalidCount = 0;
            let duplicates = new Map();

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

              // Track duplicates
              if (uuidValue) {
                if (!duplicates.has(uuidValue)) {
                  duplicates.set(uuidValue, []);
                }
                duplicates.get(uuidValue).push(entry.documentId);
              }
            }

            // Count actual duplicates (more than 1 entry with same UUID)
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
    }

    return report;
  },

  /**
   * Run full migration to fix all issues
   * @param {Object} options - Migration options
   * @param {boolean} options.dryRun - If true, only reports what would be changed
   * @param {boolean} options.fixEmpty - Fix entries with empty UUIDs
   * @param {boolean} options.fixInvalid - Fix entries with invalid UUIDs
   * @param {boolean} options.fixDuplicates - Fix duplicate UUIDs
   * @returns {Promise<Object>} Migration result report
   */
  async runMigration({ 
    dryRun = true, 
    fixEmpty = true, 
    fixInvalid = true, 
    fixDuplicates = true 
  } = {}) {
    const status = await this.checkMigrationStatus();
    const result = {
      dryRun,
      startedAt: new Date().toISOString(),
      fixed: {
        empty: 0,
        invalid: 0,
        duplicates: 0,
      },
      errors: [],
      changes: [],
    };

    for (const ctInfo of status.contentTypes) {
      const { uid, field, issues } = ctInfo;

      // Fix empty UUIDs
      if (fixEmpty && ctInfo.emptyCount > 0) {
        try {
          const emptyEntries = await strapi.documents(uid).findMany({
            filters: {
              $or: [
                { [field]: { $null: true } },
                { [field]: '' },
              ],
            },
            fields: ['documentId'],
            limit: -1,
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

      // Fix invalid UUIDs
      if (fixInvalid) {
        const invalidIssues = issues.filter(i => i.type === 'invalid');
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
              result.fixed.invalid++;
            } catch (err) {
              result.errors.push(`Failed to fix invalid UUID in ${uid}.${field} (${issue.documentId}): ${err.message}`);
            }
          } else {
            result.fixed.invalid++;
          }
        }
      }

      // Fix duplicates
      if (fixDuplicates) {
        const duplicateIssues = issues.filter(i => i.type === 'duplicate');
        for (const issue of duplicateIssues) {
          // Keep the first one, fix the rest
          const [keepDocId, ...fixDocIds] = issue.documentIds;
          
          for (const docId of fixDocIds) {
            const newUuid = uuidv4();
            result.changes.push({
              type: 'duplicate_fix',
              uid,
              field,
              documentId: docId,
              oldValue: issue.uuid,
              newValue: newUuid,
              keptDocumentId: keepDocId,
            });

            if (!dryRun) {
              try {
                await strapi.documents(uid).update({
                  documentId: docId,
                  data: { [field]: newUuid },
                });
                result.fixed.duplicates++;
              } catch (err) {
                result.errors.push(`Failed to fix duplicate UUID in ${uid}.${field} (${docId}): ${err.message}`);
              }
            } else {
              result.fixed.duplicates++;
            }
          }
        }
      }
    }

    result.completedAt = new Date().toISOString();
    result.totalFixed = result.fixed.empty + result.fixed.invalid + result.fixed.duplicates;

    if (!dryRun && result.totalFixed > 0) {
      strapi.log.info(`[strapi-auto-uuid] Migration completed: ${result.totalFixed} entries fixed`);
    }

    return result;
  },

  /**
   * Export UUID mappings for backup or migration to another system
   * @returns {Promise<Object>} Export data with all UUID mappings
   */
  async exportMappings() {
    const { contentTypes } = strapi;
    const exportData = {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      mappings: {},
    };

    for (const [uid, contentType] of Object.entries(contentTypes)) {
      if (!uid.startsWith('api::')) continue;

      const attributes = contentType.attributes;
      for (const [attrName, attr] of Object.entries(attributes)) {
        if (attr.customField === 'plugin::field-uuid.uuid') {
          const entries = await strapi.documents(uid).findMany({
            fields: ['documentId', attrName],
            limit: -1,
          });

          if (!exportData.mappings[uid]) {
            exportData.mappings[uid] = { fields: {} };
          }

          exportData.mappings[uid].fields[attrName] = entries.map(e => ({
            documentId: e.documentId,
            uuid: e[attrName],
          }));
        }
      }
    }

    return exportData;
  },

  /**
   * Import UUID mappings (e.g., to restore after migration)
   * @param {Object} importData - Previously exported mapping data
   * @param {Object} options - Import options
   * @param {boolean} options.dryRun - If true, only validates without importing
   * @param {boolean} options.overwrite - If true, overwrites existing UUIDs
   * @returns {Promise<Object>} Import result
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

    for (const [uid, ctData] of Object.entries(importData.mappings)) {
      for (const [field, entries] of Object.entries(ctData.fields)) {
        for (const entry of entries) {
          if (!entry.documentId || !entry.uuid) {
            result.skipped++;
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

    return result;
  },
});

export default migrations;
