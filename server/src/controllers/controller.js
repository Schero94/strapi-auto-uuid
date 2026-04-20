import { errors } from '@strapi/utils';
import {
  checkDuplicateSchema,
  dryRunOnlySchema,
  migrationRunSchema,
  importMappingsSchema,
  parseBody,
} from './validation';

const { ValidationError, ApplicationError } = errors;

const PLUGIN_VERSION = '1.1.0';

/**
 * UUID Plugin Controller
 *
 * Provides endpoints for health check, UUID validation, diagnosis, auto-fix,
 * migration support, and statistics. All destructive endpoints require admin auth.
 * All request bodies are validated with Zod before hitting services.
 */
const controller = ({ strapi }) => ({
  /**
   * @route GET /field-uuid/health
   * @returns {{ status, plugin, message }}
   */
  async index(ctx) {
    ctx.body = {
      status: 'ok',
      plugin: 'field-uuid',
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
    const { contentType, field, uuid, excludeDocumentId } = parseBody(
      checkDuplicateSchema,
      ctx.request.body
    );

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
      throw new ApplicationError('Failed to check UUID duplicate');
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
      throw new ApplicationError('Failed to diagnose UUIDs');
    }
  },

  /**
   * @route POST /field-uuid/autofix
   * @body {{ dryRun?: boolean }}
   * @returns {Object} Fix report
   */
  async autofix(ctx) {
    const { dryRun } = parseBody(dryRunOnlySchema, ctx.request.body);
    const actor = ctx.state?.user?.id ?? 'unknown';

    try {
      const report = await strapi.plugin('field-uuid').service('service').autofix({ dryRun });

      if (!dryRun && report.totalFixed > 0) {
        strapi.log.warn(`[strapi-auto-uuid] AUDIT autofix by admin:${actor} — fixed=${report.totalFixed}`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error during auto-fix:', error);
      throw new ApplicationError('Failed to auto-fix UUIDs');
    }
  },

  /**
   * @route POST /field-uuid/generate-missing
   * @body {{ dryRun?: boolean }}
   * @returns {Object} Generation report
   */
  async generateMissing(ctx) {
    const { dryRun } = parseBody(dryRunOnlySchema, ctx.request.body);
    const actor = ctx.state?.user?.id ?? 'unknown';

    try {
      const report = await strapi.plugin('field-uuid').service('service').generateMissing({ dryRun });

      if (!dryRun && report.totalGenerated > 0) {
        strapi.log.warn(`[strapi-auto-uuid] AUDIT generate-missing by admin:${actor} — generated=${report.totalGenerated}`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error generating missing UUIDs:', error);
      throw new ApplicationError('Failed to generate missing UUIDs');
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
      throw new ApplicationError('Failed to get UUID models');
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
      throw new ApplicationError('Failed to check migration status');
    }
  },

  /**
   * @route POST /field-uuid/migration/run
   * @body {{ dryRun?: boolean, fixEmpty?: boolean, fixInvalid?: boolean, fixDuplicates?: boolean }}
   * @returns {Object} Migration result
   */
  async runMigration(ctx) {
    const { dryRun, fixEmpty, fixInvalid, fixDuplicates } = parseBody(
      migrationRunSchema,
      ctx.request.body
    );
    const actor = ctx.state?.user?.id ?? 'unknown';

    try {
      const result = await strapi.plugin('field-uuid').service('migrations').runMigration({
        dryRun,
        fixEmpty,
        fixInvalid,
        fixDuplicates,
      });

      if (!dryRun && result.totalFixed > 0) {
        strapi.log.warn(
          `[strapi-auto-uuid] AUDIT migration by admin:${actor} — fixed=${result.totalFixed} (empty=${result.fixed.empty}, invalid=${result.fixed.invalid}, duplicates=${result.fixed.duplicates})`
        );
      }

      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error running migration:', error);
      throw new ApplicationError('Failed to run migration');
    }
  },

  /**
   * @route GET /field-uuid/migration/export
   * @returns {Object} Export data (JSON download)
   */
  async exportMappings(ctx) {
    const actor = ctx.state?.user?.id ?? 'unknown';
    try {
      const exportData = await strapi.plugin('field-uuid').service('migrations').exportMappings();
      strapi.log.warn(`[strapi-auto-uuid] AUDIT export by admin:${actor}`);

      ctx.set('Content-Type', 'application/json');
      ctx.set('Content-Disposition', `attachment; filename="uuid-mappings-${Date.now()}.json"`);
      ctx.body = exportData;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error exporting mappings:', error);
      throw new ApplicationError('Failed to export UUID mappings');
    }
  },

  /**
   * @route POST /field-uuid/migration/import
   * @body {{ mappings: Object, dryRun?: boolean, overwrite?: boolean }}
   * @returns {Object} Import result
   */
  async importMappings(ctx) {
    const { mappings, dryRun, overwrite } = parseBody(importMappingsSchema, ctx.request.body);
    const actor = ctx.state?.user?.id ?? 'unknown';

    try {
      const result = await strapi.plugin('field-uuid').service('migrations').importMappings(
        mappings,
        { dryRun, overwrite, actor }
      );

      if (!dryRun && result.imported > 0) {
        strapi.log.warn(
          `[strapi-auto-uuid] AUDIT import by admin:${actor} — imported=${result.imported} overwrite=${overwrite}`
        );
      }

      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error importing mappings:', error);
      throw new ApplicationError('Failed to import UUID mappings');
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
      throw new ApplicationError('Failed to get UUID statistics');
    }
  },
});

export default controller;
