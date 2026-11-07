/**
 * Per-user rate limiter for expensive admin endpoints.
 *
 * Callers are identified by ctx.state.user.id (admin JWT), falling back to
 * the client IP. Counters use a fixed window. With the database store (the
 * default on PostgreSQL and MySQL) every replica and pm2 worker shares one
 * counter per user and route; with the memory store each process counts on
 * its own. See `utils/rate-limit-store.js` and the `rateLimitStore` option.
 *
 * Config (route-level):
 *   { name: 'plugin::field-uuid.rate-limit', config: { max: 5, window: 60_000 } }
 */
import { hitRateLimit } from '../utils/rate-limit-store.js';

/**
 * Creates the rate-limit middleware.
 *
 * @param {{ max?: number, window?: number }} cfg Requests allowed per window (ms).
 * @param {{ strapi: Object }} context Strapi context.
 * @returns {(ctx: Object, next: Function) => Promise<void>} Koa middleware.
 */
const rateLimit = (cfg = {}, { strapi }) => {
  const max = Number.isFinite(cfg.max) ? cfg.max : 10;
  const windowMs = Number.isFinite(cfg.window) ? cfg.window : 60_000;

  return async (ctx, next) => {
    const userId = ctx.state?.user?.id;
    const ip = ctx.request.ip || ctx.ip || 'unknown';
    const key = `${ctx.path}::${userId ? `u:${userId}` : `ip:${ip}`}`;
    const now = Date.now();

    const entry = await hitRateLimit(strapi, key, windowMs);

    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      ctx.set('Retry-After', String(retryAfterSec));
      // Do not log the user id or IP address.
      strapi.log.warn(`[strapi-auto-uuid] Rate limit exceeded on ${ctx.path}`);
      ctx.status = 429;
      ctx.body = {
        data: null,
        error: {
          status: 429,
          name: 'TooManyRequestsError',
          message: 'Too many requests. Please slow down.',
          details: { code: 'RATE_LIMITED', retryAfter: retryAfterSec },
        },
      };
      return;
    }

    await next();
  };
};

export default rateLimit;
