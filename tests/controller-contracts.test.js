import { describe, expect, it, vi } from 'vitest';
import controllerFactory from '../server/src/controllers/controller.js';

const uid = 'api::article.article';
const field = 'publicId';

const createController = ({ service = {}, migrations = {} } = {}) => {
  const strapi = {
    plugin: vi.fn(() => ({
      service: (name) => (name === 'service' ? service : migrations),
    })),
    log: { warn: vi.fn(), error: vi.fn() },
  };
  return { controller: controllerFactory({ strapi }), strapi };
};

describe('admin controller contracts', () => {
  it('passes safe defaults to batch endpoints and redacts record data', async () => {
    const service = {
      autofix: vi.fn(async () => ({
        dryRun: true,
        totalFixed: 1,
        changes: [{ documentId: 'doc-private', oldUuid: 'uuid-private', newUuid: 'uuid-new' }],
      })),
      generateMissing: vi.fn(async () => ({ dryRun: true, totalGenerated: 0 })),
    };
    const migrations = {
      runMigration: vi.fn(async () => ({ dryRun: true, fixed: {}, changes: [] })),
    };
    const { controller } = createController({ service, migrations });
    const autofixContext = { request: { body: {} }, state: { user: { id: 4 } } };
    const generateContext = { request: { body: {} }, state: { user: { id: 4 } } };
    const migrationContext = { request: { body: {} }, state: { user: { id: 4 } } };

    await controller.autofix(autofixContext);
    await controller.generateMissing(generateContext);
    await controller.runMigration(migrationContext);

    expect(service.autofix).toHaveBeenCalledWith({ dryRun: true });
    expect(service.generateMissing).toHaveBeenCalledWith({ dryRun: true });
    expect(migrations.runMigration).toHaveBeenCalledWith({
      dryRun: true,
      fixEmpty: true,
      fixInvalid: true,
      fixDuplicates: true,
    });
    expect(JSON.stringify(autofixContext.body)).not.toContain('doc-private');
    expect(JSON.stringify(autofixContext.body)).not.toContain('uuid-private');
  });

  it('preserves explicitly disabled migration options from the settings controls', async () => {
    const migrations = {
      runMigration: vi.fn(async () => ({ dryRun: true, fixed: {}, changes: [] })),
    };
    const { controller } = createController({ migrations });

    await controller.runMigration({
      request: {
        body: {
          dryRun: true,
          fixEmpty: false,
          fixInvalid: true,
          fixDuplicates: false,
        },
      },
      state: { user: { id: 7 } },
    });

    expect(migrations.runMigration).toHaveBeenCalledWith({
      dryRun: true,
      fixEmpty: false,
      fixInvalid: true,
      fixDuplicates: false,
    });
  });

  it('keeps import preview and overwrite protections at the controller boundary', async () => {
    const mappings = {
      version: '1.0.0',
      mappings: {
        [uid]: {
          fields: {
            [field]: [{ documentId: 'doc-1', uuid: '550e8400-e29b-41d4-a716-446655440000' }],
          },
        },
      },
    };
    const migrations = {
      importMappings: vi.fn(async () => ({ dryRun: true, imported: 1, errors: [] })),
    };
    const { controller } = createController({ migrations });
    const ctx = {
      request: { body: { mappings } },
      state: { user: { id: 9 } },
    };

    await controller.importMappings(ctx);

    expect(migrations.importMappings).toHaveBeenCalledWith(mappings, {
      dryRun: true,
      overwrite: false,
      actor: 9,
    });
    expect(ctx.body).toMatchObject({ dryRun: true, imported: 1 });
  });

  it('surfaces incomplete scan state without returning record values', async () => {
    const migrations = {
      checkMigrationStatus: vi.fn(async () => ({
        needsMigration: true,
        hasErrors: true,
        issues: [{ uid, field, operation: 'scan', message: 'Could not scan this field.', value: 'private' }],
      })),
    };
    const { controller } = createController({ migrations });
    const ctx = {};

    await controller.getMigrationStatus(ctx);

    expect(ctx.body).toMatchObject({ needsMigration: true, hasErrors: true });
    expect(JSON.stringify(ctx.body)).not.toContain('private');
    expect(ctx.body.issues[0].message).toBe('Could not scan this field.');
  });

  it('returns status aggregates and keeps the explicit export payload intact', async () => {
    const service = {
      getUuidModels: vi.fn(() => ({ [uid]: [field] })),
    };
    const mappings = { exportedAt: '2026-10-14T00:00:00.000Z', mappings: { [uid]: { fields: {} } } };
    const migrations = {
      checkMigrationStatus: vi.fn(async () => ({
        needsMigration: false,
        hasErrors: false,
        totalEntries: 3,
        totalFields: 1,
        contentTypes: [{ emptyCount: 0, invalidCount: 0, duplicateCount: 0 }],
      })),
      exportMappings: vi.fn(async () => mappings),
    };
    const { controller } = createController({ service, migrations });
    const statsContext = {};
    const exportContext = { set: vi.fn() };

    await controller.getStats(statsContext);
    await controller.exportMappings(exportContext);

    expect(statsContext.body).toMatchObject({
      contentTypes: 1,
      totalFields: 1,
      totalEntries: 3,
      hasErrors: false,
    });
    expect(exportContext.body).toBe(mappings);
    expect(exportContext.set).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(exportContext.set).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('uuid-mappings-'));
  });
});
