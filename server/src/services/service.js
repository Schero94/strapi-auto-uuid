import * as uuidLib from 'uuid';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  isUuidOfVersion,
  resolveUuidFieldOptions,
} from '../../../shared/uuid-field.js';
import { withUuidRepairContext } from '../utils/repair-context.js';

const { validate: validateUuid } = uuidLib;

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
   * @param {'v4'|'v7'} [version] Version override; invalid values are rejected.
   * @returns {string} UUID in the configured version.
   * @throws {TypeError} When the requested or configured version is unsupported.
   */
  generate(version) {
    const pluginConfig = strapi.config.get('plugin::field-uuid', {});
    const resolvedVersion = resolveUuidFieldOptions(
      version ? { 'uuid-version': version } : {},
      pluginConfig.defaultVersion || 'v4'
    ).version;
    return generateUuidFieldValue({ version: resolvedVersion, prefix: '' });
  },

  /**
   * @param {unknown} uuid Candidate UUID value.
   * @returns {boolean} Whether the value has valid UUID syntax.
   */
  validate(uuid) {
    return validateUuid(uuid);
  },

  /**
   * Returns the value if it's a valid UUID, otherwise generates a new one.
   * @param {unknown} value Candidate UUID value.
   * @param {'v4'|'v7'} [version] Version to use only when a replacement is needed.
   * @returns {string} The original value when valid or a new UUID when invalid.
   */
  ensureUuid(value, version) {
    if (!value || !validateUuid(value)) {
      return this.generate(version);
    }
    return value;
  },

  /**
   * Checks if a UUID already exists in a content type.
   * @param {Object} params Duplicate lookup options.
   * @param {string} params.contentType API content type UID with a UUID field.
   * @param {string} params.field UUID custom-field name.
   * @param {string} params.uuid Candidate field value, including its prefix.
   * @param {string} [params.excludeDocumentId] Current document to ignore.
   * @returns {Promise<{exists: boolean, valid: boolean}>} Lookup result.
   */
  async checkDuplicate({ contentType, field, uuid, excludeDocumentId }) {
    const validation = this.validateUuidField(contentType, field);
    if (!validation.valid) return { exists: false, valid: false };

    const fieldOptions = this.getFieldOptions(contentType, field);
    const isValid = isUuidFieldValue(uuid, fieldOptions);

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

    try {
      this.getFieldOptions(uid, field);
    } catch {
      return { valid: false, error: 'UUID field configuration is invalid' };
    }

    return { valid: true };
  },

  /**
   * Resolves a UUID custom field's version, prefix and editing options from
   * the registered content-type schema.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @returns {{ version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
   * @throws {TypeError} If the field configuration is malformed.
   */
  getFieldOptions(uid, field) {
    const attribute = strapi.contentTypes[uid]?.attributes?.[field];
    const pluginConfig = strapi.config.get('plugin::field-uuid', {});
    return resolveUuidFieldOptions(attribute?.options || {}, pluginConfig.defaultVersion || 'v4');
  },

  /**
   * Generates a collision-free value using the target field's version and
   * prefix. The current document is excluded when checking uniqueness.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {string} [excludeDocumentId] Document receiving the replacement.
   * @returns {Promise<string>} A unique, correctly configured field value.
   * @throws {Error} If the field is invalid or all collision retries fail.
   */
  async generateUniqueFieldValue(uid, field, excludeDocumentId) {
    const fieldOptions = this.getFieldOptions(uid, field);
    const pluginConfig = strapi.config.get('plugin::field-uuid', {});
    const maxAttempts = Number.isInteger(pluginConfig.maxRetryAttempts)
      ? Math.max(1, pluginConfig.maxRetryAttempts)
      : 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const value = generateUuidFieldValue(fieldOptions);
      const duplicate = await this.checkDuplicate({
        contentType: uid,
        field,
        uuid: value,
        excludeDocumentId,
      });
      if (duplicate.valid && !duplicate.exists) return value;
    }

    throw new Error(`Failed to generate a unique UUID for ${uid}.${field}.`);
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
   * Scans each registered UUID field for invalid values and duplicate groups.
   * A field whose configuration or database scan fails is marked as incomplete
   * instead of being reported as clean.
   *
   * @returns {Promise<Object>} Counts and per-field diagnosis results.
   */
  async diagnose() {
    const models = this.getUuidModels();
    const report = {
      scannedModels: 0,
      totalDuplicates: 0,
      details: {},
    };

    report.hasErrors = false;
    report.issues = [];

    for (const [uid, fields] of Object.entries(models)) {
      report.scannedModels++;
      report.details[uid] = { fields: {} };

      for (const field of fields) {
        try {
          const options = this.getFieldOptions(uid, field);
          const entries = await this.fetchAllEntries(uid, ['documentId', field]);
          const groups = new Map();
          let invalidCount = 0;

          for (const entry of entries) {
            const value = entry[field];
            if (!value) continue;
            if (!isUuidFieldValue(value, options)) invalidCount += 1;
            const documentIds = groups.get(value) || [];
            documentIds.push(entry.documentId);
            groups.set(value, documentIds);
          }

          const duplicates = [...groups.entries()]
            .filter(([, documentIds]) => documentIds.length > 1)
            .map(([value, documentIds]) => ({ uuid: value, count: documentIds.length, documentIds }));
          const duplicateCount = duplicates.reduce((sum, group) => sum + group.count - 1, 0);

          report.details[uid].fields[field] = {
            invalidCount,
            duplicateGroups: duplicates.length,
            affectedEntries: duplicates.reduce((sum, group) => sum + group.count, 0),
            duplicates,
          };
          report.totalDuplicates += duplicateCount;
        } catch (error) {
          report.hasErrors = true;
          report.issues.push({
            uid,
            field,
            message: error?.code === 'INVALID_UUID_FIELD_CONFIG'
              ? 'UUID field configuration is invalid. Check its version and prefix.'
              : 'Could not scan this UUID field. No repairs were attempted.',
          });
          report.details[uid].fields[field] = { invalidCount: 0, duplicateGroups: 0, affectedEntries: 0, scanFailed: true };
        }
      }
    }

    return report;
  },

  /**
   * Finds repeated non-empty values for one UUID field. A Map is used because
   * stored legacy values are untrusted and may resemble object property names.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID custom-field name.
   * @returns {Promise<Array<{uuid: string, count: number, documentIds: string[]}>>} Duplicate groups.
   */
  async findDuplicatesForField(uid, field) {
    const entries = await this.fetchAllEntries(uid, ['documentId', field]);

    const uuidGroups = new Map();
    for (const entry of entries) {
      const uuidValue = entry[field];
      if (!uuidValue) continue;

      const documentIds = uuidGroups.get(uuidValue) || [];
      documentIds.push(entry.documentId);
      uuidGroups.set(uuidValue, documentIds);
    }

    const duplicates = [];
    for (const [uuid, documentIds] of uuidGroups.entries()) {
      if (documentIds.length > 1) {
        duplicates.push({ uuid, count: documentIds.length, documentIds });
      }
    }

    return duplicates;
  },

  /**
   * Auto-fixes all duplicate UUIDs by generating new unique ones.
   * Writes run in one transaction. Every field's options are validated before
   * any write begins, and omitted options produce a read-only preview.
   *
   * @param {Object} [options] Repair options.
   * @param {boolean} [options.dryRun=true] Preview only unless a caller explicitly opts into writes.
   * @returns {Promise<Object>} Per-field duplicate counts and proposed changes.
   */
  async autofix({ dryRun = true } = {}) {
    const models = this.getUuidModels();
    for (const [uid, fields] of Object.entries(models)) {
      for (const field of fields) this.getFieldOptions(uid, field);
    }
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
   * Replacement values follow the field's configured version and prefix.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID custom-field name.
   * @param {boolean} [dryRun=true] Preview changes unless writes are explicitly enabled.
   * @returns {Promise<Object>} Counts and proposed field replacements.
   */
  async fixDuplicatesForField(uid, field, dryRun = true) {
    const duplicates = await this.findDuplicatesForField(uid, field);
    const fixes = {
      found: duplicates.length,
      fixed: 0,
      changes: [],
    };

    for (const group of duplicates) {
      const [keepDocumentId, ...duplicateDocumentIds] = group.documentIds;

      for (const documentId of duplicateDocumentIds) {
        const newUuid = await this.generateUniqueFieldValue(uid, field, documentId);

        fixes.changes.push({
          documentId,
          oldUuid: group.uuid,
          newUuid,
          kept: keepDocumentId,
        });

        if (!dryRun) {
          await withUuidRepairContext(() => strapi.documents(uid).update({
            documentId,
            data: { [field]: newUuid },
          }));
          strapi.log.info(`[strapi-auto-uuid] Fixed duplicate UUID in ${uid}.${field}`);
        }

        fixes.fixed++;
      }
    }

    return fixes;
  },

  /**
   * Generates missing UUIDs for entries with empty UUID fields.
   * Values use the configured field version and prefix. Writes run in one
   * transaction, and an omitted option produces a read-only preview.
   *
   * @param {Object} [options] Repair options.
   * @param {boolean} [options.dryRun=true] Preview only unless a caller explicitly opts into writes.
   * @returns {Promise<Object>} Counts and proposed field values.
   */
  async generateMissing({ dryRun = true } = {}) {
    const models = this.getUuidModels();
    for (const [uid, fields] of Object.entries(models)) {
      for (const field of fields) this.getFieldOptions(uid, field);
    }
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
          const newUuid = await this.generateUniqueFieldValue(uid, field, entry.documentId);
          generated.push({ documentId: entry.documentId, newUuid });

          if (!dryRun) {
            await withUuidRepairContext(() => strapi.documents(uid).update({
              documentId: entry.documentId,
              data: { [field]: newUuid },
            }));
            strapi.log.info(`[strapi-auto-uuid] Generated missing UUID for ${uid}.${field}`);
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
