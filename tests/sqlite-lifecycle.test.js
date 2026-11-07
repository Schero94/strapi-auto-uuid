import { afterEach, describe, expect, it } from 'vitest';
import * as uuid from 'uuid';
import { createSqliteHost, TABLE, UID } from './helpers/sqlite-strapi.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let host;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

/** Runs `fn` and returns the thrown error (or null). */
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe('lifecycles on a real SQLite database (Document Service write pattern)', () => {
  it('a raw knex query inside an open transaction waits for the single SQLite connection', async () => {
    // Control for SEC-01: this is what the old getDocumentIdFromWhere did.
    host = await createSqliteHost();
    await host.insertRaw([{ documentId: 'doc-a', publicId: uuid.v4() }]);
    const started = Date.now();
    const error = await errorOf(() =>
      host.inTransaction(async () => {
        await host.db.query(UID).findOne({ where: { id: 1 } });
        await host.db.connection(TABLE).select('document_id').where('id', 1).first();
      })
    );
    expect(error?.name).toBe('KnexTimeoutError');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it('generates a value on create and accepts an unchanged value on an update by id', async () => {
    host = await createSqliteHost();
    const created = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { title: 'A', documentId: undefined } })
    );
    expect(created.publicId).toMatch(V4);

    const started = Date.now();
    const updated = await host.inTransaction(() =>
      host.db.query(UID).update({
        where: { id: created.id },
        data: { title: 'B', publicId: created.publicId, editableId: created.editableId },
      })
    );
    expect(updated.title).toBe('B');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('create rules', () => {
  it('keeps the value of the same document on publish and on a new locale', async () => {
    host = await createSqliteHost();
    const draft = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { title: 'A' } })
    );
    // Publish copies the draft data with the same documentId.
    const published = await host.inTransaction(() =>
      host.db.query(UID).create({
        data: {
          documentId: draft.documentId,
          publicId: draft.publicId,
          editableId: draft.editableId,
          publishedAt: new Date(),
        },
      })
    );
    expect(published.publicId).toBe(draft.publicId);
    // A new locale of a non-localized field carries the document's value.
    const german = await host.inTransaction(() =>
      host.db.query(UID).create({
        data: { documentId: draft.documentId, locale: 'de', publicId: draft.publicId },
      })
    );
    expect(german.publicId).toBe(draft.publicId);
  });

  it('gives a cloned document (new documentId) a fresh value', async () => {
    host = await createSqliteHost();
    const source = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { title: 'A' } })
    );
    const clone = await host.inTransaction(() =>
      host.db.query(UID).create({
        data: {
          documentId: 'clone-doc-id-000000000001',
          publicId: source.publicId,
          editableId: source.editableId,
        },
      })
    );
    expect(clone.publicId).toMatch(V4);
    expect(clone.publicId).not.toBe(source.publicId);
    expect(clone.editableId).not.toBe(source.editableId);
  });

  it('rejects an explicit duplicate on create for an editable field (no likely-publish bypass)', async () => {
    host = await createSqliteHost();
    const first = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { title: 'A' } })
    );
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db.query(UID).create({ data: { title: 'B', editableId: first.editableId } })
      )
    );
    expect(error?.name).toBe('ValidationError');
    expect(error.details.code).toBe('DUPLICATE_UUID');
  });

  it('replaces a client-chosen value for a server-generated field (allow-edit off)', async () => {
    host = await createSqliteHost();
    const chosen = uuid.v4();
    const created = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { title: 'A', publicId: chosen } })
    );
    expect(created.publicId).toMatch(V4);
    expect(created.publicId).not.toBe(chosen);
  });

  it('keeps a valid unique value supplied for an editable field and rejects malformed ones', async () => {
    host = await createSqliteHost();
    const chosen = uuid.v4();
    const created = await host.inTransaction(() =>
      host.db.query(UID).create({ data: { editableId: chosen } })
    );
    expect(created.editableId).toBe(chosen);
    const error = await errorOf(() =>
      host.inTransaction(() => host.db.query(UID).create({ data: { editableId: 'nope' } }))
    );
    expect(error?.details?.code).toBe('INVALID_UUID');
  });

  it('validates every row of createMany, including duplicates inside the batch', async () => {
    host = await createSqliteHost();
    const shared = uuid.v4();
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db.query(UID).createMany({
          data: [{ editableId: shared }, { editableId: shared }],
        })
      )
    );
    expect(error?.details?.code).toBe('DUPLICATE_UUID');

    await host.inTransaction(() =>
      host.db.query(UID).createMany({ data: [{ documentId: 'bulk-c' }, { documentId: 'bulk-d' }] })
    );
    const rows = await host.rows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => V4.test(row.publicId))).toBe(true);
    expect(rows[0].publicId).not.toBe(rows[1].publicId);
  });
});

describe('update rules', () => {
  it('compares immutability against the exact row, not another locale of the document', async () => {
    host = await createSqliteHost({ editableIdOptions: {} });
    const en = uuid.v4();
    const de = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', locale: 'en', editableId: en },
      { documentId: 'doc-a', locale: 'de', editableId: de },
    ]);
    const [rowEn, rowDe] = await host.rows();

    // Saving the German row with its own unchanged value works.
    await host.inTransaction(() =>
      host.db.query(UID).update({ where: { id: rowDe.id }, data: { title: 'x', editableId: de } })
    );
    // Copying the English value into the German row of a localized field is a change.
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db
          .query(UID)
          .update({ where: { id: rowDe.id }, data: { editableId: rowEn.editableId } })
      )
    );
    expect(error?.details?.code).toBe('IMMUTABLE_UUID');
  });

  it('accepts the i18n copy of a non-localized value into another locale of the same document', async () => {
    host = await createSqliteHost();
    const value = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', locale: 'en', publicId: value },
      { documentId: 'doc-a', locale: 'de', publicId: uuid.v4() },
    ]);
    // Mirrors i18n syncNonLocalizedAttributes: update by documentId + locale.
    await host.inTransaction(() =>
      host.db.query(UID).update({
        where: { documentId: 'doc-a', publishedAt: null, locale: { $eq: 'de' } },
        data: { publicId: value },
      })
    );
    const rows = await host.rows();
    expect(rows.map((row) => row.publicId)).toEqual([value, value]);
  });

  it('rejects changes of immutable values, duplicates and malformed values', async () => {
    host = await createSqliteHost();
    const a = await host.inTransaction(() => host.db.query(UID).create({ data: { title: 'A' } }));
    const b = await host.inTransaction(() => host.db.query(UID).create({ data: { title: 'B' } }));
    const update = (id, data) =>
      errorOf(() => host.inTransaction(() => host.db.query(UID).update({ where: { id }, data })));

    expect((await update(a.id, { publicId: uuid.v4() }))?.details?.code).toBe('IMMUTABLE_UUID');
    expect((await update(a.id, { editableId: b.editableId }))?.details?.code).toBe(
      'DUPLICATE_UUID'
    );
    expect((await update(a.id, { editableId: 'bad' }))?.details?.code).toBe('INVALID_UUID');
    expect(await update(a.id, { editableId: uuid.v4() })).toBeNull();
  });

  it('keeps legacy values after the version or prefix changes and fills empty rows on save', async () => {
    host = await createSqliteHost({
      publicIdOptions: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
    });
    const legacy = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', publicId: legacy },
      { documentId: 'doc-b', publicId: null },
    ]);
    const [a, b] = await host.rows();
    await host.inTransaction(() =>
      host.db.query(UID).update({ where: { id: a.id }, data: { title: 't', publicId: legacy } })
    );
    // Publishing a document with a legacy value keeps it on the published row.
    const published = await host.inTransaction(() =>
      host.db.query(UID).create({
        data: { documentId: 'doc-a', publicId: legacy, publishedAt: new Date() },
      })
    );
    expect(published.publicId).toBe(legacy);

    const filled = await host.inTransaction(() =>
      host.db.query(UID).update({ where: { id: b.id }, data: { title: 't', publicId: '' } })
    );
    expect(filled.publicId.startsWith('art_')).toBe(true);
    expect(filled.publicId[4 + 14]).toBe('7');
  });

  it('blocks bulk updateMany writes of UUIDs across documents outside repairs', async () => {
    host = await createSqliteHost();
    await host.insertRaw([
      { documentId: 'doc-a', editableId: uuid.v4() },
      { documentId: 'doc-b', editableId: uuid.v4() },
    ]);
    const error = await errorOf(() =>
      host.inTransaction(() =>
        host.db.query(UID).updateMany({ where: {}, data: { editableId: uuid.v4() } })
      )
    );
    expect(error?.details?.code).toBe('BULK_UUID_WRITE');
  });
});
