import { errors } from '@strapi/utils';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  resolveUuidFieldOptions,
} from '../../shared/uuid-field.js';
import { isUuidRepairContext } from './utils/repair-context.js';

const { ValidationError, ApplicationError } = errors;

/**
 * Registers RBAC permission actions for the plugin so admin routes can use
 * `admin::hasPermissions` instead of a plain `isAuthenticatedAdmin` policy.
 * @param {Object} strapi
 */
const registerPluginPermissions = async (strapi) => {
  const actions = [
    { section: 'plugins', displayName: 'Read diagnostics and stats', uid: 'read', pluginName: 'field-uuid' },
    { section: 'plugins', displayName: 'Run destructive auto-fix / generate / migrate', uid: 'migrate', pluginName: 'field-uuid' },
    { section: 'plugins', displayName: 'Export UUID mappings', uid: 'export', pluginName: 'field-uuid' },
    { section: 'plugins', displayName: 'Import UUID mappings', uid: 'import', pluginName: 'field-uuid' },
  ];

  try {
    await strapi.admin?.services?.permission?.actionProvider?.registerMany?.(actions);
  } catch (err) {
    strapi.log.error(`[strapi-auto-uuid] Failed to register plugin permissions (${err?.name || 'Error'})`);
  }
};

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
const bootstrap = async ({ strapi }) => {
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

  // Reject an invalid plugin default before lifecycle hooks can silently
  // generate values with a different version.
  resolveUuidFieldOptions({}, config.defaultVersion);

  await registerPluginPermissions(strapi);

  const log = {
    debug: (...args) => config.logLevel === 'debug' && strapi.log.debug(...args),
    info: (...args) => ['debug', 'info'].includes(config.logLevel) && strapi.log.info(...args),
    warn: (...args) => ['debug', 'info', 'warn'].includes(config.logLevel) && strapi.log.warn(...args),
    error: (...args) => strapi.log.error(...args),
  };

  /**
   * Reads per-field CTB options. Untrusted prefixes from CTB are validated
   * against the shared UUID field rules before use in API values.
   * Unsupported options reject the write instead of silently using defaults.
   *
   * @param {Object} attribute - Content type attribute definition
   * @param {string} modelUid - Content type UID (for logging)
   * @param {string} fieldName - Attribute name (for logging)
   * @returns {{version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean}}
   * @throws {ValidationError} When the field options are invalid.
   */
  const getFieldOptions = (attribute, modelUid, fieldName) => {
    try {
      return resolveUuidFieldOptions(attribute?.options || {}, config.defaultVersion);
    } catch (error) {
      throw new ValidationError(
        `Invalid UUID field configuration for '${modelUid}.${fieldName}': ${error.message}`,
        { field: fieldName }
      );
    }
  };

  /**
   * Finds all api:: content types that use the uuid custom field and
   * warns when the underlying attribute has no DB-level unique constraint.
   */
  const findUuidModels = () => {
    return Object.keys(contentTypes).reduce((acc, key) => {
      const contentType = contentTypes[key];

      if (!key.startsWith('api::')) return acc;

      const uuidFields = Object.keys(contentType.attributes)
        .filter((attrKey) => {
          const attribute = contentType.attributes[attrKey];
          return attribute.customField === 'plugin::field-uuid.uuid';
        })
        .map((attrKey) => {
          const attribute = contentType.attributes[attrKey];
          if (!attribute.unique) {
            strapi.log.warn(
              `[strapi-auto-uuid] ${key}.${attrKey} has no DB 'unique' constraint. Uniqueness is only enforced by lifecycle hooks; under concurrency a race condition can produce duplicates. Enable "Unique" in the Content-Type Builder.`
            );
          }
          return { field: attrKey, attribute };
        });

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
   * Checks for an identical field value across draft and published database
   * rows, optionally excluding the document currently being updated.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {string} uuid Complete field value including prefix.
   * @param {string|null} [excludeDocumentId] Document allowed to retain its value.
   * @returns {Promise<{exists: boolean, documentId: string|null}>} Duplicate state.
   */
  const checkUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    if (!config.validateUniqueness) {
      return { exists: false, documentId: null };
    }

    const where = { [field]: uuid };
    if (excludeDocumentId) {
      where.documentId = { $ne: excludeDocumentId };
    }

    const existing = await strapi.db.query(uid).findOne({
      where,
      select: ['documentId'],
    });

    return {
      exists: !!existing,
      documentId: existing?.documentId || null,
    };
  };

  /**
   * Returns whether a complete field value is already assigned elsewhere.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {string} uuid Complete field value including prefix.
   * @param {string|null} [excludeDocumentId] Document allowed to retain its value.
   * @returns {Promise<boolean>} Whether another document has the value.
   */
  const isUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    const result = await checkUuidExists(uid, field, uuid, excludeDocumentId);
    return result.exists;
  };

  /**
   * Generates a configured UUID and retries collisions found by the database
   * preflight. The lookup is only a best-effort guard under concurrent writes;
   * a database unique constraint is required for race-safe uniqueness. When
   * uniqueness validation is disabled, the candidate is returned unchecked.
   *
   * @param {string} uid Content type UID.
   * @param {string} field UUID field name.
   * @param {'v4'|'v7'} version Requested UUID version.
   * @param {string} prefix Configured field prefix.
   * @returns {Promise<string>} A configured value not found by the preflight lookup.
   * @throws {ApplicationError} When the retry limit is reached.
   */
  const generateUniqueUuid = async (uid, field, version, prefix) => {
    for (let attempt = 0; attempt < config.maxRetryAttempts; attempt++) {
      const newUuid = generateUuidFieldValue({ version, prefix });

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
   * Resolves a Document Service or database `where` clause to its document ID.
   * Failure returns null so UUID updates can be rejected by the lifecycle hook.
   *
   * @param {string} uid Content type UID.
   * @param {Object} where Database update selector.
   * @returns {Promise<string|null>} Resolved document ID, when available.
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
     * Validates supplied UUIDs or generates missing/invalid values before
     * create. The existing-row lookup handles ordinary collisions, but the
     * database unique constraint remains necessary to close concurrent races.
     */
    async beforeCreate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];

      if (!uuidFields) return;

      const currentDocumentId = params.data?.documentId || params.where?.documentId;

      log.debug(`[strapi-auto-uuid] beforeCreate for ${model.uid}`);

      for (const { field, attribute } of uuidFields) {
        const fieldOpts = getFieldOptions(attribute, model.uid, field);
        const currentValue = params.data[field];
        const shouldAutoGenerate = config.autoGenerate && !fieldOpts.disableAutoGenerate;
        const isValidValue = currentValue && isUuidFieldValue(currentValue, fieldOpts);

        if ((!currentValue || !isValidValue) && shouldAutoGenerate) {
          params.data[field] = await generateUniqueUuid(model.uid, field, fieldOpts.version, fieldOpts.prefix);
          log.debug(`[strapi-auto-uuid] Generated UUID for ${model.uid}.${field}`);
        } else if (currentValue && !isValidValue) {
          throw new ValidationError(
            `Invalid UUID format for field '${field}'`,
            { field }
          );
        } else if (currentValue && config.validateUniqueness) {
          const { exists, documentId: existingDocumentId } = await checkUuidExists(
            model.uid,
            field,
            currentValue
          );

          log.debug(`[strapi-auto-uuid] UUID uniqueness check for ${model.uid}.${field}: exists=${exists}`);

          if (exists) {
            if (currentDocumentId && existingDocumentId === currentDocumentId) {
              log.debug(`[strapi-auto-uuid] UUID belongs to same document, keeping it`);
            } else if (!currentDocumentId && existingDocumentId) {
              log.debug(`[strapi-auto-uuid] UUID exists, no documentId in params - keeping (likely publish)`);
            } else {
              log.info(
                `[strapi-auto-uuid] UUID collision on ${model.uid}.${field}, regenerating`
              );
              params.data[field] = await generateUniqueUuid(model.uid, field, fieldOpts.version, fieldOpts.prefix);
            }
          }
        }
      }
    },

    /**
     * Validates UUID updates and preserves immutable values except during an
     * explicitly scoped internal repair. If the target document cannot be
     * resolved, the write is rejected rather than bypassing those checks.
     */
    async beforeUpdate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];

      if (!uuidFields) return;

      const data = params.data || {};
      const fieldsBeingUpdated = uuidFields.filter(({ field }) => Object.hasOwn(data, field));
      if (fieldsBeingUpdated.length === 0) return;

      const documentId = await getDocumentIdFromWhere(model.uid, params.where);
      if (!documentId) {
        throw new ValidationError(
          'Unable to verify the target document for a UUID update. The update was rejected.'
        );
      }

      for (const { field, attribute } of fieldsBeingUpdated) {

        const newValue = data[field];
        const fieldOpts = getFieldOptions(attribute, model.uid, field);

        if (newValue !== null && newValue !== '' && !isUuidFieldValue(newValue, fieldOpts)) {
          throw new ValidationError(
            `Invalid UUID format for field '${field}'`,
            { field }
          );
        }

        if (!fieldOpts.allowEdit && !isUuidRepairContext()) {
          const currentRecord = await strapi.db.query(model.uid).findOne({
            where: { documentId },
            select: [field],
          });

          if (!currentRecord) {
            throw new ValidationError(
              `Unable to verify the existing value of immutable UUID field '${field}'`,
              { field }
            );
          }

          if (currentRecord[field] && currentRecord[field] !== newValue) {
            throw new ValidationError(
              `UUID field '${field}' is immutable. Enable manual editing in the field options to change it.`,
              { field }
            );
          }
        }

        if (newValue && config.validateUniqueness) {
          const exists = await isUuidExists(model.uid, field, newValue, documentId);

          if (exists) {
            throw new ValidationError(
              `UUID already exists for field '${field}'. Please use a unique value.`,
              { field }
            );
          }
        }
      }
    },
  });

  if (config.autoMigrate && modelsToSubscribe.length > 0) {
    const isProd = process.env.NODE_ENV === 'production';
    const prodGate = process.env.STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE === 'true';

    if (isProd && !prodGate) {
      strapi.log.error(
        '[strapi-auto-uuid] ⛔ autoMigrate refused in production. Set STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE=true to override.'
      );
      return;
    }

    strapi.log.warn('[strapi-auto-uuid] ⚠️  AUTO-MIGRATION ACTIVE — will rewrite UUIDs on boot');

    setImmediate(async () => {
      try {
        const migrations = strapi.plugin('field-uuid').service('migrations');
        const status = await migrations.checkMigrationStatus();

        if (status.needsMigration) {
          strapi.log.warn(`[strapi-auto-uuid] Found ${status.totalFields} field(s) with issues, running auto-fix...`);
          const result = await migrations.runMigration({ dryRun: false });
          if (!result || result.aborted || result.failed || result.errors?.length > 0) {
            const migrationState = result?.aborted ? 'aborted' : 'failed';
            strapi.log.error(`[strapi-auto-uuid] Auto-migration ${migrationState}; changes were not reported as completed.`);
            return;
          }
          strapi.log.warn(`[strapi-auto-uuid] Auto-migration completed: ${result.totalFixed} entries fixed`);
        } else {
          log.info('[strapi-auto-uuid] No migration needed, all UUIDs are valid');
        }
      } catch (err) {
        log.error(`[strapi-auto-uuid] Auto-migration failed (${err?.name || 'Error'})`);
      }
    });
  }
};

export default bootstrap;
