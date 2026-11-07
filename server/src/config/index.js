import { z } from 'zod';

/**
 * Plugin configuration for strapi-auto-uuid.
 *
 * Configure the plugin in `config/plugins.js` of the Strapi project:
 *
 * @example
 * module.exports = {
 *   'field-uuid': {
 *     enabled: true,
 *     config: {
 *       defaultVersion: 'v4', // 'v4' (random) or 'v7' (time-sortable)
 *       autoGenerate: true, // generate a value on create when the field is empty
 *       validateUniqueness: true, // reject or replace values used by another document
 *       autoMigrate: false, // repair empty, malformed and duplicate values on boot
 *       maxRetryAttempts: 3, // collision retries per generated value (1-10)
 *       logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
 *       // Where admin rate-limit counters live: 'auto' (database on PostgreSQL
 *       // and MySQL, memory on SQLite), 'database' (shared by all processes)
 *       // or 'memory' (per process).
 *       rateLimitStore: 'auto',
 *     },
 *   },
 * };
 */

export const PLUGIN_CONFIG_DEFAULTS = Object.freeze({
  defaultVersion: 'v4',
  autoGenerate: true,
  validateUniqueness: true,
  autoMigrate: false,
  maxRetryAttempts: 3,
  logLevel: 'info',
  rateLimitStore: 'auto',
});

/**
 * Strict schema for the plugin configuration. Unknown keys are rejected so a
 * typo such as `autoGenrate` fails at boot instead of being ignored.
 * `allowManualEdit` was documented in 1.x but never read; it is still
 * accepted so existing configurations keep booting, and it has no effect.
 * Editing is controlled by the per-field "Allow manual editing" option.
 */
export const pluginConfigSchema = z.strictObject({
  defaultVersion: z.enum(['v4', 'v7']).optional(),
  autoGenerate: z.boolean().optional(),
  validateUniqueness: z.boolean().optional(),
  autoMigrate: z.boolean().optional(),
  maxRetryAttempts: z.number().int().min(1).max(10).optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  rateLimitStore: z.enum(['auto', 'database', 'memory']).optional(),
  allowManualEdit: z.boolean().optional(),
});

/**
 * Validates raw plugin configuration and fills in defaults.
 *
 * @param {unknown} raw Value of `strapi.config.get('plugin::field-uuid')`.
 * @returns {{ defaultVersion: 'v4'|'v7', autoGenerate: boolean, validateUniqueness: boolean,
 *   autoMigrate: boolean, maxRetryAttempts: number, logLevel: 'debug'|'info'|'warn'|'error',
 *   rateLimitStore: 'auto'|'database'|'memory' }}
 * @throws {Error} When a key is unknown or a value has the wrong type or range.
 */
export function normalizePluginConfig(raw = {}) {
  const result = pluginConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.') || issue.keys?.join(', ') || '(root)';
    throw new Error(
      `[strapi-auto-uuid] Invalid plugin configuration at '${path}': ${issue.message}`
    );
  }
  const { allowManualEdit: _ignored, ...config } = result.data;
  return { ...PLUGIN_CONFIG_DEFAULTS, ...config };
}

/**
 * Reads and normalizes the plugin configuration from a Strapi instance.
 *
 * @param {{ config: { get: Function } }} strapi Strapi instance.
 * @returns {ReturnType<typeof normalizePluginConfig>} Normalized configuration.
 */
export function getPluginConfig(strapi) {
  return normalizePluginConfig(strapi.config.get('plugin::field-uuid', {}));
}

export default {
  default: { ...PLUGIN_CONFIG_DEFAULTS },

  /**
   * Called by Strapi with the merged plugin configuration.
   *
   * @param {unknown} config Merged configuration.
   * @throws {Error} When the configuration is invalid.
   */
  validator(config) {
    normalizePluginConfig(config);
  },
};
