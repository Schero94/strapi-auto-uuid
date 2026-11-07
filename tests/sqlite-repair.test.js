import { afterEach, describe, expect, it } from 'vitest';
import * as uuid from 'uuid';
import { createSqliteHost } from './helpers/sqlite-strapi.js';

let host;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Seeds a realistic data set (raw SQL, no lifecycles):
 * - doc-a: draft + published sharing value X (not a duplicate), plus a German locale.
 * - doc-b: draft + published that also use X (duplicate of the older doc-a).
 * - doc-c: malformed value on draft and published.
 * - doc-d: draft with a value, published row empty (predates the field).
 * - doc-e: legacy v1 value.
 */
const seed = async () => {
  const x = uuid.v4();
  const d = uuid.v4();
  const legacy = uuid.v1();
  const now = new Date().toISOString();
  const editable = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((k) => [`doc-${k}`, uuid.v4()])
  );
  const rows = [
    { documentId: 'doc-a', publicId: x },
    { documentId: 'doc-a', publicId: x, publishedAt: now },
    { documentId: 'doc-a', locale: 'de', publicId: x },
    { documentId: 'doc-b', publicId: x },
    { documentId: 'doc-b', publicId: x, publishedAt: now },
    { documentId: 'doc-c', publicId: 'not-a-uuid' },
    { documentId: 'doc-c', publicId: 'not-a-uuid', publishedAt: now },
    { documentId: 'doc-d', publicId: d },
    { documentId: 'doc-d', publicId: null, publishedAt: now },
    { documentId: 'doc-e', publicId: legacy },
  ];
  // The second UUID field is clean, so counts below only concern publicId.
  await host.insertRaw(rows.map((row) => ({ ...row, editableId: editable[row.documentId] })));
  return { x, d, legacy };
};

const byDocument = (rows) =>
  rows.reduce((acc, row) => {
    (acc[row.documentId] ||= []).push(row.publicId);
    return acc;
  }, {});

describe('status and diagnosis scan every row (all locales, drafts and published)', () => {
  it('counts per document and does not treat draft/published or locales as duplicates', async () => {
    host = await createSqliteHost();
    await seed();
    const status = await host.services.migrations.checkMigrationStatus();
    const publicId = status.contentTypes.find((ct) => ct.field === 'publicId');
    expect(publicId).toMatchObject({
      entryCount: 5,
      duplicateCount: 1,
      duplicateGroups: 1,
      invalidCount: 1,
      legacyCount: 1,
      emptyCount: 1,
    });
    expect(status.needsMigration).toBe(true);
    expect(JSON.stringify(status)).not.toContain('doc-');
  });

  it('does not report a manual-entry field left empty as needing repair', async () => {
    host = await createSqliteHost({ publicIdOptions: { 'disable-auto-generate': true } });
    await host.insertRaw([{ documentId: 'doc-a', publicId: null, editableId: uuid.v4() }]);
    const status = await host.services.migrations.checkMigrationStatus();
    const publicId = status.contentTypes.find((ct) => ct.field === 'publicId');
    expect(publicId.emptyCount).toBe(0);
    expect(publicId.manualEmptyCount).toBe(1);
    expect(status.needsMigration).toBe(false);
  });
});

describe('repairs', () => {
  it('previews without writing', async () => {
    host = await createSqliteHost();
    await seed();
    const before = await host.rows();
    const result = await host.services.migrations.runMigration();
    expect(result.dryRun).toBe(true);
    expect(result.fixed).toEqual({ empty: 1, invalid: 1, legacy: 0, duplicates: 1 });
    expect(await host.rows()).toEqual(before);
  });

  it('repairs per document, keeps draft and published in sync, keeps the oldest and legacy values', async () => {
    host = await createSqliteHost();
    const { x, d, legacy } = await seed();
    const result = await host.services.migrations.runMigration({ dryRun: false });
    expect(result.failed).toBeUndefined();
    expect(result.totalFixed).toBe(3);

    const docs = byDocument(await host.rows());
    expect(docs['doc-a']).toEqual([x, x, x]);
    expect(new Set(docs['doc-b']).size).toBe(1);
    expect(docs['doc-b'][0]).toMatch(V4);
    expect(docs['doc-b'][0]).not.toBe(x);
    expect(new Set(docs['doc-c']).size).toBe(1);
    expect(docs['doc-c'][0]).toMatch(V4);
    expect(docs['doc-d']).toEqual([d, d]);
    expect(docs['doc-e']).toEqual([legacy]);

    const after = await host.services.migrations.checkMigrationStatus();
    expect(after.needsMigration).toBe(false);
  });

  it('generates replacements with the field prefix and UUID version', async () => {
    host = await createSqliteHost({
      publicIdOptions: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
    });
    const shared = `art_${uuid.v7()}`;
    await host.insertRaw([
      { documentId: 'doc-a', publicId: shared, editableId: uuid.v4() },
      { documentId: 'doc-b', publicId: shared, editableId: uuid.v4() },
      { documentId: 'doc-c', publicId: null, editableId: uuid.v4() },
    ]);
    await host.services.migrations.runMigration({ dryRun: false });
    const values = (await host.rows()).map((row) => row.publicId);
    expect(values[0]).toBe(shared);
    for (const value of values.slice(1)) {
      expect(value.startsWith('art_')).toBe(true);
      expect(uuid.validate(value.slice(4))).toBe(true);
      expect(value[4 + 14]).toBe('7');
    }
    expect(new Set(values).size).toBe(3);
  });

  it('replaces legacy values only when explicitly requested', async () => {
    host = await createSqliteHost();
    const { legacy } = await seed();
    await host.services.migrations.runMigration({
      dryRun: false,
      fixEmpty: false,
      fixInvalid: false,
      fixDuplicates: false,
      fixLegacy: true,
    });
    const docs = byDocument(await host.rows());
    expect(docs['doc-e'][0]).not.toBe(legacy);
    expect(docs['doc-e'][0]).toMatch(V4);
  });

  it('autofix and generate-missing are focused subsets of the repair', async () => {
    host = await createSqliteHost();
    await seed();
    const fix = await host.services.service.autofix({ dryRun: false });
    expect(fix.fixed).toEqual({ empty: 0, invalid: 0, legacy: 0, duplicates: 1 });
    const gen = await host.services.service.generateMissing({ dryRun: false });
    expect(gen.totalGenerated).toBe(1);
    const docs = byDocument(await host.rows());
    expect(docs['doc-c']).toEqual(['not-a-uuid', 'not-a-uuid']);
  });

  it('refuses a second repair while one is running (409 path)', async () => {
    host = await createSqliteHost();
    await seed();
    const first = host.services.migrations.runMigration({ dryRun: false });
    await expect(host.services.migrations.runMigration({ dryRun: false })).rejects.toMatchObject({
      code: 'REPAIR_IN_PROGRESS',
    });
    await first;
  });

  it('rolls the whole repair back when a write fails', async () => {
    host = await createSqliteHost();
    await seed();
    const before = await host.rows();
    const original = host.db.query.bind(host.db);
    let calls = 0;
    host.db.query = (uid) => {
      const repo = original(uid);
      return {
        ...repo,
        updateMany: async (params) => {
          calls += 1;
          if (calls === 2) throw new Error('simulated failure');
          return repo.updateMany(params);
        },
      };
    };
    const result = await host.services.migrations.runMigration({ dryRun: false });
    host.db.query = original;
    expect(result).toMatchObject({ failed: true, rolledBack: true, totalFixed: 0 });
    expect(await host.rows()).toEqual(before);
  });
});

describe('export and import', () => {
  it('round-trips mappings with locales and never replaces existing values', async () => {
    host = await createSqliteHost();
    const value = uuid.v4();
    const other = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', locale: 'en', editableId: value },
      {
        documentId: 'doc-a',
        locale: 'en',
        editableId: value,
        publishedAt: new Date().toISOString(),
      },
      { documentId: 'doc-b', locale: 'en', editableId: null },
      { documentId: 'doc-c', locale: 'en', editableId: other },
    ]);
    const exported = await host.services.migrations.exportMappings();
    expect(exported.format).toBe(2);
    expect(exported.mappings['api::article.article'].fields.editableId).toEqual([
      { documentId: 'doc-a', locale: 'en', uuid: value },
      { documentId: 'doc-c', locale: 'en', uuid: other },
    ]);

    const fresh = uuid.v4();
    const importData = {
      mappings: {
        'api::article.article': {
          fields: {
            editableId: [
              { documentId: 'doc-a', locale: 'en', uuid: value }, // unchanged
              { documentId: 'doc-b', locale: 'en', uuid: fresh }, // fills empty
              { documentId: 'doc-c', locale: 'en', uuid: uuid.v4() }, // has a value
              { documentId: 'doc-x', uuid: uuid.v4() }, // missing
            ],
          },
        },
      },
    };
    const preview = await host.services.migrations.importMappings(importData);
    expect(preview).toMatchObject({ dryRun: true, imported: 1, unchanged: 1, skipped: 2 });
    expect(preview.errorCounts).toEqual({ TARGET_HAS_VALUE: 1, TARGET_NOT_FOUND: 1 });

    const result = await host.services.migrations.importMappings(importData, { dryRun: false });
    expect(result.imported).toBe(1);
    const docs = byDocument(
      (await host.rows()).map((row) => ({ ...row, publicId: row.editableId }))
    );
    expect(docs['doc-b']).toEqual([fresh]);
    expect(docs['doc-c']).toEqual([other]);
  });

  it('rejects values that conflict with another document or repeat in the file', async () => {
    host = await createSqliteHost();
    const taken = uuid.v4();
    await host.insertRaw([
      { documentId: 'doc-a', editableId: taken },
      { documentId: 'doc-b', editableId: null },
      { documentId: 'doc-c', editableId: null },
    ]);
    const repeated = uuid.v4();
    const result = await host.services.migrations.importMappings(
      {
        mappings: {
          'api::article.article': {
            fields: {
              editableId: [
                { documentId: 'doc-b', uuid: taken },
                { documentId: 'doc-c', uuid: repeated },
                { documentId: 'doc-b', uuid: repeated },
              ],
            },
          },
        },
      },
      { dryRun: false }
    );
    expect(result.errorCounts).toEqual({ IMPORT_CONFLICT: 1, DUPLICATE_TARGET: 1 });
    expect(result.imported).toBe(1);
  });
});
