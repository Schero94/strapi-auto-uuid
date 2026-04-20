import * as uuidLib from 'uuid';

const { v4: uuidv4, validate: validateUuid } = uuidLib;
const uuidv7 = uuidLib.v7 || uuidv4;
import { errors } from '@strapi/utils';

const { ValidationError, ApplicationError } = errors;

const PREFIX_REGEX = /^[a-zA-Z0-9_-]{1,16}$/;

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
    strapi.log.error('[strapi-auto-uuid] Failed to register plugin permissions:', err.message);
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

  await registerPluginPermissions(strapi);

  /**
   * @param {string} version - 'v4' or 'v7'
   * @param {string} [prefix] - optional prefix string (validated upstream)
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
   * Reads per-field CTB options. Untrusted prefixes from CTB are validated
   * against PREFIX_REGEX to prevent smuggling of HTML, SQL, or other
   * content that could end up in API responses and downstream frontends.
   * @param {Object} attribute - Content type attribute definition
   * @param {string} modelUid - Content type UID (for logging)
   * @param {string} fieldName - Attribute name (for logging)
   */
  const getFieldOptions = (attribute, modelUid, fieldName) => {
    const opts = attribute?.options || {};
    const rawPrefix = opts['uuid-prefix'] || '';
    let prefix = '';
    if (rawPrefix) {
      if (PREFIX_REGEX.test(rawPrefix)) {
        prefix = rawPrefix;
      } else {
        strapi.log.warn(
          `[strapi-auto-uuid] Invalid prefix "${rawPrefix}" on ${modelUid}.${fieldName} (must match ${PREFIX_REGEX}) – ignored.`
        );
      }
    }
    return {
      version: opts['uuid-version'] || config.defaultVersion,
      prefix,
      disableAutoGenerate: opts['disable-auto-generate'] === true,
      allowEdit: opts['allow-edit'] === true,
    };
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
   * Checks if a UUID already exists in the database across BOTH draft and
   * published rows (uses db.query to bypass the draft-only default scope).
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

  const isUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    const result = await checkUuidExists(uid, field, uuid, excludeDocumentId);
    return result.exists;
  };

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

    async beforeCreate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];

      if (!uuidFields) return;

      const currentDocumentId = params.data?.documentId || params.where?.documentId;

      log.debug(`[strapi-auto-uuid] beforeCreate for ${model.uid}, documentId: ${currentDocumentId || 'none'}`);

      for (const { field, attribute } of uuidFields) {
        const fieldOpts = getFieldOptions(attribute, model.uid, field);
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
                `[strapi-auto-uuid] UUID collision on ${model.uid}.${field}, regenerating`
              );
              params.data[field] = await generateUniqueUuid(model.uid, field, fieldOpts.version, fieldOpts.prefix);
            }
          }
        }
      }
    },

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
            `Invalid UUID format for field '${field}'`,
            { field }
          );
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
          strapi.log.warn(`[strapi-auto-uuid] Auto-migration completed: ${result.totalFixed} entries fixed`);
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
