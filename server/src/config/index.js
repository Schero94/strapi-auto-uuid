/**
 * Plugin Configuration Schema
 * 
 * Configure the UUID plugin behavior via config/plugins.js:
 * 
 * @example
 * // config/plugins.js
 * module.exports = {
 *   'field-uuid': {
 *     enabled: true,
 *     config: {
 *       // Default UUID version for new fields (v4 or v7)
 *       defaultVersion: 'v4',
 *       
 *       // Auto-generate UUIDs on create (default: true)
 *       autoGenerate: true,
 *       
 *       // Validate uniqueness before save (default: true)
 *       validateUniqueness: true,
 *       
 *       // Allow manual UUID editing in admin panel (default: false)
 *       allowManualEdit: false,
 *       
 *       // Run auto-migration on bootstrap (default: false)
 *       autoMigrate: false,
 *       
 *       // Log level: 'debug', 'info', 'warn', 'error' (default: 'info')
 *       logLevel: 'info',
 *     },
 *   },
 * };
 */
export default {
  default: {
    // Default UUID version - v4 is random, v7 is time-sortable
    defaultVersion: 'v4',
    
    // Auto-generate UUID when creating new entries
    autoGenerate: true,
    
    // Validate UUID uniqueness before saving
    validateUniqueness: true,
    
    // Allow users to manually edit UUIDs in admin panel
    allowManualEdit: false,
    
    // Automatically fix issues on server start (dangerous, use with caution)
    autoMigrate: false,
    
    // Maximum retry attempts for UUID collision
    maxRetryAttempts: 3,
    
    // Logging level
    logLevel: 'info',
  },
  
  /**
   * Validate plugin configuration
   * @param {Object} config - User-provided configuration
   */
  validator(config) {
    // Validate defaultVersion
    if (config.defaultVersion && !['v4', 'v7'].includes(config.defaultVersion)) {
      throw new Error(
        `[strapi-auto-uuid] Invalid defaultVersion: "${config.defaultVersion}". Must be "v4" or "v7".`
      );
    }
    
    // Validate maxRetryAttempts
    if (config.maxRetryAttempts !== undefined) {
      if (typeof config.maxRetryAttempts !== 'number' || config.maxRetryAttempts < 1) {
        throw new Error(
          `[strapi-auto-uuid] Invalid maxRetryAttempts: "${config.maxRetryAttempts}". Must be a positive number.`
        );
      }
    }
    
    // Validate logLevel
    if (config.logLevel && !['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
      throw new Error(
        `[strapi-auto-uuid] Invalid logLevel: "${config.logLevel}". Must be "debug", "info", "warn", or "error".`
      );
    }
    
    // Validate boolean options
    const booleanOptions = ['autoGenerate', 'validateUniqueness', 'allowManualEdit', 'autoMigrate'];
    for (const option of booleanOptions) {
      if (config[option] !== undefined && typeof config[option] !== 'boolean') {
        throw new Error(
          `[strapi-auto-uuid] Invalid ${option}: "${config[option]}". Must be a boolean.`
        );
      }
    }
  },
};
