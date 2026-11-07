/**
 * Database-backed locks that coordinate several Strapi processes (Railway
 * replicas, pm2 cluster workers) that share one database.
 *
 * Every lock is transaction-scoped: it is taken on the connection of the
 * open transaction and released by the database on commit, rollback or a
 * dropped connection, so a crashed worker never leaves a stale lock.
 *
 * - PostgreSQL: `pg_advisory_xact_lock(key1, key2)` and
 *   `pg_try_advisory_xact_lock(key1, key2)`
 *   (https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).
 * - MySQL / MariaDB: row locks (`SELECT ... FOR UPDATE [NOWAIT]`) on rows of
 *   the plugin-owned table `field_uuid_locks`
 *   (https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html).
 *   Session locks (`GET_LOCK`) are not used: they survive a rollback on a
 *   pooled connection.
 * - SQLite: no lock. SQLite allows one writer per database file and Strapi's
 *   SQLite pool has a single connection, so writes are already serialized.
 *   Running several processes against one SQLite file is not supported.
 *
 * Keys are hashed into a fixed number of buckets per lock space, so a large
 * import never holds more than {@link LOCK_BUCKETS} locks per space.
 */
import { createHash } from 'node:crypto';
import { canonicalUuidValue } from '../../../shared/uuid-field.js';

/** Plugin-owned table that holds the MySQL lock rows. */
export const LOCK_TABLE = 'field_uuid_locks';

/** Buckets per lock space. Unrelated keys in one bucket only serialize briefly. */
export const LOCK_BUCKETS = 1024;

/**
 * First advisory-lock key per space. The values spell "UU" in the two high
 * bytes and stay inside the signed 32-bit range PostgreSQL expects.
 */
const NAMESPACE_BASE = 0x55550000;

/** Lock spaces. Values never share a key with documents or named locks. */
export const LOCK_SPACES = Object.freeze({
  /** A UUID value of one field: serializes uniqueness checks. */
  value: { id: 1, prefix: 'v' },
  /** A field of one document: serializes the write-once rule. */
  document: { id: 2, prefix: 'd' },
  /** A named operation such as `repair`. */
  named: { id: 3, prefix: 'n' },
});

/**
 * Named locks that exist as rows on MySQL.
 * - `repair`: taken without waiting; only one repair or import runs at a time.
 * - `repair-writes`: held exclusively by the running repair or import for its
 *   whole transaction. A save that fills an empty write-once field takes it
 *   shared first, so it never decides on a row the repair has already filled
 *   but not yet committed (see {@link lockNamedShared}).
 */
export const NAMED_LOCKS = Object.freeze(['repair', 'repair-writes']);

/**
 * Lock key of one UUID value. Case variants of a value share the key.
 *
 * @param {string} uid Content type UID.
 * @param {string} field UUID field name.
 * @param {string} value Value (any spelling).
 * @returns {string} Lock key.
 */
export const valueLockKey = (uid, field, value) =>
  `${uid}\u0000${field}\u0000${canonicalUuidValue(value)}`;

/**
 * Lock key of one UUID field of one document.
 *
 * @param {string} uid Content type UID.
 * @param {string} field UUID field name.
 * @param {string} documentId Document id.
 * @returns {string} Lock key.
 */
export const documentLockKey = (uid, field, documentId) =>
  `${uid}\u0000${field}\u0000${documentId}`;

/**
 * Errors of a NOWAIT locking read on a locked row: MySQL 8 raises
 * ER_LOCK_NOWAIT (3572); MariaDB raises ER_LOCK_WAIT_TIMEOUT (1205)
 * (https://mariadb.com/docs/server/reference/sql-statements/transactions/wait-and-nowait).
 */
const MYSQL_NOWAIT_ERRNOS = new Set([3572, 1205]);
/** PostgreSQL SQLSTATE lock_not_available, raised by NOWAIT. */
const PG_LOCK_NOT_AVAILABLE = '55P03';

/** Per-database state: whether the MySQL lock table is usable. */
const lockTableReady = new WeakMap();

/**
 * Returns the Strapi dialect name of the database.
 *
 * @param {{ db?: Object }} strapi Strapi instance.
 * @returns {'postgres'|'mysql'|'sqlite'|string} Dialect, or '' when unknown.
 */
export const getDialect = (strapi) =>
  strapi?.db?.dialect?.client || strapi?.db?.config?.connection?.client || '';

/**
 * Hashes text to an unsigned 32-bit integer. The hash is computed in
 * JavaScript, so the same key maps to the same lock on every database.
 *
 * @param {string} text Lock key.
 * @returns {number} Unsigned 32-bit hash.
 */
export const hash32 = (text) => createHash('sha256').update(text).digest().readUInt32BE(0);

/**
 * Builds the lock descriptor for a key.
 *
 * @param {{ id: number, prefix: string }} space Entry of {@link LOCK_SPACES}.
 * @param {string} key Lock key, for example `uid\0field\0value`.
 * @returns {{ key1: number, key2: number, row: string }} PostgreSQL keys and MySQL row name.
 */
export function lockDescriptor(space, key) {
  if (space === LOCK_SPACES.named) {
    return { key1: NAMESPACE_BASE + space.id, key2: hash32(key) | 0, row: `n:${key}` };
  }
  const bucket = hash32(key) % LOCK_BUCKETS;
  return {
    key1: NAMESPACE_BASE + space.id,
    key2: bucket,
    row: `${space.prefix}:${String(bucket).padStart(4, '0')}`,
  };
}

/**
 * Returns every MySQL lock row name, used to seed {@link LOCK_TABLE}.
 *
 * @returns {string[]} Row names.
 */
export function allLockRows() {
  const rows = NAMED_LOCKS.map((name) => `n:${name}`);
  for (const space of [LOCK_SPACES.value, LOCK_SPACES.document]) {
    for (let bucket = 0; bucket < LOCK_BUCKETS; bucket += 1) {
      rows.push(`${space.prefix}:${String(bucket).padStart(4, '0')}`);
    }
  }
  return rows;
}

const tableRef = (strapi, table) => {
  const schema = strapi.db.getSchemaName?.();
  return schema ? `${schema}.${table}` : table;
};

/**
 * Creates the table if it is missing. Several processes may boot at the same
 * moment: when the create fails, the table is checked again and the error is
 * only raised when the table still does not exist.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} table Table name.
 * @param {(table: Object) => void} build knex table builder callback.
 * @returns {Promise<void>}
 * @throws {Error} When the table cannot be created.
 */
export async function ensureTable(strapi, table, build) {
  const schema = strapi.db.getSchemaName?.();
  const builder = () =>
    schema ? strapi.db.connection.schema.withSchema(schema) : strapi.db.connection.schema;
  if (await builder().hasTable(table)) return;
  try {
    await builder().createTable(table, build);
  } catch (error) {
    if (!(await builder().hasTable(table))) throw error;
  }
}

/**
 * Prepares the lock table on MySQL. Other dialects need no table. Failures
 * are logged and the plugin falls back to the process-local guards.
 *
 * @param {Object} strapi Strapi instance.
 * @param {{ warn: Function }} log Logger.
 * @returns {Promise<boolean>} Whether cross-process locks are available.
 * @sideeffect Creates and seeds `field_uuid_locks` on MySQL.
 */
export async function prepareClusterLocks(strapi, log) {
  const dialect = getDialect(strapi);
  if (dialect !== 'mysql') return dialect === 'postgres';
  try {
    await ensureTable(strapi, LOCK_TABLE, (table) => {
      table.string('name', 64).primary();
    });
    const names = allLockRows();
    for (let start = 0; start < names.length; start += 500) {
      await strapi.db
        .getConnection(LOCK_TABLE)
        .insert(names.slice(start, start + 500).map((name) => ({ name })))
        .onConflict('name')
        .ignore();
    }
    lockTableReady.set(strapi.db, true);
    return true;
  } catch (error) {
    lockTableReady.set(strapi.db, false);
    log.warn(
      `[strapi-auto-uuid] Could not prepare the lock table (${error?.code || error?.name || 'Error'}); falling back to process-local locks`
    );
    return false;
  }
}

/**
 * Whether cross-process locks are available for this database.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {boolean} True on PostgreSQL, and on MySQL once the lock table is ready.
 */
export function hasClusterLocks(strapi) {
  const dialect = getDialect(strapi);
  if (dialect === 'postgres') return true;
  if (dialect === 'mysql') return lockTableReady.get(strapi.db) === true;
  return false;
}

/**
 * Runs `fn` with the knex transaction that is open in the current async
 * context. `strapi.db.transaction` reuses an open transaction instead of
 * starting a new one.
 */
const withOpenTransaction = (strapi, fn) => strapi.db.transaction(({ trx }) => fn(trx));

/**
 * Takes exclusive, transaction-scoped locks on the given keys and waits for
 * them. Keys are deduplicated and taken in a fixed order, so two callers
 * that lock the same keys cannot deadlock each other.
 *
 * Without an open transaction the lock would end immediately, so nothing is
 * locked and false is returned.
 *
 * @param {Object} strapi Strapi instance.
 * @param {{ id: number, prefix: string }} space Entry of {@link LOCK_SPACES}.
 * @param {string[]} keys Lock keys.
 * @returns {Promise<boolean>} Whether locks were taken.
 * @throws {Error} Database errors, including a detected deadlock.
 */
export async function lockKeys(strapi, space, keys) {
  if (keys.length === 0 || !hasClusterLocks(strapi) || !strapi.db.inTransaction()) return false;
  const byRow = new Map();
  for (const key of keys) {
    const descriptor = lockDescriptor(space, key);
    byRow.set(descriptor.row, descriptor);
  }
  const descriptors = [...byRow.values()].sort((a, b) => a.key2 - b.key2);

  await withOpenTransaction(strapi, async (trx) => {
    if (getDialect(strapi) === 'postgres') {
      for (const { key1, key2 } of descriptors) {
        await trx.raw('select pg_advisory_xact_lock(?, ?)', [key1, key2]);
      }
      return;
    }
    await trx.raw(
      `select name from ?? where name in (${descriptors.map(() => '?').join(', ')}) order by name for update`,
      [tableRef(strapi, LOCK_TABLE), ...descriptors.map((d) => d.row).sort()]
    );
  });
  return true;
}

/**
 * Tries to take a named, transaction-scoped lock without waiting. Must run
 * inside a transaction; the lock is held until that transaction ends.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} name One of {@link NAMED_LOCKS}.
 * @returns {Promise<boolean>} False when another process holds the lock.
 *   True when the lock was taken or cross-process locks are not available.
 * @throws {Error} Database errors other than "lock not available".
 */
export async function tryNamedLock(strapi, name) {
  if (!hasClusterLocks(strapi) || !strapi.db.inTransaction()) return true;
  const { key1, key2, row } = lockDescriptor(LOCK_SPACES.named, name);
  return withOpenTransaction(strapi, async (trx) => {
    if (getDialect(strapi) === 'postgres') {
      const result = await trx.raw('select pg_try_advisory_xact_lock(?, ?) as locked', [
        key1,
        key2,
      ]);
      return result.rows?.[0]?.locked === true;
    }
    try {
      await trx.raw('select name from ?? where name = ? for update nowait', [
        tableRef(strapi, LOCK_TABLE),
        row,
      ]);
      return true;
    } catch (error) {
      if (MYSQL_NOWAIT_ERRNOS.has(error?.errno) || error?.code === PG_LOCK_NOT_AVAILABLE)
        return false;
      throw error;
    }
  });
}

/**
 * Takes a named, transaction-scoped lock and waits for it. Shared holders do
 * not block each other; an exclusive holder blocks everyone else. Must run
 * inside a transaction; the lock is held until that transaction ends.
 *
 * - PostgreSQL: `pg_advisory_xact_lock` / `pg_advisory_xact_lock_shared`.
 * - MySQL / MariaDB: `SELECT ... FOR UPDATE` / `LOCK IN SHARE MODE` on the
 *   lock row (`LOCK IN SHARE MODE` is understood by MySQL 8.4 and MariaDB;
 *   https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html).
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} name One of {@link NAMED_LOCKS}.
 * @param {{ shared?: boolean }} [options] Shared instead of exclusive.
 * @returns {Promise<boolean>} Whether a lock was taken (false without
 *   cross-process locks or outside a transaction).
 * @throws {Error} Database errors, including a detected deadlock.
 */
export async function lockNamed(strapi, name, { shared = false } = {}) {
  if (!hasClusterLocks(strapi) || !strapi.db.inTransaction()) return false;
  const { key1, key2, row } = lockDescriptor(LOCK_SPACES.named, name);
  await withOpenTransaction(strapi, async (trx) => {
    if (getDialect(strapi) === 'postgres') {
      await trx.raw(
        shared ? 'select pg_advisory_xact_lock_shared(?, ?)' : 'select pg_advisory_xact_lock(?, ?)',
        [key1, key2]
      );
      return;
    }
    await trx.raw(
      `select name from ?? where name = ? ${shared ? 'lock in share mode' : 'for update'}`,
      [tableRef(strapi, LOCK_TABLE), row]
    );
  });
  return true;
}

/**
 * Waits until no repair or import is writing, and keeps a new one from
 * starting its writes, until the current transaction ends. Saves that fill
 * an empty write-once field call it before they read the row: otherwise the
 * save could read the row before a running repair commits its value and then
 * overwrite that value once the repair's row lock is released.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {Promise<boolean>} Whether a lock was taken.
 */
export const lockNamedShared = (strapi) => lockNamed(strapi, 'repair-writes', { shared: true });
