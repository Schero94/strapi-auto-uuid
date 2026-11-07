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
const PRIVATE_REPORT_KEYS = new Set([
  'documentid',
  'documentids',
  'uuid',
  'olduuid',
  'newuuid',
  'oldvalue',
  'newvalue',
  'keptdocumentid',
  'value',
]);

/**
 * Removes record identifiers and stored UUID values from administrative
 * diagnostic and repair reports. The permissioned export endpoint does not
 * use this helper because its purpose is to export those mappings.
 *
 * @param {unknown} value Service report or nested report value.
 * @returns {unknown} A recursively redacted report.
 */
export function sanitizeUuidAdminReport(value) {
  if (Array.isArray(value)) return value.map(sanitizeUuidAdminReport);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_REPORT_KEYS.has(key.toLowerCase()))
      .map(([key, nested]) => [key, sanitizeUuidAdminReport(nested)])
  );
}

const logFailureType = (error) => error?.name || 'Error';

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
      strapi.log.error(`[strapi-auto-uuid] Duplicate check failed (${logFailureType(error)})`);
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
      ctx.body = sanitizeUuidAdminReport(report);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Diagnosis failed (${logFailureType(error)})`);
      throw new ApplicationError('Diagnosis failed. Refresh the page and check field configuration before retrying.');
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

      ctx.body = sanitizeUuidAdminReport(report);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Auto-fix failed (${logFailureType(error)})`);
      throw new ApplicationError('Auto-fix failed. No changes were kept. Refresh the scan before retrying.');
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

      ctx.body = sanitizeUuidAdminReport(report);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Missing UUID generation failed (${logFailureType(error)})`);
      throw new ApplicationError('UUID generation failed. No changes were kept. Refresh the scan before retrying.');
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
      strapi.log.error(`[strapi-auto-uuid] Model list failed (${logFailureType(error)})`);
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
      ctx.body = sanitizeUuidAdminReport(status);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Migration status failed (${logFailureType(error)})`);
      throw new ApplicationError('Migration status could not be checked. No repairs were attempted. Refresh and retry.');
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

      ctx.body = sanitizeUuidAdminReport(result);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Migration failed (${logFailureType(error)})`);
      throw new ApplicationError('Migration failed. No changes were kept. Refresh the scan and retry.');
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
      strapi.log.error(`[strapi-auto-uuid] Export failed (${logFailureType(error)})`);
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

      ctx.body = sanitizeUuidAdminReport(result);
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Import failed (${logFailureType(error)})`);
      throw new ApplicationError('Import failed. No changes were kept. Check the mapping and field configuration, then retry.');
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
        hasErrors: migrationStatus.hasErrors,
        models,
        version: PLUGIN_VERSION,
        lastChecked: new Date().toISOString(),
      };

      ctx.body = stats;
    } catch (error) {
      strapi.log.error(`[strapi-auto-uuid] Statistics failed (${logFailureType(error)})`);
      throw new ApplicationError('UUID statistics could not be loaded. Refresh the page and retry.');
    }
  },
});

export default controller;
