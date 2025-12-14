'use strict';

import * as uuidLib from 'uuid';

const { v4: uuidv4, validate: validateUuid } = uuidLib;
// UUID v7 requires uuid package v9.0.0+, fallback to v4 if not available
const uuidv7 = uuidLib.v7 || uuidv4;
import { errors } from '@strapi/utils';

const { ValidationError, ApplicationError } = errors;

/**
 * Bootstrap - Lifecycle Hooks for UUID Auto-Generation
 * 
 * This subscribes to the database lifecycle events and automatically
 * generates UUID values for fields using the 'uuid' custom field.
 * 
 * Features:
 * - Auto-generates UUID v4 or v7 on create if empty
 * - Validates uniqueness against database before saving
 * - Retry logic for collision handling (configurable)
 * - Prevents duplicate UUIDs on update
 * - Respects plugin configuration
 * 
 * Works for both Admin Panel and API/GraphQL requests.
 */
const bootstrap = ({ strapi }) => {
  const { contentTypes } = strapi;
  
  // Get plugin configuration
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
   * Generates a new UUID based on configured version
   * @param {string} version - UUID version ('v4' or 'v7')
   * @returns {string} Generated UUID
   */
  const generateUuid = (version = config.defaultVersion) => {
    return version === 'v7' ? uuidv7() : uuidv4();
  };
  
  /**
   * Logging helper that respects configured log level
   */
  const log = {
    debug: (...args) => config.logLevel === 'debug' && strapi.log.debug(...args),
    info: (...args) => ['debug', 'info'].includes(config.logLevel) && strapi.log.info(...args),
    warn: (...args) => ['debug', 'info', 'warn'].includes(config.logLevel) && strapi.log.warn(...args),
    error: (...args) => strapi.log.error(...args),
  };
  
  /**
   * Finds all content types that use the uuid custom field
   * @returns {Object} Map of content type UIDs to their UUID field names
   */
  const findUuidModels = () => {
    return Object.keys(contentTypes).reduce((acc, key) => {
      const contentType = contentTypes[key];
      
      // Only process api content types (not plugins, admin, etc.)
      if (!key.startsWith('api')) return acc;
      
      // Find all attributes that use our uuid custom field
      const uuidAttributes = Object.keys(contentType.attributes).filter((attrKey) => {
        const attribute = contentType.attributes[attrKey];
        return attribute.customField === 'plugin::field-uuid.uuid';
      });
      
      if (uuidAttributes.length > 0) {
        return { ...acc, [key]: uuidAttributes };
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
   * Checks if a UUID already exists in the database for a given content type and field.
   * Uses Document Service API (strapi.documents) as per Strapi v5 best practices.
   * @param {string} uid - Content type UID (e.g., 'api::article.article')
   * @param {string} field - Field name containing the UUID
   * @param {string} uuid - UUID value to check
   * @param {string|null} excludeDocumentId - Optional documentId to exclude from check (for updates)
   * @returns {Promise<{exists: boolean, documentId: string|null}>} Result with exists flag and documentId if found
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
      documentId: existing?.documentId || null 
    };
  };
  
  /**
   * Simple check if UUID exists (backwards compatible)
   */
  const isUuidExists = async (uid, field, uuid, excludeDocumentId = null) => {
    const result = await checkUuidExists(uid, field, uuid, excludeDocumentId);
    return result.exists;
  };

  /**
   * Generates a unique UUID with retry logic for collision handling
   * @param {string} uid - Content type UID
   * @param {string} field - Field name
   * @returns {Promise<string>} Unique UUID
   * @throws {ApplicationError} If unable to generate unique UUID after max attempts
   */
  const generateUniqueUuid = async (uid, field) => {
    for (let attempt = 0; attempt < config.maxRetryAttempts; attempt++) {
      const newUuid = generateUuid();
      
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
   * Retrieves the documentId of an entity being updated from lifecycle event params
   * @param {string} uid - Content type UID
   * @param {Object} where - The where clause from lifecycle params
   * @returns {Promise<string|null>} The documentId or null if not found
   */
  const getDocumentIdFromWhere = async (uid, where) => {
    if (!where) return null;
    
    if (where.documentId) {
      return where.documentId;
    }
    
    if (where.id) {
      const entity = await strapi.documents(uid).findFirst({
        filters: { id: where.id },
        fields: ['documentId'],
      });
      return entity?.documentId || null;
    }
    
    return null;
  };
  
  // Subscribe to lifecycle events
  strapi.db.lifecycles.subscribe({
    models: modelsToSubscribe,

    /**
     * Before Create Hook - Generates UUID if empty or invalid, validates uniqueness
     * @param {Object} event - Lifecycle event object
     */
    async beforeCreate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];
      
      if (!uuidFields) return;
      
      // In Strapi v5, documentId might be in params.data or we need to check if UUID belongs to same document
      // For publish operations, the documentId is typically passed through
      const currentDocumentId = params.data?.documentId || params.where?.documentId;
      
      log.debug(`[strapi-auto-uuid] beforeCreate for ${model.uid}, documentId: ${currentDocumentId || 'none'}`);
      
      for (const field of uuidFields) {
        const currentValue = params.data[field];
        
        // Auto-generate if empty/invalid and autoGenerate is enabled
        if ((!currentValue || !validateUuid(currentValue)) && config.autoGenerate) {
          params.data[field] = await generateUniqueUuid(model.uid, field);
          log.debug(`[strapi-auto-uuid] Generated UUID for ${model.uid}.${field}`);
        } else if (currentValue && config.validateUniqueness) {
          // Check if UUID already exists and get the documentId it belongs to
          const { exists, documentId: existingDocumentId } = await checkUuidExists(
            model.uid, 
            field, 
            currentValue
          );
          
          log.debug(`[strapi-auto-uuid] UUID check: exists=${exists}, existingDocId=${existingDocumentId}, currentDocId=${currentDocumentId}`);
          
          if (exists) {
            // If the UUID belongs to the same document (publish operation), keep it
            // Also keep it if we have no currentDocumentId but UUID exists - likely a publish
            // In Strapi v5, publish doesn't always pass documentId to beforeCreate
            if (currentDocumentId && existingDocumentId === currentDocumentId) {
              log.debug(
                `[strapi-auto-uuid] UUID '${currentValue}' belongs to same document, keeping it`
              );
              // Keep the existing UUID - this is a publish operation
            } else if (!currentDocumentId && existingDocumentId) {
              // No currentDocumentId in params but UUID exists - this is likely a publish operation
              // We should keep the UUID to avoid breaking publish functionality
              // Only generate new UUID if explicitly duplicating (which would have different data)
              log.debug(
                `[strapi-auto-uuid] UUID '${currentValue}' exists, no documentId in params - keeping it (likely publish)`
              );
              // Keep the existing UUID
            } else {
              // This is a duplicated entry - has a different documentId
              log.info(
                `[strapi-auto-uuid] UUID '${currentValue}' already exists for ${model.uid}.${field}, generating new one`
              );
              params.data[field] = await generateUniqueUuid(model.uid, field);
            }
          }
        }
      }
    },

    /**
     * Before Update Hook - Validates UUID changes don't create duplicates
     * @param {Object} event - Lifecycle event object
     */
    async beforeUpdate(event) {
      const { model, params } = event;
      const uuidFields = models[model.uid];
      
      if (!uuidFields) return;
      
      const documentId = await getDocumentIdFromWhere(model.uid, params.where);
      if (!documentId) return;
      
      for (const field of uuidFields) {
        if (params.data[field] === undefined) continue;
        
        const newValue = params.data[field];
        
        // Validate UUID format
        if (newValue && !validateUuid(newValue)) {
          throw new ValidationError(
            `Invalid UUID format for field '${field}': '${newValue}'`,
            { field, uuid: newValue }
          );
        }
        
        // Validate uniqueness if enabled
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
  
  // Run auto-migration if enabled
  if (config.autoMigrate && modelsToSubscribe.length > 0) {
    log.info('[strapi-auto-uuid] Auto-migration enabled, checking for issues...');
    
    // Run migration asynchronously after bootstrap
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
