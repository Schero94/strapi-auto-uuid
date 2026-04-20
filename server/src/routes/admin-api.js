/**
 * Admin API Routes
 *
 * All routes require admin authentication AND a specific plugin permission
 * (registered in bootstrap.js via actionProvider).
 *
 * Permissions:
 *   plugin::field-uuid.read    → GET /models, /stats, /diagnose, /migration/status
 *   plugin::field-uuid.migrate → POST /autofix, /generate-missing, /migration/run
 *   plugin::field-uuid.export  → GET /migration/export
 *   plugin::field-uuid.import  → POST /migration/import
 *
 * Expensive endpoints are additionally rate-limited (per-user, in-memory).
 */

const policy = (action) => [
  'admin::isAuthenticatedAdmin',
  { name: 'admin::hasPermissions', config: { actions: [`plugin::field-uuid.${action}`] } },
];

const rateLimit = (max, windowMs) => [
  { name: 'plugin::field-uuid.rate-limit', config: { max, window: windowMs } },
];

export default {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/health',
      handler: 'controller.index',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/check-duplicate',
      handler: 'controller.checkDuplicate',
      config: {
        policies: policy('read'),
        middlewares: rateLimit(30, 60_000),
      },
    },
    {
      method: 'GET',
      path: '/diagnose',
      handler: 'controller.diagnose',
      config: {
        policies: policy('read'),
        middlewares: rateLimit(5, 60_000),
      },
    },
    {
      method: 'POST',
      path: '/autofix',
      handler: 'controller.autofix',
      config: {
        policies: policy('migrate'),
        middlewares: rateLimit(5, 60_000),
      },
    },
    {
      method: 'POST',
      path: '/generate-missing',
      handler: 'controller.generateMissing',
      config: {
        policies: policy('migrate'),
        middlewares: rateLimit(5, 60_000),
      },
    },
    {
      method: 'GET',
      path: '/models',
      handler: 'controller.getModels',
      config: {
        policies: policy('read'),
      },
    },
    {
      method: 'GET',
      path: '/migration/status',
      handler: 'controller.getMigrationStatus',
      config: {
        policies: policy('read'),
        middlewares: rateLimit(10, 60_000),
      },
    },
    {
      method: 'POST',
      path: '/migration/run',
      handler: 'controller.runMigration',
      config: {
        policies: policy('migrate'),
        middlewares: rateLimit(3, 60_000),
      },
    },
    {
      method: 'GET',
      path: '/migration/export',
      handler: 'controller.exportMappings',
      config: {
        policies: policy('export'),
        middlewares: rateLimit(3, 60_000),
      },
    },
    {
      method: 'POST',
      path: '/migration/import',
      handler: 'controller.importMappings',
      config: {
        policies: policy('import'),
        middlewares: rateLimit(3, 60_000),
      },
    },
    {
      method: 'GET',
      path: '/stats',
      handler: 'controller.getStats',
      config: {
        policies: policy('read'),
        middlewares: rateLimit(20, 60_000),
      },
    },
  ],
};
