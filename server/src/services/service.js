'use strict';

import { v4 as uuidv4, validate as validateUuid } from 'uuid';

/**
 * UUID Plugin Service
 * 
 * Provides utility methods for UUID generation, validation, duplicate checking,
 * and auto-fix functionality for duplicate UUIDs.
 * Uses Document Service API (strapi.documents) as per Strapi v5 best practices.
 */
const service = ({ strapi }) => ({
  /**
   * Generates a new UUID v4
   * @returns {string} A new UUID v4
   */
  generate() {
    return uuidv4();
  },
  
  /**
   * Validates if a string is a valid UUID
   * @param {string} uuid - The string to validate
   * @returns {boolean} True if valid UUID
   */
  validate(uuid) {
    return validateUuid(uuid);
  },
  
  /**
   * Generates a UUID if the value is empty or invalid
   * @param {string} value - Current value
   * @returns {string} Valid UUID
   */
  ensureUuid(value) {
    if (!value || !validateUuid(value)) {
      return uuidv4();
    }
    return value;
  },

  /**
   * Checks if a UUID already exists in a content type
   * @param {Object} params - Check parameters
   * @param {string} params.contentType - Content type UID (e.g., 'api::article.article')
   * @param {string} params.field - Field name containing the UUID
   * @param {string} params.uuid - UUID value to check
   * @param {string} [params.excludeDocumentId] - Optional documentId to exclude from check (for updates)
   * @returns {Promise<{exists: boolean, valid: boolean}>} Check result
   */
  async checkDuplicate({ contentType, field, uuid, excludeDocumentId }) {
    const isValid = validateUuid(uuid);
    
    if (!isValid) {
      return { exists: false, valid: false };
    }

    const filters = { [field]: uuid };
    
    if (excludeDocumentId) {
      filters.documentId = { $ne: excludeDocumentId };
    }

    const existing = await strapi.documents(contentType).findFirst({
      filters,
      fields: ['documentId'],
    });

    return { exists: !!existing, valid: true };
  },

  /**
   * Finds all content types that use the UUID custom field
   * @returns {Object} Map of content type UIDs to their UUID field names
   */
  getUuidModels() {
    const { contentTypes } = strapi;
    
    return Object.keys(contentTypes).reduce((acc, key) => {
      const contentType = contentTypes[key];
      
      if (!key.startsWith('api')) return acc;
      
      const uuidAttributes = Object.keys(contentType.attributes).filter((attrKey) => {
        const attribute = contentType.attributes[attrKey];
        return attribute.customField === 'plugin::field-uuid.uuid';
      });
      
      if (uuidAttributes.length > 0) {
        return { ...acc, [key]: uuidAttributes };
      }
      
      return acc;
    }, {});
  },

  /**
   * Diagnoses all UUID fields for duplicates across all content types
   * @returns {Promise<Object>} Diagnosis report with duplicates per content type
   */
  async diagnose() {
    const models = this.getUuidModels();
    const report = {
      scannedModels: 0,
      totalDuplicates: 0,
      details: {},
    };

    for (const [uid, fields] of Object.entries(models)) {
      report.scannedModels++;
      report.details[uid] = { fields: {} };

      for (const field of fields) {
        const duplicates = await this.findDuplicatesForField(uid, field);
        report.details[uid].fields[field] = {
          duplicateGroups: duplicates.length,
          affectedEntries: duplicates.reduce((sum, group) => sum + group.count, 0),
          duplicates,
        };
        report.totalDuplicates += duplicates.reduce((sum, group) => sum + group.count - 1, 0);
      }
    }

    return report;
  },

  /**
   * Finds duplicate UUIDs for a specific content type and field
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @returns {Promise<Array>} Array of duplicate groups with their documentIds
   */
  async findDuplicatesForField(uid, field) {
    // Get all entries with their UUID values
    const entries = await strapi.documents(uid).findMany({
      fields: ['documentId', field],
      limit: -1, // Get all entries
    });

    // Group by UUID value
    const uuidGroups = {};
    for (const entry of entries) {
      const uuidValue = entry[field];
      if (!uuidValue) continue;
      
      if (!uuidGroups[uuidValue]) {
        uuidGroups[uuidValue] = [];
      }
      uuidGroups[uuidValue].push(entry.documentId);
    }

    // Filter to only duplicates (more than 1 entry with same UUID)
    const duplicates = [];
    for (const [uuid, documentIds] of Object.entries(uuidGroups)) {
      if (documentIds.length > 1) {
        duplicates.push({
          uuid,
          count: documentIds.length,
          documentIds,
        });
      }
    }

    return duplicates;
  },

  /**
   * Auto-fixes all duplicate UUIDs by generating new unique UUIDs
   * Keeps the first occurrence, replaces all others
   * @param {Object} options - Fix options
   * @param {boolean} [options.dryRun=false] - If true, only reports what would be changed
   * @returns {Promise<Object>} Fix report with changes made
   */
  async autofix({ dryRun = false } = {}) {
    const models = this.getUuidModels();
    const report = {
      dryRun,
      fixedModels: 0,
      totalFixed: 0,
      details: {},
    };

    for (const [uid, fields] of Object.entries(models)) {
      report.details[uid] = { fields: {} };
      let modelFixed = false;

      for (const field of fields) {
        const fixes = await this.fixDuplicatesForField(uid, field, dryRun);
        report.details[uid].fields[field] = fixes;
        
        if (fixes.fixed > 0) {
          modelFixed = true;
          report.totalFixed += fixes.fixed;
        }
      }

      if (modelFixed) {
        report.fixedModels++;
      }
    }

    return report;
  },

  /**
   * Fixes duplicate UUIDs for a specific content type and field
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @param {boolean} dryRun - If true, only reports what would be changed
   * @returns {Promise<Object>} Fix details
   */
  async fixDuplicatesForField(uid, field, dryRun) {
    const duplicates = await this.findDuplicatesForField(uid, field);
    const fixes = {
      found: duplicates.length,
      fixed: 0,
      changes: [],
    };

    for (const group of duplicates) {
      // Keep the first documentId, fix the rest
      const [keepDocumentId, ...duplicateDocumentIds] = group.documentIds;

      for (const documentId of duplicateDocumentIds) {
        const newUuid = uuidv4();
        
        fixes.changes.push({
          documentId,
          oldUuid: group.uuid,
          newUuid,
          kept: keepDocumentId,
        });

        if (!dryRun) {
          await strapi.documents(uid).update({
            documentId,
            data: { [field]: newUuid },
          });
          strapi.log.info(`[strapi-auto-uuid] Fixed duplicate UUID in ${uid}: ${documentId} -> ${newUuid}`);
        }

        fixes.fixed++;
      }
    }

    return fixes;
  },

  /**
   * Generates missing UUIDs for entries that have empty UUID fields
   * @param {Object} options - Options
   * @param {boolean} [options.dryRun=false] - If true, only reports what would be changed
   * @returns {Promise<Object>} Report of generated UUIDs
   */
  async generateMissing({ dryRun = false } = {}) {
    const models = this.getUuidModels();
    const report = {
      dryRun,
      totalGenerated: 0,
      details: {},
    };

    for (const [uid, fields] of Object.entries(models)) {
      report.details[uid] = { fields: {} };

      for (const field of fields) {
        // Find entries with empty or invalid UUID
        const entries = await strapi.documents(uid).findMany({
          filters: {
            $or: [
              { [field]: { $null: true } },
              { [field]: '' },
            ],
          },
          fields: ['documentId', field],
          limit: -1,
        });

        const generated = [];
        for (const entry of entries) {
          const newUuid = uuidv4();
          generated.push({
            documentId: entry.documentId,
            newUuid,
          });

          if (!dryRun) {
            await strapi.documents(uid).update({
              documentId: entry.documentId,
              data: { [field]: newUuid },
            });
            strapi.log.info(`[strapi-auto-uuid] Generated missing UUID for ${uid}: ${entry.documentId} -> ${newUuid}`);
          }
        }

        report.details[uid].fields[field] = {
          found: entries.length,
          generated: generated.length,
          changes: generated,
        };
        report.totalGenerated += generated.length;
      }
    }

    return report;
  },
});

export default service;
