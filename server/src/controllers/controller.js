import { errors } from '@strapi/utils';
import pkg from '../../../package.json';
import {
  dryRunOnlySchema,
  importMappingsSchema,
  migrationRunSchema,
  parseBody,
} from './validation';

const { ApplicationError } = errors;

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
  'changes',
]);

/**
 * Removes record identifiers and stored UUID values from diagnostic and
 * repair reports. The export endpoint does not use this helper because its
 * purpose is to return those mappings.
 *
 * @param {unknown} value Report or nested value.
 * @returns {unknown} Recursively redacted copy.
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
const actorOf = (ctx) => ctx.state?.user?.id ?? 'unknown';

/**
 * Answers 409 when another repair or import holds the process lock.
 *
 * @param {Object} ctx Koa context.
 * @param {Error} error Caught error.
 * @returns {boolean} True when the response was set.
 */
const respondConflict = (ctx, error) => {
  if (error?.code !== 'REPAIR_IN_PROGRESS') return false;
  ctx.status = 409;
  ctx.body = {
    data: null,
    error: {
      status: 409,
      name: 'ConflictError',
      message: error.message,
      details: { code: 'REPAIR_IN_PROGRESS' },
    },
  };
  return true;
};

/**
 * Admin controller. Routes are declared in routes/admin-api.js; every route
 * requires an authenticated administrator and, except /health, a plugin
 * permission. Bodies are validated with zod. Responses never contain stack
 * traces, database errors or (except export) record identifiers and values.
 *
 * @param {{ strapi: Object }} context Strapi context.
 */
const controller = ({ strapi }) => {
  const service = () => strapi.plugin('field-uuid').service('service');
  const migrations = () => strapi.plugin('field-uuid').service('migrations');

  return {
    /**
     * @route GET /field-uuid/health
     * @auth admin
     * @returns {{ status: string, plugin: string }}
     */
    async index(ctx) {
      ctx.body = { status: 'ok', plugin: 'field-uuid' };
    },

    /**
     * @route GET /field-uuid/diagnose
     * @access plugin::field-uuid.read
     * @returns {Object} Redacted diagnosis report.
     * @throws {ApplicationError} When the scan fails.
     */
    async diagnose(ctx) {
      try {
        ctx.body = sanitizeUuidAdminReport(await service().diagnose());
      } catch (error) {
        strapi.log.error(`[strapi-auto-uuid] Diagnosis failed (${logFailureType(error)})`);
        throw new ApplicationError('The check failed. Refresh the page and try again.');
      }
    },

    /**
     * @route POST /field-uuid/autofix
     * @access plugin::field-uuid.migrate
     * @body {{ dryRun?: boolean }}
     * @returns {Object} Redacted repair result.
     * @sideeffect Replaces duplicate UUIDs when dryRun is false.
     */
    async autofix(ctx) {
      const { dryRun } = parseBody(dryRunOnlySchema, ctx.request.body);
      try {
        const report = await service().autofix({ dryRun });
        if (!dryRun && report.totalFixed > 0) {
          strapi.log.warn(
            `[strapi-auto-uuid] AUDIT duplicate repair by admin:${actorOf(ctx)} fixed=${report.totalFixed}`
          );
        }
        ctx.body = sanitizeUuidAdminReport(report);
      } catch (error) {
        if (respondConflict(ctx, error)) return;
        strapi.log.error(`[strapi-auto-uuid] Duplicate repair failed (${logFailureType(error)})`);
        throw new ApplicationError('The repair failed. No changes were kept.');
      }
    },

    /**
     * @route POST /field-uuid/generate-missing
     * @access plugin::field-uuid.migrate
     * @body {{ dryRun?: boolean }}
     * @returns {Object} Redacted repair result.
     * @sideeffect Fills empty UUID fields when dryRun is false.
     */
    async generateMissing(ctx) {
      const { dryRun } = parseBody(dryRunOnlySchema, ctx.request.body);
      try {
        const report = await service().generateMissing({ dryRun });
        if (!dryRun && report.totalGenerated > 0) {
          strapi.log.warn(
            `[strapi-auto-uuid] AUDIT generate-missing by admin:${actorOf(ctx)} generated=${report.totalGenerated}`
          );
        }
        ctx.body = sanitizeUuidAdminReport(report);
      } catch (error) {
        if (respondConflict(ctx, error)) return;
        strapi.log.error(`[strapi-auto-uuid] Generate missing failed (${logFailureType(error)})`);
        throw new ApplicationError('Generating missing UUIDs failed. No changes were kept.');
      }
    },

    /**
     * @route GET /field-uuid/models
     * @access plugin::field-uuid.read
     * @returns {{ models: Record<string, string[]> }}
     */
    async getModels(ctx) {
      ctx.body = { models: service().getUuidModels() };
    },

    /**
     * @route GET /field-uuid/migration/status
     * @access plugin::field-uuid.read
     * @returns {Object} Counts per field, without identifiers or values.
     */
    async getMigrationStatus(ctx) {
      try {
        ctx.body = sanitizeUuidAdminReport(await migrations().checkMigrationStatus());
      } catch (error) {
        strapi.log.error(`[strapi-auto-uuid] Status check failed (${logFailureType(error)})`);
        throw new ApplicationError('The UUID status could not be checked. Refresh and try again.');
      }
    },

    /**
     * @route POST /field-uuid/migration/run
     * @access plugin::field-uuid.migrate
     * @body {{ dryRun?: boolean, fixEmpty?: boolean, fixInvalid?: boolean,
     *   fixDuplicates?: boolean, fixLegacy?: boolean }}
     * @returns {Object} Redacted repair result.
     * @sideeffect Rewrites UUID values when dryRun is false.
     */
    async runMigration(ctx) {
      const options = parseBody(migrationRunSchema, ctx.request.body);
      try {
        const result = await migrations().runMigration(options);
        if (!options.dryRun && result.totalFixed > 0) {
          const { empty, invalid, legacy, duplicates } = result.fixed;
          strapi.log.warn(
            `[strapi-auto-uuid] AUDIT repair by admin:${actorOf(ctx)} fixed=${result.totalFixed} (empty=${empty}, invalid=${invalid}, legacy=${legacy}, duplicates=${duplicates})`
          );
        }
        ctx.body = sanitizeUuidAdminReport(result);
      } catch (error) {
        if (respondConflict(ctx, error)) return;
        strapi.log.error(`[strapi-auto-uuid] Repair failed (${logFailureType(error)})`);
        throw new ApplicationError('The repair failed. No changes were kept.');
      }
    },

    /**
     * Exports all UUID mappings of every content type. Holders of
     * plugin::field-uuid.export can read every documentId and UUID value.
     *
     * @route GET /field-uuid/migration/export
     * @access plugin::field-uuid.export
     * @returns {Object} Export document (JSON attachment).
     */
    async exportMappings(ctx) {
      try {
        const exportData = await migrations().exportMappings();
        strapi.log.warn(`[strapi-auto-uuid] AUDIT export by admin:${actorOf(ctx)}`);
        ctx.set('Content-Type', 'application/json');
        ctx.set('Content-Disposition', `attachment; filename="uuid-mappings-${Date.now()}.json"`);
        ctx.body = exportData;
      } catch (error) {
        strapi.log.error(`[strapi-auto-uuid] Export failed (${logFailureType(error)})`);
        throw new ApplicationError('The UUID mappings could not be exported.');
      }
    },

    /**
     * Imports UUID mappings into empty fields; existing values are never replaced.
     *
     * @route POST /field-uuid/migration/import
     * @access plugin::field-uuid.import
     * @body {{ mappings: Object, dryRun?: boolean }}
     * @returns {Object} Counts and bounded, redacted error samples.
     * @sideeffect Writes UUID values into empty fields when dryRun is false.
     */
    async importMappings(ctx) {
      const { mappings, dryRun } = parseBody(importMappingsSchema, ctx.request.body);
      try {
        const result = await migrations().importMappings(mappings, { dryRun });
        if (!dryRun && result.imported > 0) {
          strapi.log.warn(
            `[strapi-auto-uuid] AUDIT import by admin:${actorOf(ctx)} imported=${result.imported}`
          );
        }
        ctx.body = sanitizeUuidAdminReport(result);
      } catch (error) {
        if (respondConflict(ctx, error)) return;
        strapi.log.error(`[strapi-auto-uuid] Import failed (${logFailureType(error)})`);
        throw new ApplicationError('The import failed. No changes were kept.');
      }
    },

    /**
     * @route GET /field-uuid/stats
     * @access plugin::field-uuid.read
     * @returns {Object} Aggregated counts and the UUID fields per content type.
     */
    async getStats(ctx) {
      try {
        const models = service().getUuidModels();
        const status = await migrations().checkMigrationStatus();
        const sum = (key) => status.contentTypes.reduce((total, ct) => total + (ct[key] || 0), 0);
        ctx.body = {
          contentTypes: Object.keys(models).length,
          totalFields: Object.values(models).reduce((total, fields) => total + fields.length, 0),
          totalEntries: status.totalEntries,
          issues: {
            empty: sum('emptyCount'),
            invalid: sum('invalidCount'),
            legacy: sum('legacyCount'),
            duplicates: sum('duplicateCount'),
          },
          needsMigration: status.needsMigration,
          hasErrors: status.hasErrors,
          scanIssues: sanitizeUuidAdminReport(status.issues),
          fields: sanitizeUuidAdminReport(status.contentTypes),
          models,
          version: pkg.version,
          lastChecked: new Date().toISOString(),
        };
      } catch (error) {
        strapi.log.error(`[strapi-auto-uuid] Statistics failed (${logFailureType(error)})`);
        throw new ApplicationError('UUID statistics could not be loaded. Refresh and try again.');
      }
    },
  };
};

export default controller;
