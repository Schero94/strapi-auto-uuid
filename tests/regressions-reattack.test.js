/**
 * Regression tests for the re-attack findings RA-2 to RA-8 on a real SQLite
 * database (synthetic data only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as uuid from 'uuid';
import { createSqliteHost, UID } from './helpers/sqlite-strapi.js';
import { importMappingsSchema } from '../server/src/controllers/validation.js';
import { IMPORT_LOOKUP_CHUNK } from '../server/src/migrations/index.js';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  splitExport,
} from '../admin/src/utils/exportParts.js';
import { IMPORT_LIMITS } from '../server/src/controllers/validation.js';

let host;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

/** Counts SQL statements issued while `fn` runs. */
const countQueries = async (db, fn) => {
  let count = 0;
  const listener = () => {
    count += 1;
  };
  db.connection.on('query', listener);
  try {
    await fn();
  } finally {
    db.connection.off('query', listener);
  }
  return count;
};

describe('RA-2: repairs keep per-locale values of a localized field', () => {
  it('fills an empty locale with its own value instead of copying another locale', async () => {
    host = await createSqliteHost();
    const en = uuid.v4();
    const now = new Date().toISOString();
    // editableId is localized in the test host; publicId is not.
    await host.insertRaw([
      { documentId: 'doc-a', locale: 'en', editableId: en, publicId: uuid.v4() },
      { documentId: 'doc-a', locale: 'en', editableId: en, publishedAt: now },
      { documentId: 'doc-a', locale: 'de', editableId: null },
      { documentId: 'doc-a', locale: 'de', editableId: null, publishedAt: now },
    ]);
    const before = await host.services.migrations.checkMigrationStatus();
    expect(before.contentTypes.find((ct) => ct.field === 'editableId').emptyCount).toBe(1);

    const result = await host.services.service.generateMissing({ dryRun: false });
    expect(result.failed).toBeUndefined();
    const rows = await host.rows();
    const de = rows.filter((row) => row.locale === 'de').map((row) => row.editableId);
    const enRows = rows.filter((row) => row.locale === 'en').map((row) => row.editableId);
    expect(enRows).toEqual([en, en]);
    expect(de[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(de[0]).not.toBe(en);
    // Draft and published row of the German locale share one new value.
    expect(de[1]).toBe(de[0]);
    // The non-localized field is still shared by every locale of the document.
    const publicIds = new Set(rows.map((row) => row.publicId));
    expect(publicIds.size).toBe(1);
  });

  it('reuses the value of the same locale (draft) for an empty published row', async () => {
    host = await createSqliteHost();
    const deDraft = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', locale: 'en', editableId: uuid.v4() },
      { documentId: 'doc-a', locale: 'de', editableId: deDraft },
      {
        documentId: 'doc-a',
        locale: 'de',
        editableId: null,
        publishedAt: new Date().toISOString(),
      },
    ]);
    await host.services.service.generateMissing({ dryRun: false });
    const de = (await host.rows()).filter((row) => row.locale === 'de');
    expect(de.map((row) => row.editableId)).toEqual([deDraft, deDraft]);
  });
});

describe('RA-4: UUIDs are case-insensitive', () => {
  it('rejects the uppercase spelling of an existing value on create', async () => {
    host = await createSqliteHost();
    const first = await host.inTransaction(() => host.db.query(UID).create({ data: {} }));
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db.query(UID).create({ data: { editableId: first.editableId.toUpperCase() } })
      )
    );
    expect(error?.details?.code).toBe('DUPLICATE_UUID');
  });

  it('stores a new uppercase value in canonical lowercase form', async () => {
    host = await createSqliteHost();
    const chosen = uuid.v4();
    const created = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { editableId: chosen.toUpperCase() } })
    );
    expect(created.editableId).toBe(chosen);
  });

  it('rejects an update to the uppercase spelling of another document value', async () => {
    host = await createSqliteHost();
    const a = await host.inTransaction(() => host.db.query(UID).create({ data: {} }));
    const b = await host.inTransaction(() => host.db.query(UID).create({ data: {} }));
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db.query(UID).update({
          where: { id: b.id },
          data: { editableId: a.editableId.toUpperCase() },
        })
      )
    );
    expect(error?.details?.code).toBe('DUPLICATE_UUID');
  });

  it('keeps an unchanged uppercase legacy value on save', async () => {
    host = await createSqliteHost();
    const upper = uuid.v4().toUpperCase();
    await host.insertRaw([{ documentId: 'doc-a', publicId: upper, editableId: uuid.v4() }]);
    const [row] = await host.rows();
    const updated = await host.inTransaction(() =>
      host.db.query(UID).update({ where: { id: row.id }, data: { title: 'B', publicId: upper } })
    );
    expect(updated.publicId).toBe(upper);
  });

  it('finds and repairs existing case-variant duplicates', async () => {
    host = await createSqliteHost();
    const value = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', publicId: value, editableId: uuid.v4() },
      { documentId: 'doc-b', publicId: value.toUpperCase(), editableId: uuid.v4() },
    ]);
    const status = await host.services.migrations.checkMigrationStatus();
    expect(status.contentTypes.find((ct) => ct.field === 'publicId').duplicateCount).toBe(1);
    const result = await host.services.service.autofix({ dryRun: false });
    expect(result.fixed.duplicates).toBe(1);
    const rows = await host.rows();
    expect(rows[0].publicId).toBe(value);
    expect(rows[1].publicId.toLowerCase()).not.toBe(value);
  });
});

describe('RA-5: the overview counts entries, not field values', () => {
  it('counts a document once even when its content type has two UUID fields', async () => {
    host = await createSqliteHost();
    await host.insertRaw([
      { documentId: 'doc-a', publicId: uuid.v4(), editableId: uuid.v4() },
      { documentId: 'doc-b', publicId: uuid.v4(), editableId: uuid.v4() },
      { documentId: 'doc-c', publicId: uuid.v4(), editableId: uuid.v4() },
    ]);
    const status = await host.services.migrations.checkMigrationStatus();
    expect(status.contentTypes).toHaveLength(2);
    expect(status.totalEntries).toBe(3);
  });
});

describe('RA-3: every export can be imported again', () => {
  const makeExport = (count, { prefix = '', locale } = {}) => ({
    exportedAt: new Date().toISOString(),
    format: 2,
    mappings: {
      'api::ticket.ticket': {
        fields: {
          ticketId: Array.from({ length: count }, (_, i) => ({
            documentId: `doc${String(i).padStart(21, '0')}`,
            ...(locale ? { locale } : {}),
            uuid: `${prefix}${uuid.v4()}`,
          })),
          empty: [],
        },
      },
    },
  });

  it('keeps the client and server limits aligned', () => {
    expect(MAX_IMPORT_ENTRIES).toBe(IMPORT_LIMITS.totalEntries);
  });

  it.each([
    ['small', 50, {}],
    ['many plain values', 25_000, {}],
    ['long prefix and locale', 12_000, { prefix: 'ticket_abcdefghi', locale: 'pt-BR' }],
  ])('splits %s into parts within the body and entry limits', (_label, count, opts) => {
    const data = makeExport(count, opts);
    const parts = splitExport(data);
    const seen = [];
    for (const json of parts) {
      const body = JSON.stringify({ mappings: JSON.parse(json), dryRun: false });
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
      const parsed = importMappingsSchema.safeParse(JSON.parse(body));
      expect(parsed.success).toBe(true);
      for (const ct of Object.values(parsed.data.mappings.mappings)) {
        for (const list of Object.values(ct.fields)) seen.push(...list);
      }
    }
    expect(seen).toEqual(data.mappings['api::ticket.ticket'].fields.ticketId);
    if (count <= 1000) expect(parts).toHaveLength(1);
  });

  it('returns one part for an export without values', () => {
    expect(splitExport({ exportedAt: 'x', format: 2, mappings: {} })).toHaveLength(1);
  });
});

describe('RA-8: imports use batched lookups', () => {
  it('reads targets and conflicts per chunk instead of three queries per entry', async () => {
    host = await createSqliteHost();
    const count = IMPORT_LOOKUP_CHUNK * 2 + 100;
    const seedRows = Array.from({ length: count }, (_, i) => ({
      documentId: `doc-${i}`,
      publicId: uuid.v4(),
      editableId: null,
    }));
    // SQLite limits one compound INSERT to 500 rows.
    for (let i = 0; i < seedRows.length; i += 400) await host.insertRaw(seedRows.slice(i, i + 400));
    const importData = {
      mappings: {
        [UID]: {
          fields: {
            editableId: Array.from({ length: count }, (_, i) => ({
              documentId: `doc-${i}`,
              uuid: uuid.v4(),
            })),
          },
        },
      },
    };
    let preview;
    const queries = await countQueries(host.db, async () => {
      preview = await host.services.migrations.importMappings(importData);
    });
    expect(preview.imported).toBe(count);
    // 3 chunks x 2 lookups; the old code issued 2 to 3 queries per entry.
    expect(queries).toBeLessThanOrEqual(10);

    const applied = await host.services.migrations.importMappings(importData, { dryRun: false });
    expect(applied.imported).toBe(count);
    const rows = await host.rows();
    expect(rows.every((row) => row.editableId)).toBe(true);
  });
});

describe('RA-8: the README index migration makes uniqueness lookups use an index', () => {
  it('turns the lifecycle lookup from a table scan into an index search', async () => {
    host = await createSqliteHost();
    const knex = host.db.connection;
    const plan = async () =>
      (
        await knex.raw(
          'EXPLAIN QUERY PLAN select id from articles where public_id = ? and document_id != ? limit 1',
          ['x', 'y']
        )
      )
        .map((row) => row.detail)
        .join(' | ');
    expect(await plan()).toMatch(/SCAN articles/);

    // Same code as the README example (database/migrations/…uuid-indexes.js).
    const up = async (trx) => {
      for (const [table, column] of [['articles', 'public_id']]) {
        if (!(await trx.schema.hasTable(table)) || !(await trx.schema.hasColumn(table, column))) {
          continue;
        }
        await trx.schema.alterTable(table, (t) => t.index([column], `${table}_${column}_uuid_idx`));
      }
    };
    await knex.transaction(up);
    expect(await plan()).toMatch(/USING INDEX articles_public_id_uuid_idx/);
  });
});
