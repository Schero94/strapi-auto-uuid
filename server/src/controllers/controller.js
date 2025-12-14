'use strict';

/**
 * UUID Plugin Controller
 * 
 * Provides endpoints for health check, UUID validation, diagnosis, auto-fix,
 * migration support, and statistics.
 */
const controller = ({ strapi }) => ({
  /**
   * Health check endpoint
   * @param {Object} ctx - Koa context
   */
  async index(ctx) {
    ctx.body = {
      status: 'ok',
      plugin: 'field-uuid',
      version: '1.0.0',
      message: 'Strapi Auto UUID Plugin is running',
    };
  },

  /**
   * Checks if a UUID already exists in a content type
   * @param {Object} ctx - Koa context
   */
  async checkDuplicate(ctx) {
    const { contentType, field, uuid, excludeDocumentId } = ctx.request.body;

    if (!contentType || !field || !uuid) {
      return ctx.badRequest('Missing required parameters: contentType, field, uuid');
    }

    const model = strapi.contentTypes[contentType];
    if (!model) {
      return ctx.badRequest(`Content type '${contentType}' not found`);
    }

    const attribute = model.attributes[field];
    if (!attribute) {
      return ctx.badRequest(`Field '${field}' not found in content type '${contentType}'`);
    }

    try {
      const result = await strapi.plugin('field-uuid').service('service').checkDuplicate({
        contentType,
        field,
        uuid,
        excludeDocumentId,
      });

      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error checking duplicate:', error);
      return ctx.internalServerError('Failed to check UUID duplicate');
    }
  },

  /**
   * Diagnoses all UUID fields for duplicates across all content types
   * @param {Object} ctx - Koa context
   */
  async diagnose(ctx) {
    try {
      const report = await strapi.plugin('field-uuid').service('service').diagnose();
      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error during diagnosis:', error);
      return ctx.internalServerError('Failed to diagnose UUIDs');
    }
  },

  /**
   * Auto-fixes all duplicate UUIDs by generating new unique UUIDs
   * @param {Object} ctx - Koa context
   */
  async autofix(ctx) {
    const { dryRun = false } = ctx.request.body || {};

    try {
      const report = await strapi.plugin('field-uuid').service('service').autofix({ dryRun });
      
      if (!dryRun && report.totalFixed > 0) {
        strapi.log.info(`[strapi-auto-uuid] Auto-fix completed: ${report.totalFixed} duplicate(s) fixed`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error during auto-fix:', error);
      return ctx.internalServerError('Failed to auto-fix UUIDs');
    }
  },

  /**
   * Generates missing UUIDs for entries with empty UUID fields
   * @param {Object} ctx - Koa context
   */
  async generateMissing(ctx) {
    const { dryRun = false } = ctx.request.body || {};

    try {
      const report = await strapi.plugin('field-uuid').service('service').generateMissing({ dryRun });
      
      if (!dryRun && report.totalGenerated > 0) {
        strapi.log.info(`[strapi-auto-uuid] Generated ${report.totalGenerated} missing UUID(s)`);
      }

      ctx.body = report;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error generating missing UUIDs:', error);
      return ctx.internalServerError('Failed to generate missing UUIDs');
    }
  },

  /**
   * Returns list of all content types using UUID fields
   * @param {Object} ctx - Koa context
   */
  async getModels(ctx) {
    try {
      const models = strapi.plugin('field-uuid').service('service').getUuidModels();
      ctx.body = { models };
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error getting models:', error);
      return ctx.internalServerError('Failed to get UUID models');
    }
  },

  // =====================
  // Migration Endpoints
  // =====================

  /**
   * Get migration status - identifies issues that need fixing
   * @param {Object} ctx - Koa context
   */
  async getMigrationStatus(ctx) {
    try {
      const status = await strapi.plugin('field-uuid').service('migrations').checkMigrationStatus();
      ctx.body = status;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error checking migration status:', error);
      return ctx.internalServerError('Failed to check migration status');
    }
  },

  /**
   * Run migration to fix all UUID issues
   * @param {Object} ctx - Koa context
   */
  async runMigration(ctx) {
    const { 
      dryRun = true, 
      fixEmpty = true, 
      fixInvalid = true, 
      fixDuplicates = true 
    } = ctx.request.body || {};

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
      return ctx.internalServerError('Failed to run migration');
    }
  },

  /**
   * Export UUID mappings for backup
   * @param {Object} ctx - Koa context
   */
  async exportMappings(ctx) {
    try {
      const exportData = await strapi.plugin('field-uuid').service('migrations').exportMappings();
      
      // Set headers for file download
      ctx.set('Content-Type', 'application/json');
      ctx.set('Content-Disposition', `attachment; filename="uuid-mappings-${Date.now()}.json"`);
      ctx.body = exportData;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error exporting mappings:', error);
      return ctx.internalServerError('Failed to export UUID mappings');
    }
  },

  /**
   * Import UUID mappings
   * @param {Object} ctx - Koa context
   */
  async importMappings(ctx) {
    const { mappings, dryRun = true, overwrite = false } = ctx.request.body || {};

    if (!mappings) {
      return ctx.badRequest('Missing required parameter: mappings');
    }

    try {
      const result = await strapi.plugin('field-uuid').service('migrations').importMappings(
        mappings,
        { dryRun, overwrite }
      );
      ctx.body = result;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error importing mappings:', error);
      return ctx.internalServerError('Failed to import UUID mappings');
    }
  },

  /**
   * Get comprehensive UUID statistics
   * @param {Object} ctx - Koa context
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
        lastChecked: new Date().toISOString(),
      };

      ctx.body = stats;
    } catch (error) {
      strapi.log.error('[strapi-auto-uuid] Error getting stats:', error);
      return ctx.internalServerError('Failed to get UUID statistics');
    }
  },
});

export default controller;
