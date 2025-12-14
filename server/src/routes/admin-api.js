'use strict';

/**
 * Admin API Routes
 * 
 * Protected API routes for the UUID plugin admin panel.
 * These routes require admin authentication.
 */
export default {
  type: 'admin',
  routes: [
    {
      method: 'POST',
      path: '/check-duplicate',
      handler: 'controller.checkDuplicate',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/diagnose',
      handler: 'controller.diagnose',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/autofix',
      handler: 'controller.autofix',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/generate-missing',
      handler: 'controller.generateMissing',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/models',
      handler: 'controller.getModels',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    // Migration endpoints
    {
      method: 'GET',
      path: '/migration/status',
      handler: 'controller.getMigrationStatus',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/migration/run',
      handler: 'controller.runMigration',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/migration/export',
      handler: 'controller.exportMappings',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/migration/import',
      handler: 'controller.importMappings',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/stats',
      handler: 'controller.getStats',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
  ],
};
