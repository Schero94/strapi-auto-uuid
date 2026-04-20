/**
 * Per-user in-memory rate limiter for expensive admin endpoints.
 * Identifies callers by ctx.state.user.id when available (admin JWT),
 * falling back to client IP. Small TTL map, resets on process restart.
 *
 * Config (route-level):
 *   { name: 'plugin::field-uuid.rate-limit', config: { max: 5, window: 60_000 } }
 */

const buckets = new Map();

const prune = (now) => {
  for (const [key, entry] of buckets) {
    if (entry.expiresAt <= now) buckets.delete(key);
  }
};

/**
 * @param {{ max?: number, window?: number }} cfg
 */
const rateLimit = (cfg = {}, { strapi }) => {
  const max = Number.isFinite(cfg.max) ? cfg.max : 10;
  const windowMs = Number.isFinite(cfg.window) ? cfg.window : 60_000;

  return async (ctx, next) => {
    const userId = ctx.state?.user?.id;
    const ip = ctx.request.ip || ctx.ip || 'unknown';
    const key = `${ctx.path}::${userId ? `u:${userId}` : `ip:${ip}`}`;
    const now = Date.now();

    if (buckets.size > 5000) prune(now);

    let entry = buckets.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.expiresAt - now) / 1000);
      ctx.set('Retry-After', String(retryAfterSec));
      strapi.log.warn(
        `[strapi-auto-uuid] Rate limit exceeded on ${ctx.path} for ${userId ? `user:${userId}` : `ip:${ip}`}`
      );
      ctx.status = 429;
      ctx.body = {
        data: null,
        error: {
          status: 429,
          name: 'TooManyRequestsError',
          message: 'Too many requests. Please slow down.',
          details: { retryAfter: retryAfterSec },
        },
      };
      return;
    }

    await next();
  };
};

export default rateLimit;
