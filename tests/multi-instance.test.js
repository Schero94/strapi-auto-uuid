/**
 * Multi-instance safety (several Strapi processes on one database):
 * cross-process locks, the shared rate-limit store, affected-row counting in
 * repairs and imports, and the boot repair skip. PostgreSQL tests run when
 * AUTO_UUID_PG_URL points at a local test database; the full 8-process race
 * is `npm run test:concurrency`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bootstrap from '../server/src/bootstrap.js';
import { normalizePluginConfig } from '../server/src/config/index.js';
import {
  LOCK_BUCKETS,
  LOCK_SPACES,
  allLockRows,
  lockDescriptor,
  NAMED_LOCKS,
  lockKeys,
  lockNamed,
  prepareClusterLocks,
  tryNamedLock,
  valueLockKey,
} from '../server/src/utils/cluster-lock.js';
import {
  createDatabaseStore,
  ensureRateLimitTable,
  hashRateLimitKey,
  resolveRateLimitStoreKind,
} from '../server/src/utils/rate-limit-store.js';
import { affectedRows } from '../server/src/migrations/index.js';
import { assertClusterRepairLock } from '../server/src/utils/repair-lock.js';
import { withUuidRepairContext } from '../server/src/utils/repair-context.js';
import { createSqliteHost, TABLE, UID } from './helpers/sqlite-strapi.js';

const PG_URL = process.env.AUTO_UUID_PG_URL;
const hosts = [];
const track = (host) => {
  hosts.push(host);
  return host;
};
afterEach(async () => {
  // Attached hosts first, the owner (which drops the schema) last.
  for (const host of hosts.reverse()) await host.close();
  hosts.length = 0;
});

describe('lock keys', () => {
  it('maps values to a fixed bucket range and ignores the UUID case', () => {
    const value = randomUUID();
    const lower = lockDescriptor(LOCK_SPACES.value, valueLockKey(UID, 'publicId', value));
    const upper = lockDescriptor(
      LOCK_SPACES.value,
      valueLockKey(UID, 'publicId', value.toUpperCase())
    );
    expect(upper).toEqual(lower);
    expect(lower.key2).toBeGreaterThanOrEqual(0);
    expect(lower.key2).toBeLessThan(LOCK_BUCKETS);
    expect(lower.row).toMatch(/^v:\d{4}$/);
  });

  it('keeps every space apart and inside the signed 32-bit range', () => {
    const keys = [LOCK_SPACES.value, LOCK_SPACES.document, LOCK_SPACES.named].map(
      (space) => lockDescriptor(space, 'same-key').key1
    );
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toBeLessThan(2 ** 31);
    const named = lockDescriptor(LOCK_SPACES.named, 'repair');
    expect(named.key2).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(named.key2).toBeLessThan(2 ** 31);
    expect(named.row).toBe('n:repair');
  });

  it('seeds one MySQL row per bucket and named lock', () => {
    const rows = allLockRows();
    expect(rows).toHaveLength(2 * LOCK_BUCKETS + NAMED_LOCKS.length);
    expect(rows).toContain('n:repair-writes');
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe('MySQL lock statements', () => {
  /** Fake MySQL Strapi that records the SQL sent on the transaction. */
  const fakeMysql = () => {
    const sql = [];
    const insert = vi.fn(() => ({ onConflict: () => ({ ignore: async () => {} }) }));
    const strapi = {
      db: {
        dialect: { client: 'mysql' },
        getSchemaName: () => undefined,
        connection: {
          schema: { hasTable: async () => true, createTable: async () => {} },
        },
        getConnection: () => ({ insert }),
        inTransaction: () => true,
        transaction: (cb) =>
          cb({
            trx: {
              raw: async (text, bindings) => {
                sql.push({ text, bindings });
                if (bindings?.includes('n:repair') && strapi.busy) {
                  throw Object.assign(new Error('Do not wait for lock.'), { errno: 3572 });
                }
                return [[]];
              },
            },
          }),
      },
    };
    return { strapi, sql, insert };
  };

  it('locks bucket rows in name order with FOR UPDATE', async () => {
    const { strapi, sql, insert } = fakeMysql();
    expect(await prepareClusterLocks(strapi, { warn: vi.fn() })).toBe(true);
    expect(insert).toHaveBeenCalled();
    const keys = ['b', 'a', 'c', 'a'].map((k) => valueLockKey(UID, 'publicId', k));
    expect(await lockKeys(strapi, LOCK_SPACES.value, keys)).toBe(true);
    expect(sql).toHaveLength(1);
    expect(sql[0].text).toMatch(/for update$/);
    const rows = sql[0].bindings.slice(1);
    expect(rows).toEqual([...rows].sort());
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('takes the repair-writes row shared or exclusive', async () => {
    const { strapi, sql } = fakeMysql();
    await prepareClusterLocks(strapi, { warn: vi.fn() });
    expect(await lockNamed(strapi, 'repair-writes', { shared: true })).toBe(true);
    expect(sql.at(-1).text).toMatch(/lock in share mode$/);
    expect(sql.at(-1).bindings.at(-1)).toBe('n:repair-writes');
    expect(await lockNamed(strapi, 'repair-writes')).toBe(true);
    expect(sql.at(-1).text).toMatch(/for update$/);
  });

  it('reports a held repair lock from NOWAIT error 3572', async () => {
    const { strapi, sql } = fakeMysql();
    await prepareClusterLocks(strapi, { warn: vi.fn() });
    expect(await tryNamedLock(strapi, 'repair')).toBe(true);
    strapi.busy = true;
    expect(await tryNamedLock(strapi, 'repair')).toBe(false);
    expect(sql.at(-1).text).toMatch(/for update nowait$/);
  });
});

describe('configuration', () => {
  it('accepts rateLimitStore and defaults it to auto', () => {
    expect(normalizePluginConfig({}).rateLimitStore).toBe('auto');
    expect(normalizePluginConfig({ rateLimitStore: 'database' }).rateLimitStore).toBe('database');
    expect(() => normalizePluginConfig({ rateLimitStore: 'redis' })).toThrow(/rateLimitStore/);
  });

  it('uses the database store on PostgreSQL and MySQL, memory on SQLite in auto mode', () => {
    const on = (client) => ({ db: { dialect: { client } } });
    expect(resolveRateLimitStoreKind(on('postgres'), 'auto')).toBe('database');
    expect(resolveRateLimitStoreKind(on('mysql'), 'auto')).toBe('database');
    expect(resolveRateLimitStoreKind(on('sqlite'), 'auto')).toBe('memory');
    expect(resolveRateLimitStoreKind(on('sqlite'), 'database')).toBe('database');
    expect(resolveRateLimitStoreKind(on('postgres'), 'memory')).toBe('memory');
  });

  it('stores hashed rate-limit keys only', () => {
    expect(hashRateLimitKey('/field-uuid/export::ip:203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('affected-row counting', () => {
  it('reads the query-engine count and treats unknown shapes as written', () => {
    expect(affectedRows({ count: 0 })).toBe(0);
    expect(affectedRows({ count: 3 })).toBe(3);
    expect(affectedRows(2)).toBe(2);
    expect(affectedRows(undefined)).toBe(1);
  });
});

describe('boot repair on several instances', () => {
  it('skips quietly when another instance holds the repair lock', async () => {
    const error = Object.assign(new Error('busy'), { code: 'REPAIR_IN_PROGRESS' });
    const migrations = { runMigration: vi.fn(async () => Promise.reject(error)) };
    const strapi = {
      contentTypes: {
        [UID]: { attributes: { publicId: { customField: 'plugin::field-uuid.uuid' } } },
      },
      components: {},
      config: { get: (_key, fallback = {}) => ({ ...fallback, autoMigrate: true }) },
      db: { lifecycles: { subscribe: vi.fn() } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      plugin: () => ({ service: () => migrations }),
    };
    await bootstrap({ strapi });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(migrations.runMigration).toHaveBeenCalledOnce();
    expect(strapi.log.error).not.toHaveBeenCalled();
    expect(strapi.log.info.mock.calls.flat().join(' ')).toContain('another instance');
  });
});

describe('repairs and imports count only rows they actually wrote (SQLite)', () => {
  /**
   * Simulates an editor on another process that fills the empty publicId
   * between the repair's scan and its write.
   */
  const interfereOnce = (host) => {
    let done = false;
    host.db.lifecycles.subscribe({
      models: [UID],
      async beforeUpdateMany(event) {
        if (done || !Object.hasOwn(event.params.data, 'publicId')) return;
        done = true;
        await host.db.transaction(({ trx }) =>
          trx(TABLE).whereNull('public_id').update({ public_id: randomUUID() })
        );
      },
    });
  };

  it('repair: a write that matched no row is skipped, not counted', async () => {
    const host = track(await createSqliteHost());
    await host.insertRaw([{ documentId: 'doc-1', publicId: null, editableId: null }]);
    interfereOnce(host);
    const result = await host.services.migrations.runMigration({ dryRun: false });
    expect(result.failed).toBeUndefined();
    expect(result.fixed.empty).toBe(1); // editableId only
    expect(result.totalFixed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedChanges).toEqual([
      expect.objectContaining({ field: 'publicId', code: 'CONCURRENT_CHANGE' }),
    ]);
    expect(result.changes).toHaveLength(1);
  });

  it('import: a write that matched no row is skipped with CONCURRENT_CHANGE', async () => {
    const host = track(await createSqliteHost());
    await host.insertRaw([{ documentId: 'doc-1', publicId: null, editableId: randomUUID() }]);
    interfereOnce(host);
    const result = await host.services.migrations.importMappings(
      {
        mappings: {
          [UID]: { fields: { publicId: [{ documentId: 'doc-1', uuid: randomUUID() }] } },
        },
      },
      { dryRun: false }
    );
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errorCounts).toEqual({ CONCURRENT_CHANGE: 1 });
    expect(result.changes).toHaveLength(0);
  });

  it('takes no database lock on SQLite', async () => {
    const host = track(await createSqliteHost());
    await host.inTransaction(async () => {
      expect(await lockKeys(host.strapi, LOCK_SPACES.value, ['x'])).toBe(false);
      expect(await tryNamedLock(host.strapi, 'repair')).toBe(true);
    });
  });
});

describe.skipIf(!PG_URL)('PostgreSQL: two processes on one database', () => {
  /** Owner host plus a second host attached to the same schema. */
  const pair = async (opts = {}) => {
    const a = track(await createSqliteHost({ client: 'postgres', ...opts }));
    const b = track(
      await createSqliteHost({ client: 'postgres', schema: a.schema, attach: true, ...opts })
    );
    return [a, b];
  };

  /** Holds a transaction open until `release` is called. */
  const holdTransaction = (host, fn) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const done = host.db.transaction(async () => {
      const value = await fn();
      entered(value);
      await gate;
    });
    return { ready, release: () => release(), done };
  };

  it('lets only one process hold the repair lock until its transaction ends', async () => {
    const [a, b] = await pair();
    const held = holdTransaction(a, () => tryNamedLock(a.strapi, 'repair'));
    expect(await held.ready).toBe(true);
    expect(await b.db.transaction(() => tryNamedLock(b.strapi, 'repair'))).toBe(false);
    held.release();
    await held.done;
    expect(await b.db.transaction(() => tryNamedLock(b.strapi, 'repair'))).toBe(true);
  });

  it('answers REPAIR_IN_PROGRESS for a repair started on another process', async () => {
    const [a, b] = await pair();
    const held = holdTransaction(a, () => tryNamedLock(a.strapi, 'repair'));
    await held.ready;
    await expect(b.services.migrations.runMigration({ dryRun: false })).rejects.toMatchObject({
      code: 'REPAIR_IN_PROGRESS',
    });
    held.release();
    await held.done;
  });

  it('rejects a duplicate value created on another process after the first commits', async () => {
    const [a, b] = await pair();
    const value = randomUUID();
    const held = holdTransaction(a, () =>
      a.db.query(UID).create({ data: { title: 'a', locale: 'en', editableId: value } })
    );
    await held.ready;
    const second = b.db.transaction(() =>
      b.db.query(UID).create({ data: { title: 'b', locale: 'en', editableId: value } })
    );
    // b waits on the value lock; give it time to reach the lock, then commit a.
    await new Promise((resolve) => setTimeout(resolve, 200));
    held.release();
    await held.done;
    await expect(second).rejects.toMatchObject({ details: { code: 'DUPLICATE_UUID' } });
    const rows = (await a.rows()).filter((row) => row.editableId === value);
    expect(rows).toHaveLength(1);
  });

  it('keeps the first value of a write-once field filled on two processes', async () => {
    const [a, b] = await pair();
    await a.insertRaw([{ documentId: 'doc-once', publicId: null }]);
    const [{ id }] = await a.rows();
    const first = randomUUID();
    const held = holdTransaction(a, () =>
      a.db.query(UID).update({ where: { id }, data: { publicId: first } })
    );
    await held.ready;
    const second = b.db.transaction(() =>
      b.db.query(UID).update({ where: { id }, data: { publicId: randomUUID() } })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    held.release();
    await held.done;
    await expect(second).rejects.toMatchObject({ details: { code: 'IMMUTABLE_UUID' } });
    expect((await a.rows())[0].publicId).toBe(first);
  });

  it('does not overwrite a value that a repair on another process filled', async () => {
    const [a, b] = await pair();
    await a.insertRaw([{ documentId: 'doc-repair', publicId: null }]);
    const [{ id }] = await a.rows();
    const repaired = randomUUID();
    // A repair on process a fills the empty field and has not committed yet.
    const held = withUuidRepairContext(() =>
      holdTransaction(a, async () => {
        await assertClusterRepairLock(a.strapi);
        await a.db.query(UID).update({ where: { id }, data: { publicId: repaired } });
      })
    );
    await held.ready;
    // An editor on process b fills the same field. It must wait for the
    // repair and then see its value, not overwrite it after the commit.
    const editor = b.db.transaction(() =>
      b.db.query(UID).update({ where: { id }, data: { publicId: randomUUID() } })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    held.release();
    await held.done;
    await expect(editor).rejects.toMatchObject({ details: { code: 'IMMUTABLE_UUID' } });
    expect((await a.rows())[0].publicId).toBe(repaired);
  });

  it('makes a repair wait for a save that is filling a write-once field', async () => {
    const [a, b] = await pair();
    const held = holdTransaction(a, () => lockNamed(a.strapi, 'repair-writes', { shared: true }));
    expect(await held.ready).toBe(true);
    let started = false;
    const repair = b.db.transaction(async () => {
      await assertClusterRepairLock(b.strapi);
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(started).toBe(false);
    held.release();
    await held.done;
    await repair;
    expect(started).toBe(true);
  });

  it('shares rate-limit counters between processes', async () => {
    const [a, b] = await pair({ config: { rateLimitStore: 'database' } });
    const storeA = createDatabaseStore(a.strapi);
    const storeB = createDatabaseStore(b.strapi);
    const key = hashRateLimitKey('/field-uuid/export::u:1');
    const now = Date.now();
    expect((await storeA.hit(key, 60_000, now)).count).toBe(1);
    expect((await storeB.hit(key, 60_000, now)).count).toBe(2);
    expect((await storeA.hit(key, 60_000, now)).count).toBe(3);
    // A new window starts at 1 again.
    expect((await storeB.hit(key, 60_000, now + 61_000)).count).toBe(1);
  });

  it('creates the rate-limit table once when several processes boot together', async () => {
    const [a, b] = await pair();
    await a.db.connection.raw('drop table if exists field_uuid_rate_limits');
    await Promise.all([ensureRateLimitTable(a.strapi), ensureRateLimitTable(b.strapi)]);
    expect(await a.db.connection.schema.hasTable('field_uuid_rate_limits')).toBe(true);
  });
});

describe('SQLite database store', () => {
  it('counts with an atomic upsert and resets after the window', async () => {
    const host = track(await createSqliteHost({ config: { rateLimitStore: 'database' } }));
    const store = createDatabaseStore(host.strapi);
    const key = hashRateLimitKey('k');
    const now = Date.now();
    expect(await store.hit(key, 1000, now)).toEqual({ count: 1, expiresAt: now + 1000 });
    expect((await store.hit(key, 1000, now + 10)).count).toBe(2);
    expect(await store.hit(key, 1000, now + 1000)).toEqual({ count: 1, expiresAt: now + 2000 });
  });
});
