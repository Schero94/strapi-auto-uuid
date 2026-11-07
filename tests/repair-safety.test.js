import { describe, expect, it, vi } from 'vitest';
import * as uuid from 'uuid';
import bootstrap from '../server/src/bootstrap.js';
import migrationsFactory from '../server/src/migrations/index.js';
import serviceFactory from '../server/src/services/service.js';
import { dryRunOnlySchema } from '../server/src/controllers/validation.js';
import { sanitizeUuidAdminReport } from '../server/src/controllers/controller.js';

const uid = 'api::article.article';
const field = 'publicId';
const customField = (options = {}) => ({
  customField: 'plugin::field-uuid.uuid',
  type: 'string',
  options,
});

const createHarness = ({
  options = {},
  rows = [],
  scanError,
  updateError,
  failUpdateAt,
  config = {},
  withLifecycle = false,
} = {}) => {
  const records = rows.map((row) => ({ ...row }));
  let subscriber;
  let transactionRolledBack = false;
  let updateCount = 0;

  const documents = {
    findMany: vi.fn(async ({ filters } = {}) => {
      if (scanError) throw new Error(scanError);
      let matches = records;
      if (filters?.$or) {
        matches = matches.filter((record) =>
          filters.$or.some((condition) => {
            const [key, filter] = Object.entries(condition)[0];
            return filter.$null === true
              ? record[key] === null || record[key] === undefined
              : record[key] === filter;
          })
        );
      }
      return matches.map((record) => ({ ...record }));
    }),
    findFirst: vi.fn(async ({ filters } = {}) =>
      records.find((record) => record.documentId === filters?.documentId) || null
    ),
    update: vi.fn(async ({ documentId, data }) => {
      updateCount += 1;
      if ((updateError && !failUpdateAt) || updateCount === failUpdateAt) {
        throw new Error(updateError || 'simulated write failure');
      }
      const record = records.find((candidate) => candidate.documentId === documentId);
      if (!record) return null;
      if (withLifecycle && subscriber) {
        await subscriber.beforeUpdate({
          model: { uid },
          params: { where: { documentId }, data },
        });
      }
      Object.assign(record, data);
      return { ...record };
    }),
  };

  const strapi = {
    contentTypes: { [uid]: { attributes: { [field]: customField(options) } } },
    config: { get: (_key, fallback = {}) => ({ ...fallback, ...config }) },
    documents: vi.fn(() => documents),
    db: {
      lifecycles: {
        subscribe: vi.fn((value) => {
          subscriber = value;
        }),
      },
      query: vi.fn(() => ({
        findOne: vi.fn(async ({ where }) => {
          const match = records.find((record) => Object.entries(where).every(([key, value]) => {
            if (key === 'documentId' && value && typeof value === 'object' && '$ne' in value) {
              return record.documentId !== value.$ne;
            }
            return record[key] === value;
          }));
          return match ? { documentId: match.documentId, [field]: match[field] } : null;
        }),
      })),
      transaction: vi.fn(async (callback) => {
        const snapshot = records.map((record) => ({ ...record }));
        try {
          return await callback();
        } catch (error) {
          records.splice(0, records.length, ...snapshot);
          transactionRolledBack = true;
          throw error;
        }
      }),
    },
    plugin: vi.fn(() => ({
      service: (name) => (name === 'service' ? service : migrations),
    })),
    admin: { services: { permission: { actionProvider: { registerMany: vi.fn() } } } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const service = serviceFactory({ strapi });
  const migrations = migrationsFactory({ strapi });
  return {
    strapi,
    records,
    documents,
    service,
    migrations,
    getSubscriber: () => subscriber,
    didRollback: () => transactionRolledBack,
  };
};

describe('batch repair safety', () => {
  it('defaults destructive endpoint payloads to dry-run', () => {
    expect(dryRunOnlySchema.parse({})).toEqual({ dryRun: true });
    expect(dryRunOnlySchema.parse({ dryRun: false })).toEqual({ dryRun: false });
  });

  it('keeps duplicate repair read-only when the service option is omitted', async () => {
    const repeated = uuid.v4();
    const harness = createHarness({
      rows: [
        { documentId: 'doc-a', [field]: repeated },
        { documentId: 'doc-b', [field]: repeated },
      ],
    });

    const report = await harness.service.autofix();

    expect(report.dryRun).toBe(true);
    expect(report.totalFixed).toBe(1);
    expect(harness.documents.update).not.toHaveBeenCalled();
    expect(harness.strapi.db.transaction).not.toHaveBeenCalled();
  });

  it('keeps missing-value generation read-only when the service option is omitted', async () => {
    const harness = createHarness({ rows: [{ documentId: 'doc-empty', [field]: null }] });

    const report = await harness.service.generateMissing();

    expect(report.dryRun).toBe(true);
    expect(report.totalGenerated).toBe(1);
    expect(harness.documents.update).not.toHaveBeenCalled();
    expect(harness.strapi.db.transaction).not.toHaveBeenCalled();
  });

  it('generates missing field values with the configured prefix and UUID version', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [{ documentId: 'doc-empty', [field]: null }],
    });

    const report = await harness.service.generateMissing();
    const generated = report.details[uid].fields[field].changes[0].newUuid;

    expect(generated.startsWith('art_')).toBe(true);
    expect(generated.slice(4)[14]).toBe('7');
    expect(report.dryRun).toBe(true);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('redacts record identifiers and UUID values from administrative reports', () => {
    const safe = sanitizeUuidAdminReport({
      details: [{ documentId: 'doc-secret', oldValue: 'uuid-secret', count: 2 }],
      errors: [{ uid, field, message: 'Could not scan this field.' }],
    });

    expect(JSON.stringify(safe)).not.toContain('doc-secret');
    expect(JSON.stringify(safe)).not.toContain('uuid-secret');
    expect(safe.errors[0].message).toBe('Could not scan this field.');
  });
});

describe('field configuration and migration', () => {
  it('reports prefix and UUID-version mismatches as invalid field values', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [
        { documentId: 'doc-valid', [field]: `art_${uuid.v7()}` },
        { documentId: 'doc-wrong-version', [field]: `art_${uuid.v4()}` },
        { documentId: 'doc-wrong-prefix', [field]: uuid.v7() },
      ],
    });

    const status = await harness.migrations.checkMigrationStatus();
    const preview = await harness.migrations.runMigration({
      dryRun: true,
      fixEmpty: false,
      fixDuplicates: false,
    });

    expect(status.contentTypes[0].invalidCount).toBe(2);
    expect(status.needsMigration).toBe(true);
    expect(JSON.stringify(status)).not.toContain('doc-wrong-version');
    expect(JSON.stringify(status)).not.toContain('art_');
    expect(preview.changes.map((change) => change.documentId).sort()).toEqual([
      'doc-wrong-prefix',
      'doc-wrong-version',
    ]);
  });

  it('generates replacements using the field prefix and UUID version', async () => {
    const invalid = `legacy_${uuid.v4()}`;
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [{ documentId: 'doc-invalid', [field]: invalid }],
    });

    const report = await harness.migrations.runMigration({
      fixEmpty: false,
      fixInvalid: true,
      fixDuplicates: false,
    });
    const replacement = report.changes[0].newValue;

    expect(replacement.startsWith('art_')).toBe(true);
    expect(replacement.slice(4)[14]).toBe('7');
    expect(report.dryRun).toBe(true);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('diagnosis and duplicate repair use the field version and prefix', async () => {
    const duplicate = `art_${uuid.v4()}`;
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [
        { documentId: 'doc-keep', [field]: duplicate },
        { documentId: 'doc-repair', [field]: duplicate },
      ],
    });

    const diagnosis = await harness.service.diagnose();
    const repair = await harness.service.autofix();
    const replacement = repair.details[uid].fields[field].changes[0].newUuid;

    expect(diagnosis.details[uid].fields[field].invalidCount).toBe(2);
    expect(replacement.startsWith('art_')).toBe(true);
    expect(replacement.slice(4)[14]).toBe('7');
    expect(repair.dryRun).toBe(true);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('accepts imported values only when they match the field version and prefix', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [{ documentId: 'doc-import', [field]: null }],
    });
    const importData = {
      mappings: {
        [uid]: {
          fields: {
            [field]: [
              { documentId: 'doc-import', uuid: `art_${uuid.v7()}` },
              { documentId: 'doc-import', uuid: `art_${uuid.v4()}` },
            ],
          },
        },
      },
    };

    const report = await harness.migrations.importMappings(importData);

    expect(report.dryRun).toBe(true);
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('imports valid prefixed values through the immutable-field repair context', async () => {
    const imported = `art_${uuid.v7()}`;
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_', 'allow-edit': false },
      rows: [{ documentId: 'doc-import', [field]: null }],
      withLifecycle: true,
    });
    await bootstrap({ strapi: harness.strapi });

    const report = await harness.migrations.importMappings({
      mappings: {
        [uid]: { fields: { [field]: [{ documentId: 'doc-import', uuid: imported }] } },
      },
    }, { dryRun: false });

    expect(report.imported).toBe(1);
    expect(harness.records[0][field]).toBe(imported);
  });

  it('exports the UUID mapping shape used by the import control', async () => {
    const value = `art_${uuid.v7()}`;
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [{ documentId: 'doc-export', [field]: value }],
    });

    const exported = await harness.migrations.exportMappings();

    expect(exported.mappings[uid].fields[field]).toEqual([
      { documentId: 'doc-export', uuid: value },
    ]);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('aborts repairs when any field scan fails and redacts the underlying error', async () => {
    const harness = createHarness({
      scanError: 'SQL failed while reading sensitive row doc-secret',
      rows: [],
    });

    const status = await harness.migrations.checkMigrationStatus();
    const report = await harness.migrations.runMigration({ dryRun: false });

    expect(status.needsMigration).toBe(true);
    expect(status.hasErrors).toBe(true);
    expect(JSON.stringify(status)).not.toContain('doc-secret');
    expect(report.aborted).toBe(true);
    expect(report.totalFixed).toBe(0);
    expect(harness.documents.update).not.toHaveBeenCalled();
  });

  it('rolls back the batch and redacts errors when a repair write fails', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_' },
      rows: [
        { documentId: 'doc-invalid-a', [field]: 'invalid-a' },
        { documentId: 'doc-invalid-b', [field]: 'invalid-b' },
      ],
      updateError: 'database driver details include doc-secret',
      failUpdateAt: 2,
    });

    const report = await harness.migrations.runMigration({
      dryRun: false,
      fixEmpty: false,
      fixInvalid: true,
      fixDuplicates: false,
    });

    expect(report.failed).toBe(true);
    expect(report.rolledBack).toBe(true);
    expect(JSON.stringify(report)).not.toContain('doc-secret');
    expect(harness.didRollback()).toBe(true);
    expect(harness.records.map((record) => record[field])).toEqual(['invalid-a', 'invalid-b']);
  });

  it('allows internal repair writes without enabling manual edits for users', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v7', 'uuid-prefix': 'art_', 'allow-edit': false },
      rows: [{ documentId: 'doc-invalid', [field]: 'invalid' }],
      withLifecycle: true,
    });
    await bootstrap({ strapi: harness.strapi });

    const report = await harness.migrations.runMigration({
      dryRun: false,
      fixEmpty: false,
      fixInvalid: true,
      fixDuplicates: false,
    });

    expect(report.totalFixed).toBe(1);
    expect(harness.records[0][field].startsWith('art_')).toBe(true);
    expect(harness.records[0][field].slice(4)[14]).toBe('7');
    expect((await harness.migrations.checkMigrationStatus()).needsMigration).toBe(false);
    expect(harness.documents.update.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('rejects ordinary immutable-field edits but permits explicit duplicate repair', async () => {
    const repeated = uuid.v4();
    const harness = createHarness({
      rows: [
        { documentId: 'doc-keep', [field]: repeated },
        { documentId: 'doc-repair', [field]: repeated },
      ],
      withLifecycle: true,
    });
    await bootstrap({ strapi: harness.strapi });

    await expect(harness.documents.update({
      documentId: 'doc-repair',
      data: { [field]: uuid.v4() },
    })).rejects.toThrow(/immutable/i);

    const report = await harness.service.autofix({ dryRun: false });

    expect(report.totalFixed).toBe(1);
    expect(harness.records[1][field]).not.toBe(repeated);
  });

  it('rejects invalid UUID versions and prefixes in field configuration', async () => {
    const harness = createHarness({
      options: { 'uuid-version': 'v1', 'uuid-prefix': '../bad' },
      rows: [{ documentId: 'doc-empty', [field]: null }],
    });

    const status = await harness.migrations.checkMigrationStatus();

    expect(status.hasErrors).toBe(true);
    expect(status.needsMigration).toBe(true);
    expect(JSON.stringify(status)).not.toContain('../bad');
  });

  it.each([
    ['aborted', { aborted: true, totalFixed: 0, errors: [{ message: 'scan failed' }] }],
    ['failed', { failed: true, totalFixed: 0, errors: [{ message: 'repair failed' }] }],
  ])('does not log an auto-migration %s result as completed', async (_state, result) => {
    const harness = createHarness({ config: { autoMigrate: true } });
    let scheduledMigration;
    const scheduleImmediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      scheduledMigration = callback;
      return 0;
    });

    vi.spyOn(harness.migrations, 'checkMigrationStatus').mockResolvedValue({
      needsMigration: true,
      totalFields: 1,
    });
    vi.spyOn(harness.migrations, 'runMigration').mockResolvedValue(result);

    try {
      await bootstrap({ strapi: harness.strapi });
      expect(scheduledMigration).toBeTypeOf('function');
      await scheduledMigration();

      const warningLines = harness.strapi.log.warn.mock.calls.map(([message]) => String(message));
      const errorLines = harness.strapi.log.error.mock.calls.map(([message]) => String(message));
      expect(warningLines.some((message) => message.includes('Auto-migration completed'))).toBe(false);
      expect(errorLines.some((message) => message.includes(`Auto-migration ${_state}`))).toBe(true);
    } finally {
      scheduleImmediate.mockRestore();
    }
  });
});
