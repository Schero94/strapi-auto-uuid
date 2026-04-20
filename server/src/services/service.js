import * as uuidLib from 'uuid';

const { v4: uuidv4, validate: validateUuid } = uuidLib;
const uuidv7 = uuidLib.v7 || uuidv4;

const MAX_QUERY_LIMIT = 10000;

/**
 * UUID Plugin Service
 *
 * Provides utility methods for UUID generation, validation, duplicate checking,
 * and auto-fix functionality. Uses Document Service API and respects plugin config.
 */
const service = ({ strapi }) => ({
  /**
   * Generates a UUID respecting the plugin's configured default version.
   * @param {string} [version] - Override version ('v4' or 'v7')
   * @returns {string}
   */
  generate(version) {
    const pluginConfig = strapi.config.get('plugin::field-uuid', {});
    const v = version || pluginConfig.defaultVersion || 'v4';
    return v === 'v7' ? uuidv7() : uuidv4();
  },

  /**
   * @param {string} uuid
   * @returns {boolean}
   */
  validate(uuid) {
    return validateUuid(uuid);
  },

  /**
   * Returns the value if it's a valid UUID, otherwise generates a new one.
   * @param {string} value
   * @param {string} [version]
   * @returns {string}
   */
  ensureUuid(value, version) {
    if (!value || !validateUuid(value)) {
      return this.generate(version);
    }
    return value;
  },

  /**
   * Checks if a UUID already exists in a content type.
   * @param {Object} params
   * @param {string} params.contentType - Must be an api:: content type with UUID field
   * @param {string} params.field
   * @param {string} params.uuid
   * @param {string} [params.excludeDocumentId]
   * @returns {Promise<{exists: boolean, valid: boolean}>}
   */
  async checkDuplicate({ contentType, field, uuid, excludeDocumentId }) {
    const isValid = validateUuid(uuid);

    if (!isValid) {
      return { exists: false, valid: false };
    }

    // Use db.query so both draft and published rows are checked.
    const where = { [field]: uuid };
    if (excludeDocumentId) {
      where.documentId = { $ne: excludeDocumentId };
    }

    const existing = await strapi.db.query(contentType).findOne({
      where,
      select: ['documentId'],
    });

    return { exists: !!existing, valid: true };
  },

  /**
   * Finds all api:: content types that use the UUID custom field.
   * @returns {Object} Map of UIDs to field name arrays
   */
  getUuidModels() {
    const { contentTypes } = strapi;

    return Object.keys(contentTypes).reduce((acc, key) => {
      const contentType = contentTypes[key];

      if (!key.startsWith('api::')) return acc;

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
   * Validates that a UID belongs to an api:: content type with a UUID field.
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @returns {{ valid: boolean, error?: string }}
   */
  validateUuidField(uid, field) {
    if (!uid || !uid.startsWith('api::')) {
      return { valid: false, error: 'Only api:: content types are allowed' };
    }

    const model = strapi.contentTypes[uid];
    if (!model) {
      return { valid: false, error: `Content type '${uid}' not found` };
    }

    const attribute = model.attributes[field];
    if (!attribute) {
      return { valid: false, error: `Field '${field}' not found in '${uid}'` };
    }

    if (attribute.customField !== 'plugin::field-uuid.uuid') {
      return { valid: false, error: `Field '${field}' is not a UUID custom field` };
    }

    return { valid: true };
  },

  /**
   * Fetches all entries for a given UID and fields using safe pagination.
   * @param {string} uid
   * @param {string[]} fields
   * @param {Object} [filters]
   * @returns {Promise<Array>}
   */
  async fetchAllEntries(uid, fields, filters) {
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
  },

  /**
   * Diagnoses all UUID fields for duplicates across all content types.
   * @returns {Promise<Object>}
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
   * Finds duplicate UUIDs for a specific content type and field.
   * @param {string} uid
   * @param {string} field
   * @returns {Promise<Array>}
   */
  async findDuplicatesForField(uid, field) {
    const entries = await this.fetchAllEntries(uid, ['documentId', field]);

    const uuidGroups = {};
    for (const entry of entries) {
      const uuidValue = entry[field];
      if (!uuidValue) continue;

      if (!uuidGroups[uuidValue]) {
        uuidGroups[uuidValue] = [];
      }
      uuidGroups[uuidValue].push(entry.documentId);
    }

    const duplicates = [];
    for (const [uuid, documentIds] of Object.entries(uuidGroups)) {
      if (documentIds.length > 1) {
        duplicates.push({ uuid, count: documentIds.length, documentIds });
      }
    }

    return duplicates;
  },

  /**
   * Auto-fixes all duplicate UUIDs by generating new unique ones.
   * Wrapped in a database transaction for atomicity.
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false]
   * @returns {Promise<Object>}
   */
  async autofix({ dryRun = false } = {}) {
    const models = this.getUuidModels();
    const report = {
      dryRun,
      fixedModels: 0,
      totalFixed: 0,
      details: {},
    };

    const executeFixForModel = async (uid, fields) => {
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
    };

    if (dryRun) {
      for (const [uid, fields] of Object.entries(models)) {
        await executeFixForModel(uid, fields);
      }
    } else {
      await strapi.db.transaction(async () => {
        for (const [uid, fields] of Object.entries(models)) {
          await executeFixForModel(uid, fields);
        }
      });
    }

    return report;
  },

  /**
   * Fixes duplicate UUIDs for a specific content type and field.
   * @param {string} uid
   * @param {string} field
   * @param {boolean} dryRun
   * @returns {Promise<Object>}
   */
  async fixDuplicatesForField(uid, field, dryRun) {
    const duplicates = await this.findDuplicatesForField(uid, field);
    const fixes = {
      found: duplicates.length,
      fixed: 0,
      changes: [],
    };

    for (const group of duplicates) {
      const [keepDocumentId, ...duplicateDocumentIds] = group.documentIds;

      for (const documentId of duplicateDocumentIds) {
        const newUuid = this.generate();

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
   * Generates missing UUIDs for entries with empty UUID fields.
   * Wrapped in a database transaction for atomicity.
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false]
   * @returns {Promise<Object>}
   */
  async generateMissing({ dryRun = false } = {}) {
    const models = this.getUuidModels();
    const report = {
      dryRun,
      totalGenerated: 0,
      details: {},
    };

    const executeForModel = async (uid, fields) => {
      report.details[uid] = { fields: {} };

      for (const field of fields) {
        const entries = await this.fetchAllEntries(uid, ['documentId', field], {
          $or: [
            { [field]: { $null: true } },
            { [field]: '' },
          ],
        });

        const generated = [];
        for (const entry of entries) {
          const newUuid = this.generate();
          generated.push({ documentId: entry.documentId, newUuid });

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
    };

    if (dryRun) {
      for (const [uid, fields] of Object.entries(models)) {
        await executeForModel(uid, fields);
      }
    } else {
      await strapi.db.transaction(async () => {
        for (const [uid, fields] of Object.entries(models)) {
          await executeForModel(uid, fields);
        }
      });
    }

    return report;
  },
});

export default service;
