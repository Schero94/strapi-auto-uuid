/**
 * Real-database test host: boots @strapi/database on a temporary SQLite file
 * (better-sqlite3, the client Strapi uses) with a synthetic content type that
 * has Draft & Publish, a locale column and two UUID fields. The plugin's
 * bootstrap subscribes its lifecycle hooks to this database, and writes are
 * issued the way the Document Service issues them: `db.query()` calls inside
 * `db.transaction()`, with updates addressed by row id.
 *
 * No network, no Strapi server, synthetic data only.
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
 * @param {Object} [opts] Host options.
 * @param {Object} [opts.publicIdOptions] Options of the immutable `publicId` field.
 * @param {Object} [opts.editableIdOptions] Options of the editable `editableId` field.
 * @param {Object} [opts.config] Plugin config.
 * @returns {Promise<Object>} Host with `db`, `strapi`, `insertRaw`, `rows`, `close`.
 */
export async function createSqliteHost({
  publicIdOptions = {},
  editableIdOptions = { 'allow-edit': true },
  config = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-uuid-sqlite-'));
  const logs = [];
  const logger = {
    debug: () => {},
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  };

  const db = new Database({
    connection: {
      client: 'sqlite',
      connection: { filename: join(dir, 'data.db') },
      useNullAsDefault: true,
      // Fail fast if any query waits for the single pooled connection.
      acquireConnectionTimeout: 2000,
    },
    settings: { migrations: { dir: join(dir, 'migrations') }, runMigrations: false },
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
  await db.schema.sync();

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

  await bootstrap({ strapi });

  return {
    db,
    strapi,
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
      await db.destroy();
      delete globalThis.strapi;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
