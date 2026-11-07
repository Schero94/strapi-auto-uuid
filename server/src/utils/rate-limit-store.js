/**
 * Fixed-window rate-limit counters.
 *
 * - Database store: one row per key in the plugin-owned table
 *   `field_uuid_rate_limits`, incremented with a single atomic upsert, so
 *   every replica and pm2 worker shares the same counter.
 *   PostgreSQL and SQLite use `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 *   (https://www.postgresql.org/docs/16/sql-insert.html,
 *   https://www.sqlite.org/lang_upsert.html); MySQL uses
 *   `INSERT ... ON DUPLICATE KEY UPDATE` and reads the row back in the same
 *   transaction (https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html).
 * - Memory store: a per-process Map. Used for SQLite by default, and as the
 *   fallback when the database store fails.
 *
 * Keys are SHA-256 hashes, so no user id or IP address is stored.
 */
import { createHash } from 'node:crypto';
import { ensureTable, getDialect } from './cluster-lock.js';

export const RATE_LIMIT_TABLE = 'field_uuid_rate_limits';

/** Expired rows older than this are deleted. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;
/** A process prunes at most this often. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
/** Memory store: prune when the map grows past this size. */
const MEMORY_PRUNE_SIZE = 5000;

/**
 * Hashes a rate-limit key.
 *
 * @param {string} key Raw key (route and caller).
 * @returns {string} 64 hex characters.
 */
export const hashRateLimitKey = (key) => createHash('sha256').update(key).digest('hex');

/**
 * Creates a per-process memory store.
 *
 * @returns {{ kind: 'memory', hit: (key: string, windowMs: number, now?: number) => Promise<{ count: number, expiresAt: number }> }}
 */
export function createMemoryStore() {
  const buckets = new Map();
  return {
    kind: 'memory',
    async hit(key, windowMs, now = Date.now()) {
      if (buckets.size > MEMORY_PRUNE_SIZE) {
        for (const [k, entry] of buckets) if (entry.expiresAt <= now) buckets.delete(k);
      }
      let entry = buckets.get(key);
      if (!entry || entry.expiresAt <= now) {
        entry = { count: 0, expiresAt: now + windowMs };
        buckets.set(key, entry);
      }
      entry.count += 1;
      return { count: entry.count, expiresAt: entry.expiresAt };
    },
  };
}

const tableRef = (strapi) => {
  const schema = strapi.db.getSchemaName?.();
  return schema ? `${schema}.${RATE_LIMIT_TABLE}` : RATE_LIMIT_TABLE;
};

/**
 * Creates the rate-limit table when it is missing.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {Promise<void>}
 * @throws {Error} When the table cannot be created.
 * @sideeffect Creates `field_uuid_rate_limits`.
 */
export const ensureRateLimitTable = (strapi) =>
  ensureTable(strapi, RATE_LIMIT_TABLE, (table) => {
    table.string('bucket_key', 64).primary();
    table.integer('hits').notNullable();
    table.bigInteger('expires_at').notNullable();
  });

/**
 * Creates a database store backed by `field_uuid_rate_limits`.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {{ kind: 'database', hit: Function }} Store.
 */
export function createDatabaseStore(strapi) {
  const dialect = getDialect(strapi);
  let lastPrune = 0;

  const prune = async (now) => {
    if (now - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now;
    // Idempotent: several processes may run it at the same moment.
    await strapi.db
      .getConnection(RATE_LIMIT_TABLE)
      .where('expires_at', '<', now - PRUNE_AFTER_MS)
      .del();
  };

  const toResult = (row) => ({ count: Number(row.hits), expiresAt: Number(row.expires_at) });

  return {
    kind: 'database',
    /**
     * Counts one request and returns the counter of the current window.
     *
     * @param {string} key Hashed key.
     * @param {number} windowMs Window length.
     * @param {number} [now] Current time in ms.
     * @returns {Promise<{ count: number, expiresAt: number }>} Counter after this request.
     * @throws {Error} Database errors.
     */
    async hit(key, windowMs, now = Date.now()) {
      const expiresAt = now + windowMs;
      const table = tableRef(strapi);
      let result;
      if (dialect === 'mysql') {
        result = await strapi.db.connection.transaction(async (trx) => {
          // Assignments run left to right; `hits` is computed from the old
          // `expires_at` before `expires_at` is replaced.
          await trx.raw(
            `insert into ?? (bucket_key, hits, expires_at) values (?, 1, ?)
             on duplicate key update
               hits = if(expires_at <= ?, 1, hits + 1),
               expires_at = if(expires_at <= ?, ?, expires_at)`,
            [table, key, expiresAt, now, now, expiresAt]
          );
          const rows = await trx(table).select('hits', 'expires_at').where('bucket_key', key);
          return toResult(rows[0]);
        });
      } else {
        const response = await strapi.db.connection.raw(
          `insert into ?? (bucket_key, hits, expires_at) values (?, 1, ?)
           on conflict (bucket_key) do update set
             hits = case when ??.expires_at <= ? then 1 else ??.hits + 1 end,
             expires_at = case when ??.expires_at <= ? then excluded.expires_at else ??.expires_at end
           returning hits, expires_at`,
          [
            table,
            key,
            expiresAt,
            RATE_LIMIT_TABLE,
            now,
            RATE_LIMIT_TABLE,
            RATE_LIMIT_TABLE,
            now,
            RATE_LIMIT_TABLE,
          ]
        );
        const rows = Array.isArray(response) ? response : response?.rows;
        result = toResult(rows[0]);
      }
      prune(now).catch(() => {});
      return result;
    },
  };
}

/**
 * Picks the store for the configured mode.
 *
 * @param {Object} strapi Strapi instance.
 * @param {'auto'|'database'|'memory'} mode Configured `rateLimitStore`.
 * @returns {'database'|'memory'} Store kind to use.
 */
export function resolveRateLimitStoreKind(strapi, mode) {
  if (mode === 'memory' || mode === 'database') return mode;
  const dialect = getDialect(strapi);
  return dialect === 'postgres' || dialect === 'mysql' ? 'database' : 'memory';
}

const stores = new WeakMap();

/**
 * Prepares the store at bootstrap. When the database store cannot be
 * prepared the memory store is used and a warning is logged.
 *
 * @param {Object} strapi Strapi instance.
 * @param {'auto'|'database'|'memory'} mode Configured `rateLimitStore`.
 * @param {{ warn: Function }} log Logger.
 * @returns {Promise<'database'|'memory'>} The store in use.
 * @sideeffect May create `field_uuid_rate_limits`.
 */
export async function prepareRateLimitStore(strapi, mode, log) {
  const memory = createMemoryStore();
  let store = memory;
  if (resolveRateLimitStoreKind(strapi, mode) === 'database') {
    try {
      await ensureRateLimitTable(strapi);
      store = createDatabaseStore(strapi);
    } catch (error) {
      log.warn(
        `[strapi-auto-uuid] Rate-limit table unavailable (${error?.code || error?.name || 'Error'}); using per-process counters`
      );
    }
  }
  stores.set(strapi, { store, memory, warned: false });
  return store.kind;
}

/**
 * Counts one request with the prepared store. Falls back to the memory store
 * (and warns once) when the database store fails, so an outage of the
 * counter table never blocks the admin.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} rawKey Unhashed key.
 * @param {number} windowMs Window length.
 * @returns {Promise<{ count: number, expiresAt: number }>} Counter after this request.
 */
export async function hitRateLimit(strapi, rawKey, windowMs) {
  let entry = stores.get(strapi);
  if (!entry) {
    entry = { store: createMemoryStore(), warned: false };
    entry.memory = entry.store;
    stores.set(strapi, entry);
  }
  const key = hashRateLimitKey(rawKey);
  if (entry.store.kind === 'memory') return entry.store.hit(key, windowMs);
  try {
    return await entry.store.hit(key, windowMs);
  } catch (error) {
    if (!entry.warned) {
      entry.warned = true;
      strapi.log.warn(
        `[strapi-auto-uuid] Rate-limit store failed (${error?.code || error?.name || 'Error'}); using per-process counters`
      );
    }
    return entry.memory.hit(key, windowMs);
  }
}
