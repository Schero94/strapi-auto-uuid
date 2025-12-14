'use strict';

/**
 * Content API Routes
 * 
 * Public API routes for the UUID plugin.
 */
export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/health',
      handler: 'controller.index',
      config: {
        policies: [],
        auth: false,
      },
    },
  ],
};
