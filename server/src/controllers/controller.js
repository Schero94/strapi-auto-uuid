import { errors } from '@strapi/utils';

const { ValidationError } = errors;

const PLUGIN_VERSION = '1.1.0';

/**
 * UUID Plugin Controller
 *
 * Provides endpoints for health check, UUID validation, diagnosis, auto-fix,
 * migration support, and statistics. All destructive endpoints require admin auth.
 */
const controller = ({ strapi }) => ({
  /**
   * @route GET /field-uuid/health
   * @returns {{ status, plugin, version, message }}
   */
  async index(ctx) {
    ctx.body = {
      status: 'ok',
      plugin: 'field-uuid',
      version: PLUGIN_VERSION,
      message: 'Strapi Auto UUID Plugin is running',
    };
  },

  /**
   * @route POST /field-uuid/check-duplicate
   * @body {{ contentType: string, field: string, uuid: string, excludeDocumentId?: string }}
   * @returns {{ exists: boolean, valid: boolean }}
   * @throws {ValidationError} If input is missing or invalid
   */
  async checkDuplicate(ctx) {
    const { contentType, field, uuid, excludeDocumentId } = ctx.request.body;

    if (!contentType || !field || !uuid) {
      throw new ValidationError('Missing required parameters: contentType, field, uuid');
    }

    const serviceInstance = strapi.plugin('field-uuid').service('service');
    const validation = serviceInstance.validateUuidField(contentType, field);
    if (!validation.valid) {
      throw new ValidationError(validation.error);
    }

    try {
      const result = await serviceInstance.checkDuplicate({
        contentType,
        field,
        uuid,
        excludeDocumentId,
      });

      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error checking duplicate:', error);
      throw new errors.ApplicationError('Failed to check UUID duplicate');
    }
  },

  /**
   * @route GET /field-uuid/diagnose
   * @returns {Object} Diagnosis report
   */
  async diagnose(ctx) {
    try {
      const report = await strapi.plugin('field-uuid').service('service').diagnose();
      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error during diagnosis:', error);
      throw new errors.ApplicationError('Failed to diagnose UUIDs');
    }
  },

  /**
   * @route POST /field-uuid/autofix
   * @body {{ dryRun?: boolean }}
   * @returns {Object} Fix report
   */
  async autofix(ctx) {
    const { dryRun = false } = ctx.request.body || {};

    if (typeof dryRun !== 'boolean') {
      throw new ValidationError('dryRun must be a boolean');
    }

    try {
      const report = await strapi.plugin('field-uuid').service('service').autofix({ dryRun });

      if (!dryRun && report.totalFixed > 0) {
        strapi.log.info(`[strapi-auto-uuid] Auto-fix completed: ${report.totalFixed} duplicate(s) fixed`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error during auto-fix:', error);
      throw new errors.ApplicationError('Failed to auto-fix UUIDs');
    }
  },

  /**
   * @route POST /field-uuid/generate-missing
   * @body {{ dryRun?: boolean }}
   * @returns {Object} Generation report
   */
  async generateMissing(ctx) {
    const { dryRun = false } = ctx.request.body || {};

    if (typeof dryRun !== 'boolean') {
      throw new ValidationError('dryRun must be a boolean');
    }

    try {
      const report = await strapi.plugin('field-uuid').service('service').generateMissing({ dryRun });

      if (!dryRun && report.totalGenerated > 0) {
        strapi.log.info(`[strapi-auto-uuid] Generated ${report.totalGenerated} missing UUID(s)`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error generating missing UUIDs:', error);
      throw new errors.ApplicationError('Failed to generate missing UUIDs');
    }
  },

  /**
   * @route GET /field-uuid/models
   * @returns {{ models: Object }}
   */
  async getModels(ctx) {
    try {
      const models = strapi.plugin('field-uuid').service('service').getUuidModels();
      ctx.body = { models };
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error getting models:', error);
      throw new errors.ApplicationError('Failed to get UUID models');
    }
  },

  /**
   * @route GET /field-uuid/migration/status
   * @returns {Object} Migration status
   */
  async getMigrationStatus(ctx) {
    try {
      const status = await strapi.plugin('field-uuid').service('migrations').checkMigrationStatus();
      ctx.body = status;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error checking migration status:', error);
      throw new errors.ApplicationError('Failed to check migration status');
    }
  },

  /**
   * @route POST /field-uuid/migration/run
   * @body {{ dryRun?: boolean, fixEmpty?: boolean, fixInvalid?: boolean, fixDuplicates?: boolean }}
   * @returns {Object} Migration result
   */
  async runMigration(ctx) {
    const {
      dryRun = true,
      fixEmpty = true,
      fixInvalid = true,
      fixDuplicates = true,
    } = ctx.request.body || {};

    if (typeof dryRun !== 'boolean' || typeof fixEmpty !== 'boolean' ||
        typeof fixInvalid !== 'boolean' || typeof fixDuplicates !== 'boolean') {
      throw new ValidationError('All options must be booleans');
    }

    try {
      const result = await strapi.plugin('field-uuid').service('migrations').runMigration({
        dryRun,
        fixEmpty,
        fixInvalid,
        fixDuplicates,
      });

      if (!dryRun && result.totalFixed > 0) {
        strapi.log.info(`[strapi-auto-uuid] Migration completed: ${result.totalFixed} entries fixed`);
      }

      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error running migration:', error);
      throw new errors.ApplicationError('Failed to run migration');
    }
  },

  /**
   * @route GET /field-uuid/migration/export
   * @returns {Object} Export data (JSON download)
   */
  async exportMappings(ctx) {
    try {
      const exportData = await strapi.plugin('field-uuid').service('migrations').exportMappings();

      ctx.set('Content-Type', 'application/json');
      ctx.set('Content-Disposition', `attachment; filename="uuid-mappings-${Date.now()}.json"`);
      ctx.body = exportData;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error exporting mappings:', error);
      throw new errors.ApplicationError('Failed to export UUID mappings');
    }
  },

  /**
   * @route POST /field-uuid/migration/import
   * @body {{ mappings: Object, dryRun?: boolean, overwrite?: boolean }}
   * @returns {Object} Import result
   */
  async importMappings(ctx) {
    const { mappings, dryRun = true, overwrite = false } = ctx.request.body || {};

    if (!mappings || typeof mappings !== 'object') {
      throw new ValidationError('Missing or invalid required parameter: mappings');
    }

    if (typeof dryRun !== 'boolean' || typeof overwrite !== 'boolean') {
      throw new ValidationError('dryRun and overwrite must be booleans');
    }

    try {
      const result = await strapi.plugin('field-uuid').service('migrations').importMappings(
        mappings,
        { dryRun, overwrite }
      );
      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error importing mappings:', error);
      throw new errors.ApplicationError('Failed to import UUID mappings');
    }
  },

  /**
   * @route GET /field-uuid/stats
   * @returns {Object} Comprehensive statistics
   */
  async getStats(ctx) {
    try {
      const models = strapi.plugin('field-uuid').service('service').getUuidModels();
      const migrationStatus = await strapi.plugin('field-uuid').service('migrations').checkMigrationStatus();

      const stats = {
        contentTypes: Object.keys(models).length,
        totalFields: Object.values(models).reduce((sum, fields) => sum + fields.length, 0),
        totalEntries: migrationStatus.totalEntries,
        issues: {
          empty: migrationStatus.contentTypes.reduce((sum, ct) => sum + (ct.emptyCount || 0), 0),
          invalid: migrationStatus.contentTypes.reduce((sum, ct) => sum + (ct.invalidCount || 0), 0),
          duplicates: migrationStatus.contentTypes.reduce((sum, ct) => sum + (ct.duplicateCount || 0), 0),
        },
        needsMigration: migrationStatus.needsMigration,
        models,
        version: PLUGIN_VERSION,
        lastChecked: new Date().toISOString(),
      };

      ctx.body = stats;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error getting stats:', error);
      throw new errors.ApplicationError('Failed to get UUID statistics');
    }
  },
});

export default controller;
