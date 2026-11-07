import { normalizePluginConfig } from './config/index.js';
import { createUuidLifecycles } from './lifecycles/uuid-lifecycles.js';
import { findComponentUuidFields, getUuidModels } from './utils/uuid-models.js';
import { prepareClusterLocks } from './utils/cluster-lock.js';
import { prepareRateLimitStore } from './utils/rate-limit-store.js';
import { resolveUuidFieldOptions } from '../../shared/uuid-field.js';

/**
 * RBAC actions of the plugin. Admin routes check them with
 * `admin::hasPermissions`; the settings link and page use them for visibility.
 */
export const PLUGIN_ACTIONS = [
  {
    section: 'plugins',
    displayName: 'Read UUID status and diagnostics',
    uid: 'read',
    pluginName: 'field-uuid',
  },
  {
    section: 'plugins',
    displayName: 'Repair UUIDs (replace duplicates and malformed values, fill empty fields)',
    uid: 'migrate',
    pluginName: 'field-uuid',
  },
  {
    section: 'plugins',
    displayName: 'Export all UUID mappings of every content type',
    uid: 'export',
    pluginName: 'field-uuid',
  },
  {
    section: 'plugins',
    displayName: 'Import UUID mappings into empty fields',
    uid: 'import',
    pluginName: 'field-uuid',
  },
];

/**
 * Registers the plugin RBAC actions.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {Promise<void>}
 */
const registerPluginPermissions = async (strapi) => {
  try {
    await strapi.admin?.services?.permission?.actionProvider?.registerMany?.(PLUGIN_ACTIONS);
  } catch (err) {
    strapi.log.error(
      `[strapi-auto-uuid] Failed to register plugin permissions (${err?.name || 'Error'})`
    );
  }
};

/**
 * Creates a logger that honours the plugin `logLevel`.
 *
 * @param {Object} strapi Strapi instance.
 * @param {'debug'|'info'|'warn'|'error'} level Configured level.
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export const createLogger = (strapi, level) => {
  const order = ['debug', 'info', 'warn', 'error'];
  const enabled = (target) => order.indexOf(target) >= order.indexOf(level);
  return {
    debug: (message) => enabled('debug') && strapi.log.debug(message),
    info: (message) => enabled('info') && strapi.log.info(message),
    warn: (message) => enabled('warn') && strapi.log.warn(message),
    error: (message) => strapi.log.error(message),
  };
};

/**
 * Plugin bootstrap: registers RBAC actions, prepares the shared rate-limit
 * store and cross-process locks, subscribes the UUID lifecycle hooks for
 * every content type with a UUID field and, when enabled, runs the boot-time
 * repair.
 *
 * The boot repair runs in every process that boots, but only one at a time
 * does work: the repair takes the cross-process repair lock without waiting,
 * and a process that finds it taken skips its run.
 *
 * @param {{ strapi: Object }} context Strapi context.
 * @returns {Promise<void>}
 * @throws {Error} When the plugin configuration is invalid.
 */
const bootstrap = async ({ strapi }) => {
  const config = normalizePluginConfig(strapi.config.get('plugin::field-uuid', {}));
  const log = createLogger(strapi, config.logLevel);

  // Reject an invalid plugin default before hooks could generate other versions.
  resolveUuidFieldOptions({}, config.defaultVersion);

  await registerPluginPermissions(strapi);

  // Shared state for several processes (replicas, pm2 workers) on one
  // database: rate-limit counters and, on MySQL, the lock table.
  const rateLimitStore = await prepareRateLimitStore(strapi, config.rateLimitStore, log);
  const clusterLocks = await prepareClusterLocks(strapi, log);
  log.debug(
    `[strapi-auto-uuid] Rate-limit store: ${rateLimitStore}; cross-process locks: ${clusterLocks ? 'on' : 'off'}`
  );

  const fieldNames = getUuidModels(strapi);
  const models = Object.fromEntries(
    Object.entries(fieldNames).map(([uid, fields]) => [
      uid,
      fields.map((field) => ({ field, attribute: strapi.contentTypes[uid].attributes[field] })),
    ])
  );

  const componentFields = findComponentUuidFields(strapi);
  if (componentFields.length > 0) {
    strapi.log.warn(
      `[strapi-auto-uuid] UUID fields inside components are filled by the admin panel only; the server does not generate, validate or repair them: ${componentFields.join(', ')}. Use a content-type field when duplicates must be rejected.`
    );
  }

  const uids = Object.keys(models);
  if (uids.length === 0) return;

  log.info(`[strapi-auto-uuid] Managing UUID fields in ${uids.length} content type(s)`);
  strapi.db.lifecycles.subscribe(createUuidLifecycles({ strapi, models, config, log }));

  if (!config.autoMigrate) return;

  const isProd = process.env.NODE_ENV === 'production';
  const prodGate = process.env.STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE === 'true';
  if (isProd && !prodGate) {
    strapi.log.error(
      '[strapi-auto-uuid] autoMigrate is refused in production. Set STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE=true to allow it.'
    );
    return;
  }

  strapi.log.warn(
    '[strapi-auto-uuid] autoMigrate is on: empty, malformed and duplicate UUIDs are repaired on boot. Values in an older version or prefix are kept.'
  );

  setImmediate(async () => {
    try {
      const migrations = strapi.plugin('field-uuid').service('migrations');
      const result = await migrations.runMigration({
        dryRun: false,
        fixEmpty: true,
        fixInvalid: true,
        fixDuplicates: true,
        fixLegacy: false,
      });
      if (!result || result.aborted || result.failed || result.errors?.length > 0) {
        strapi.log.error(
          `[strapi-auto-uuid] Boot repair ${result?.aborted ? 'aborted' : 'failed'}; no changes were kept.`
        );
        return;
      }
      if (result.totalFixed > 0) {
        strapi.log.warn(`[strapi-auto-uuid] Boot repair fixed ${result.totalFixed} document(s)`);
      } else {
        log.info('[strapi-auto-uuid] Boot repair: nothing to fix');
      }
    } catch (err) {
      if (err?.code === 'REPAIR_IN_PROGRESS') {
        log.info('[strapi-auto-uuid] Boot repair skipped: a repair is running on another instance');
        return;
      }
      strapi.log.error(`[strapi-auto-uuid] Boot repair failed (${err?.name || 'Error'})`);
    }
  });
};

export default bootstrap;
