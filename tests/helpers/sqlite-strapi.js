/**
 * Real-database test host: boots @strapi/database on a temporary SQLite file
 * (better-sqlite3, the client Strapi uses) or, with `client: 'postgres'`, in a
 * fresh schema of a PostgreSQL database, with a synthetic content type that
 * has Draft & Publish, a locale column and two UUID fields. The plugin's
 * bootstrap subscribes its lifecycle hooks to this database, and writes are
 * issued the way the Document Service issues them: `db.query()` calls inside
 * `db.transaction()`, with updates addressed by row id.
 *
 * No network (PostgreSQL only on the given local URL), no Strapi server,
 * synthetic data only.
 *
 * Several processes can attach to one database: the first host creates it
 * (`attach: false`), the others pass the same `filename` or `schema` with
 * `attach: true` and skip schema sync and cleanup.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '@strapi/database';
import bootstrap from '../../server/src/bootstrap.js';
import serviceFactory from '../../server/src/services/service.js';
import migrationsFactory from '../../server/src/migrations/index.js';

export const UID = 'api::article.article';
export const TABLE = 'articles';

const uuidField = (options, extra = {}) => ({
  type: 'string',
  customField: 'plugin::field-uuid.uuid',
  options,
  ...extra,
});

/**
 * Parses a postgres:// URL into a knex connection object.
 *
 * @param {string} url Connection URL.
 * @param {string} schema Schema name.
 * @returns {Object} knex `connection`.
 */
const pgConnection = (url, schema) => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password) || undefined,
    database: parsed.pathname.slice(1),
    schema,
  };
};

/**
 * @param {Object} [opts] Host options.
 * @param {Object} [opts.publicIdOptions] Options of the immutable `publicId` field.
 * @param {Object} [opts.editableIdOptions] Options of the editable `editableId` field.
 * @param {Object} [opts.config] Plugin config.
 * @param {'sqlite'|'postgres'} [opts.client] Database client.
 * @param {string} [opts.pgUrl] PostgreSQL URL (client 'postgres').
 * @param {string} [opts.schema] PostgreSQL schema to create or attach to.
 * @param {string} [opts.filename] SQLite file to attach to.
 * @param {boolean} [opts.attach] Attach to an existing database (no sync, no cleanup).
 * @param {boolean} [opts.runBootstrap] Run the plugin bootstrap (default true).
 * @returns {Promise<Object>} Host with `db`, `strapi`, `insertRaw`, `rows`, `close`.
 */
export async function createSqliteHost({
  publicIdOptions = {},
  editableIdOptions = { 'allow-edit': true },
  config = {},
  client = 'sqlite',
  pgUrl = process.env.AUTO_UUID_PG_URL,
  schema = `auto_uuid_${randomBytes(6).toString('hex')}`,
  filename,
  attach = false,
  runBootstrap = true,
} = {}) {
  const dir = filename ? null : mkdtempSync(join(tmpdir(), 'auto-uuid-sqlite-'));
  const sqliteFile = filename ?? join(dir, 'data.db');
  const logs = [];
  const logger = {
    debug: () => {},
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  };

  if (client === 'postgres' && !attach) {
    const { default: pg } = await import('pg');
    const admin = new pg.Client(pgConnection(pgUrl));
    await admin.connect();
    await admin.query(`create schema if not exists "${schema}"`);
    await admin.end();
  }

  const connection =
    client === 'postgres'
      ? { client: 'postgres', connection: pgConnection(pgUrl, schema), pool: { min: 0, max: 5 } }
      : {
          client: 'sqlite',
          connection: { filename: sqliteFile },
          useNullAsDefault: true,
          // Fail fast if any query waits for the single pooled connection.
          acquireConnectionTimeout: attach ? 20000 : 2000,
        };
  const db = new Database({
    connection,
    settings: {
      migrations: { dir: join(dir ?? tmpdir(), 'migrations') },
      runMigrations: false,
    },
    logger,
  });

  const attributes = {
    id: { type: 'increments' },
    // Strapi core assigns documentId through a column default during processData.
    documentId: { type: 'string', default: () => randomBytes(12).toString('hex') },
    title: { type: 'string' },
    locale: { type: 'string' },
    publishedAt: { type: 'datetime' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    publicId: uuidField(publicIdOptions),
    editableId: uuidField(editableIdOptions, { pluginOptions: { i18n: { localized: true } } }),
  };

  await db.init({
    models: [{ uid: UID, singularName: 'article', tableName: TABLE, attributes }],
  });
  if (!attach) await db.schema.sync();

  const services = {};
  const strapi = {
    db,
    contentTypes: { [UID]: { uid: UID, attributes, options: { draftAndPublish: true } } },
    components: {},
    config: { get: (_key, fallback = {}) => ({ ...fallback, ...config }) },
    log: logger,
    admin: undefined,
    plugin: () => ({ service: (name) => services[name] }),
  };
  // The entity manager reads `strapi.db` from the global, as in a Strapi app.
  globalThis.strapi = strapi;
  services.service = serviceFactory({ strapi });
  services.migrations = migrationsFactory({ strapi });

  if (runBootstrap) await bootstrap({ strapi });

  return {
    db,
    strapi,
    client,
    schema,
    filename: sqliteFile,
    logs,
    services,
    /** Inserts rows without lifecycles (raw SQL, outside any transaction). */
    insertRaw: (rows) =>
      db.connection(TABLE).insert(
        rows.map((row) => ({
          document_id: row.documentId,
          title: row.title ?? 'synthetic',
          locale: row.locale ?? 'en',
          published_at: row.publishedAt ?? null,
          public_id: row.publicId ?? null,
          editable_id: row.editableId ?? null,
        }))
      ),
    /** Reads all rows in id order. */
    rows: () =>
      db.query(UID).findMany({
        select: ['id', 'documentId', 'locale', 'publishedAt', 'publicId', 'editableId'],
        orderBy: { id: 'asc' },
      }),
    /** Mirrors Document Service writes: a transaction around db.query calls. */
    inTransaction: (fn) => db.transaction(fn),
    close: async () => {
      if (client === 'postgres' && !attach) {
        await db.connection.raw(`drop schema if exists "${schema}" cascade`);
      }
      await db.destroy();
      delete globalThis.strapi;
      if (dir && !attach) rmSync(dir, { recursive: true, force: true });
    },
  };
}
