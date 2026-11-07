import { validate as validateUuid } from 'uuid';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  resolveUuidFieldOptions,
} from '../../../shared/uuid-field.js';
import { getPluginConfig } from '../config/index.js';
import {
  fetchFieldRows,
  getUuidModels,
  groupDuplicates,
  isUuidAttribute,
  resolveFieldOptions,
} from '../utils/uuid-models.js';

/**
 * UUID plugin service: generation helpers, field lookups, diagnosis and the
 * two focused repairs (duplicates, missing values). The repairs delegate to
 * the migrations service so every write follows the same transactional,
 * locked and re-validated path.
 *
 * @param {{ strapi: Object }} context Strapi context.
 */
const service = ({ strapi }) => ({
  /**
   * Generates a UUID in the requested or configured default version.
   *
   * @param {'v4'|'v7'} [version] Version override.
   * @returns {string} UUID without prefix.
   * @throws {TypeError} When the version is unsupported.
   */
  generate(version) {
    const { defaultVersion } = getPluginConfig(strapi);
    const resolved = resolveUuidFieldOptions(
      version ? { 'uuid-version': version } : {},
      defaultVersion
    ).version;
    return generateUuidFieldValue({ version: resolved, prefix: '' });
  },

  /**
   * @param {unknown} uuid Candidate value.
   * @returns {boolean} Whether the value has valid UUID syntax.
   */
  validate(uuid) {
    return typeof uuid === 'string' && validateUuid(uuid);
  },

  /**
   * Returns the value when it is a valid UUID, otherwise a new one.
   *
   * @param {unknown} value Candidate value.
   * @param {'v4'|'v7'} [version] Version for a replacement.
   * @returns {string} Valid UUID.
   */
  ensureUuid(value, version) {
    return this.validate(value) ? value : this.generate(version);
  },

  /**
   * Lists the content types with UUID fields as `{ uid: [field, ...] }`.
   *
   * @returns {Record<string, string[]>} UUID fields per content type.
   */
  getUuidModels() {
    return getUuidModels(strapi);
  },

  /**
   * Checks that `uid` is a content type with the UUID custom field `field`.
   * Messages are generic so they do not reveal which schemas exist.
   *
   * @param {string} uid Content type UID.
   * @param {string} field Field name.
   * @returns {{ valid: boolean, error?: string }} Result.
   */
  validateUuidField(uid, field) {
    const attribute = strapi.contentTypes?.[uid]?.attributes?.[field];
    if (typeof uid !== 'string' || !isUuidAttribute(attribute)) {
      return { valid: false, error: 'The UUID field is not available.' };
    }
    try {
      this.getFieldOptions(uid, field);
    } catch {
      return { valid: false, error: 'UUID field configuration is invalid.' };
    }
    return { valid: true };
  },

  /**
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @returns {{ version: 'v4'|'v7', prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
   * @throws {TypeError} When the field options are malformed.
   */
  getFieldOptions(uid, field) {
    return resolveFieldOptions(strapi, uid, field, getPluginConfig(strapi).defaultVersion);
  },

  /**
   * Checks whether a value is used by a document other than
   * `excludeDocumentId`, across all locales, drafts and published rows.
   *
   * @param {Object} params Lookup parameters.
   * @param {string} params.contentType Content type UID.
   * @param {string} params.field UUID field name.
   * @param {string} params.uuid Complete value including prefix.
   * @param {string} [params.excludeDocumentId] Document allowed to hold the value.
   * @returns {Promise<{ exists: boolean, valid: boolean }>} Lookup result.
   */
  async checkDuplicate({ contentType, field, uuid, excludeDocumentId }) {
    if (!this.validateUuidField(contentType, field).valid) return { exists: false, valid: false };
    if (!isUuidFieldValue(uuid, this.getFieldOptions(contentType, field))) {
      return { exists: false, valid: false };
    }
    const where = { [field]: uuid };
    if (excludeDocumentId) where.documentId = { $ne: excludeDocumentId };
    const existing = await strapi.db.query(contentType).findOne({ where, select: ['id'] });
    return { exists: Boolean(existing), valid: true };
  },

  /**
   * Generates an unused value for a field (its version and prefix).
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {Set<string>} [reserved] Values already planned in the same batch.
   * @returns {Promise<string>} Unused value.
   * @throws {Error} When every attempt collides or the field is invalid.
   */
  async generateUniqueFieldValue(uid, field, reserved) {
    const options = this.getFieldOptions(uid, field);
    const { maxRetryAttempts } = getPluginConfig(strapi);
    for (let attempt = 0; attempt < maxRetryAttempts; attempt += 1) {
      const value = generateUuidFieldValue(options);
      if (reserved?.has(value)) continue;
      const existing = await strapi.db.query(uid).findOne({
        where: { [field]: value },
        select: ['id'],
      });
      if (!existing) return value;
    }
    throw new Error(`Failed to generate a unique UUID for ${uid}.${field}.`);
  },

  /**
   * Returns the duplicate groups of one field (values held by more than one
   * document; oldest document first).
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @returns {Promise<Array<{ uuid: string, count: number, documentIds: string[] }>>}
   */
  async findDuplicatesForField(uid, field) {
    return groupDuplicates(await fetchFieldRows(strapi, uid, field), field);
  },

  /**
   * Scans every UUID field for duplicates and malformed or legacy-format
   * values. A field that cannot be scanned is reported, never shown as clean.
   *
   * @returns {Promise<Object>} Diagnosis report (redacted by the controller).
   */
  async diagnose() {
    const status = await strapi.plugin('field-uuid').service('migrations').checkMigrationStatus();
    const report = {
      scannedModels: 0,
      totalDuplicates: 0,
      totalInvalid: 0,
      totalLegacy: 0,
      totalEmpty: 0,
      hasErrors: status.hasErrors,
      issues: status.issues,
      details: {},
    };

    for (const info of status.contentTypes) {
      if (!report.details[info.uid]) {
        report.details[info.uid] = { fields: {} };
        report.scannedModels += 1;
      }
      report.details[info.uid].fields[info.field] = info.scanFailed
        ? { scanFailed: true, code: info.code }
        : {
            invalidCount: info.invalidCount,
            legacyCount: info.legacyCount,
            emptyCount: info.emptyCount,
            duplicateGroups: info.duplicateGroups,
            duplicateCount: info.duplicateCount,
          };
      if (!info.scanFailed) {
        report.totalDuplicates += info.duplicateCount;
        report.totalInvalid += info.invalidCount;
        report.totalLegacy += info.legacyCount;
        report.totalEmpty += info.emptyCount;
      }
    }
    return report;
  },

  /**
   * Replaces values shared by several documents. The oldest document keeps
   * its value. Preview unless `dryRun: false`.
   *
   * @param {{ dryRun?: boolean }} [options] Repair options.
   * @returns {Promise<Object>} Repair result with `totalFixed`.
   */
  async autofix({ dryRun = true } = {}) {
    return strapi.plugin('field-uuid').service('migrations').runMigration({
      dryRun,
      fixEmpty: false,
      fixInvalid: false,
      fixDuplicates: true,
      fixLegacy: false,
    });
  },

  /**
   * Fills empty auto-generated UUID fields. Fields with auto-generation
   * disabled are left empty on purpose. Preview unless `dryRun: false`.
   *
   * @param {{ dryRun?: boolean }} [options] Repair options.
   * @returns {Promise<Object>} Repair result with `totalGenerated`.
   */
  async generateMissing({ dryRun = true } = {}) {
    const result = await strapi.plugin('field-uuid').service('migrations').runMigration({
      dryRun,
      fixEmpty: true,
      fixInvalid: false,
      fixDuplicates: false,
      fixLegacy: false,
    });
    return { ...result, totalGenerated: result.fixed.empty };
  },
});

export default service;
