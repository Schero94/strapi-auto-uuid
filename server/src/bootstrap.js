import * as uuidLib from 'uuid';

const { v4: uuidv4, validate: validateUuid } = uuidLib;
const uuidv7 = uuidLib.v7 || uuidv4;
import { errors } from '@strapi/utils';

const { ValidationError, ApplicationError } = errors;

const MAX_QUERY_LIMIT = 10000;

/**
 * Bootstrap - Lifecycle Hooks for UUID Auto-Generation
 *
 * Subscribes to database lifecycle events and automatically generates
 * UUID values for fields using the 'uuid' custom field.
 *
 * Respects both plugin-level config and per-field CTB options:
 * - uuid-version (v4/v7)
 * - uuid-prefix
 * - disable-auto-generate
 * - allow-edit
 */
const bootstrap = ({ strapi }) => {
  const { contentTypes } = strapi;

  const pluginConfig = strapi.config.get('plugin::field-uuid', {});
  const config = {
    defaultVersion: pluginConfig.defaultVersion || 'v4',
    autoGenerate: pluginConfig.autoGenerate !== false,
    validateUniqueness: pluginConfig.validateUniqueness !== false,
    maxRetryAttempts: pluginConfig.maxRetryAttempts || 3,
    logLevel: pluginConfig.logLevel || 'info',
    autoMigrate: pluginConfig.autoMigrate || false,
  };

  /**
   * @param {string} version - 'v4' or 'v7'
   * @param {string} [prefix] - optional prefix string
   * @returns {string}
   */
  const generateUuid = (version = config.defaultVersion, prefix = '') => {
    const raw = version === 'v7' ? uuidv7() : uuidv4();
    return prefix ? `${prefix}${raw}` : raw;
  };

  const log = {
    debug: (...args) => config.logLevel === 'debug' && strapi.log.debug(...args),
    info: (...args) => ['debug', 'info'].includes(config.logLevel) && strapi.log.info(...args),
    warn: (...args) => ['debug', 'info', 'warn'].includes(config.logLevel) && strapi.log.warn(...args),
    error: (...args) => strapi.log.error(...args),
  };

  /**
   * Reads per-field CTB options from the attribute definition.
   * Options are stored under attribute.options (e.g. 'uuid-version', 'uuid-prefix').
   * @param {Object} attribute - Content type attribute definition
   * @returns {{ version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
   */
  const getFieldOptions = (attribute) => {
    const opts = attribute?.options || {};
    return {
      version: opts['uuid-version'] || config.defaultVersion,
      prefix: opts['uuid-prefix'] || '',
      disableAutoGenerate: opts['disable-auto-generate'] === true,
      allowEdit: opts['allow-edit'] === true,
    };
  };

  /**
   * Finds all content types that use the uuid custom field.
   * @returns {Object} Map of UIDs to arrays of { field, attribute } objects
   */
  const findUuidModels = () => {
    return Object.keys(contentTypes).reduce((acc, key) => {
      const contentType = contentTypes[key];

      if (!key.startsWith('api')) return acc;

      const uuidFields = Object.keys(contentType.attributes)
        .filter((attrKey) => {
          const attribute = contentType.attributes[attrKey];
          return attribute.customField === 'plugin::field-uuid.uuid';
        })
        .map((attrKey) => ({
          field: attrKey,
          attribute: contentType.attributes[attrKey],
        }));

      if (uuidFields.length > 0) {
        return { ...acc, [key]: uuidFields };
      }

      return acc;
    }, {});
  };

  const models = findUuidModels();
  const modelsToSubscribe = Object.keys(models);

  if (modelsToSubscribe.length > 0) {
    log.info(`[strapi-auto-uuid] Monitoring ${modelsToSubscribe.length} content type(s) for UUID generation`);
    log.debug(`[strapi-auto-uuid] Config: ${JSON.stringify(config)}`);
  }

  /**
   * Checks if a UUID already exists in the database.
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @param {string} uuid - UUID value to check
   * @param {string|null} excludeDocumentId - documentId to exclude (for updates)
   * @returns {Promise<{exists: boolean, documentId: string|null}>}
   */
  const checkUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    if (!config.validateUniqueness) {
      return { exists: false, documentId: null };
    }

    const filters = { [field]: uuid };

    if (excludeDocumentId) {
      filters.documentId = { $ne: excludeDocumentId };
    }

    const existing = await strapi.documents(uid).findFirst({
      filters,
      fields: ['documentId'],
    });

    return {
      exists: !!existing,
      documentId: existing?.documentId || null,
    };
  };

  /**
   * @returns {Promise<boolean>}
   */
  const isUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    const result = await checkUuidExists(uid, field, uuid, excludeDocumentId);
    return result.exists;
  };

  /**
   * Generates a unique UUID with retry logic for collision handling.
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @param {string} [version] - UUID version override
   * @param {string} [prefix] - UUID prefix override
   * @returns {Promise<string>}
   * @throws {ApplicationError} If unable to generate unique UUID after max attempts
   */
  const generateUniqueUuid = async (uid, field, version, prefix) => {
    for (let attempt = 0; attempt < config.maxRetryAttempts; attempt++) {
      const newUuid = generateUuid(version, prefix);

      if (!config.validateUniqueness) {
        return newUuid;
      }

      const exists = await isUuidExists(uid, field, newUuid);

      if (!exists) {
        return newUuid;
      }

      log.warn(
        `[strapi-auto-uuid] UUID collision detected for ${uid}.${field}, retrying (attempt ${attempt + 1}/${config.maxRetryAttempts})`
      );
    }

    throw new ApplicationError(
      `Failed to generate unique UUID for ${uid}.${field} after ${config.maxRetryAttempts} attempts`
    );
  };

  /**
   * Retrieves the documentId from the lifecycle event's where clause.
   * In Strapi v5, lifecycle events provide documentId directly in where.
   * Falls back to querying by numeric id via knex if needed.
   * @param {string} uid - Content type UID
   * @param {Object} where - The where clause from lifecycle params
   * @returns {Promise<string|null>}
   */
  const getDocumentIdFromWhere = async (uid, where) => {
    if (!where) return null;

    if (where.documentId) {
      return where.documentId;
    }

    if (where.id) {
      try {
        const model = strapi.getModel(uid);
        const tableName = model.collectionName;
        const row = await strapi.db.connection(tableName)
          .select('document_id')
          .where('id', where.id)
          .first();
        return row?.document_id || null;
      } catch {
        return null;
      }
    }

    return null;
  };

  strapi.db.lifecycles.subscribe({
    models: modelsToSubscribe,

    /**
     * Before Create - Generates UUID if empty/invalid, validates uniqueness.
     * Respects per-field options from CTB configuration.
     */
    async beforeCreate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];

      if (!uuidFields) return;

      const currentDocumentId = params.data?.documentId || params.where?.documentId;

      log.debug(`[strapi-auto-uuid] beforeCreate for ${model.uid}, documentId: ${currentDocumentId || 'none'}`);

      for (const { field, attribute } of uuidFields) {
        const fieldOpts = getFieldOptions(attribute);
        const currentValue = params.data[field];
        const shouldAutoGenerate = config.autoGenerate && !fieldOpts.disableAutoGenerate;

        if ((!currentValue || !validateUuid(currentValue)) && shouldAutoGenerate) {
          params.data[field] = await generateUniqueUuid(model.uid, field, fieldOpts.version, fieldOpts.prefix);
          log.debug(`[strapi-auto-uuid] Generated UUID for ${model.uid}.${field}`);
        } else if (currentValue && config.validateUniqueness) {
          const { exists, documentId: existingDocumentId } = await checkUuidExists(
            model.uid,
            field,
            currentValue
          );

          log.debug(`[strapi-auto-uuid] UUID check: exists=${exists}, existingDocId=${existingDocumentId}, currentDocId=${currentDocumentId}`);

          if (exists) {
            if (currentDocumentId && existingDocumentId === currentDocumentId) {
              log.debug(`[strapi-auto-uuid] UUID belongs to same document, keeping it`);
            } else if (!currentDocumentId && existingDocumentId) {
              log.debug(`[strapi-auto-uuid] UUID exists, no documentId in params - keeping (likely publish)`);
            } else {
              log.info(
                `[strapi-auto-uuid] UUID '${currentValue}' already exists for ${model.uid}.${field}, generating new one`
              );
              params.data[field] = await generateUniqueUuid(model.uid, field, fieldOpts.version, fieldOpts.prefix);
            }
          }
        }
      }
    },

    /**
     * Before Update - Validates UUID changes don't create duplicates.
     */
    async beforeUpdate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];

      if (!uuidFields) return;

      const documentId = await getDocumentIdFromWhere(model.uid, params.where);
      if (!documentId) return;

      for (const { field } of uuidFields) {
        if (params.data[field] === undefined) continue;

        const newValue = params.data[field];

        if (newValue && !validateUuid(newValue)) {
          throw new ValidationError(
            `Invalid UUID format for field '${field}': '${newValue}'`,
            { field, uuid: newValue }
          );
        }

        if (newValue && config.validateUniqueness) {
          const exists = await isUuidExists(model.uid, field, newValue, documentId);

          if (exists) {
            throw new ValidationError(
              `UUID '${newValue}' already exists for field '${field}'. Please use a unique value.`,
              { field, uuid: newValue }
            );
          }
        }
      }
    },
  });

  if (config.autoMigrate && modelsToSubscribe.length > 0) {
    log.info('[strapi-auto-uuid] Auto-migration enabled, checking for issues...');

    setImmediate(async () => {
      try {
        const migrations = strapi.plugin('field-uuid').service('migrations');
        const status = await migrations.checkMigrationStatus();

        if (status.needsMigration) {
          log.warn(`[strapi-auto-uuid] Found ${status.totalFields} field(s) with issues, running auto-fix...`);
          const result = await migrations.runMigration({ dryRun: false });
          log.info(`[strapi-auto-uuid] Auto-migration completed: ${result.totalFixed} entries fixed`);
        } else {
          log.info('[strapi-auto-uuid] No migration needed, all UUIDs are valid');
        }
      } catch (err) {
        log.error('[strapi-auto-uuid] Auto-migration failed:', err.message);
      }
    });
  }
};

export default bootstrap;
