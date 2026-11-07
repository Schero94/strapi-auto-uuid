import { describe, expect, it, vi } from 'vitest';
import * as uuid from 'uuid';
import bootstrap from '../server/src/bootstrap.js';
import { dryRunOnlySchema, migrationRunSchema } from '../server/src/controllers/validation.js';
import { sanitizeUuidAdminReport } from '../server/src/controllers/controller.js';
import { groupDuplicates } from '../server/src/utils/uuid-models.js';
import {
  classifyUuidFieldValue,
  generateUuidFieldValue,
  validateUuidFieldOptions,
} from '../shared/uuid-field.js';

const uid = 'api::article.article';
const customField = (options = {}) => ({ customField: 'plugin::field-uuid.uuid', options });

const makeStrapi = ({ config = {}, components = {}, migrations } = {}) => ({
  contentTypes: { [uid]: { attributes: { publicId: customField() } } },
  components,
  config: { get: (_key, fallback = {}) => ({ ...fallback, ...config }) },
  db: { lifecycles: { subscribe: vi.fn() } },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  plugin: () => ({ service: () => migrations }),
});

describe('request defaults', () => {
  it('defaults destructive endpoint payloads to a preview', () => {
    expect(dryRunOnlySchema.parse({})).toEqual({ dryRun: true });
    expect(migrationRunSchema.parse({})).toEqual({
      dryRun: true,
      fixEmpty: true,
      fixInvalid: true,
      fixDuplicates: true,
      fixLegacy: false,
    });
  });

  it('redacts record identifiers, values and change lists from reports', () => {
    const report = sanitizeUuidAdminReport({
      totalFixed: 1,
      changes: [{ documentId: 'doc-private', newValue: 'value-private' }],
      details: { [uid]: { fields: { publicId: { documentIds: ['doc-private'], count: 2 } } } },
    });
    expect(JSON.stringify(report)).not.toMatch(/private/);
    expect(report.details[uid].fields.publicId.count).toBe(2);
  });
});

describe('shared field rules', () => {
  it('classifies empty, valid, legacy and malformed values', () => {
    const options = { version: 'v7', prefix: 'art_' };
    expect(classifyUuidFieldValue('', options)).toBe('empty');
    expect(classifyUuidFieldValue(generateUuidFieldValue(options), options)).toBe('valid');
    expect(classifyUuidFieldValue(uuid.v4(), options)).toBe('legacy');
    expect(classifyUuidFieldValue(`usr_${uuid.v7()}`, options)).toBe('legacy');
    expect(classifyUuidFieldValue('not-a-uuid', options)).toBe('malformed');
    expect(classifyUuidFieldValue(`../${uuid.v7()}`, options)).toBe('malformed');
  });

  it('rejects invalid versions, prefixes and option types', () => {
    expect(validateUuidFieldOptions({ 'uuid-version': 'v1' }).valid).toBe(false);
    expect(validateUuidFieldOptions({ 'uuid-prefix': 'a'.repeat(17) }).valid).toBe(false);
    expect(validateUuidFieldOptions({ 'uuid-prefix': 'bad prefix' }).valid).toBe(false);
    expect(validateUuidFieldOptions({ 'allow-edit': 'yes' }).valid).toBe(false);
    expect(validateUuidFieldOptions({ 'uuid-prefix': 'art_' }).valid).toBe(true);
  });

  it('groups duplicates by distinct document and keeps the oldest first', () => {
    const rows = [
      { id: 1, documentId: 'a', publicId: 'X' },
      { id: 2, documentId: 'a', publicId: 'X' },
      { id: 3, documentId: 'b', publicId: 'Y' },
      { id: 4, documentId: 'c', publicId: 'X' },
    ];
    expect(groupDuplicates(rows, 'publicId')).toEqual([
      { uuid: 'X', count: 2, documentIds: ['a', 'c'] },
    ]);
    // A repeated row of one document is never a duplicate group.
    expect(groupDuplicates([rows[0], rows[0]], 'publicId')).toEqual([]);
  });
});

describe('bootstrap', () => {
  it('warns about UUID fields inside components and does not claim a database constraint', async () => {
    const strapi = makeStrapi({
      components: { 'shared.meta': { attributes: { ref: customField() } } },
    });
    await bootstrap({ strapi });
    const warnings = strapi.log.warn.mock.calls.flat().join('\n');
    expect(warnings).toContain('shared.meta.ref');
    expect(warnings).not.toMatch(/unique/i);
    expect(strapi.db.lifecycles.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ models: [uid] })
    );
  });

  it('refuses an invalid plugin configuration', async () => {
    await expect(
      bootstrap({ strapi: makeStrapi({ config: { logLevel: 'loud' } }) })
    ).rejects.toThrow(/logLevel/);
  });

  it.each([
    [{ aborted: true, errors: [{}] }, 'aborted'],
    [{ failed: true, errors: [{}] }, 'failed'],
  ])('logs a boot repair result %j as not completed', async (result, word) => {
    const migrations = { runMigration: vi.fn(async () => result) };
    const strapi = makeStrapi({ config: { autoMigrate: true }, migrations });
    await bootstrap({ strapi });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(migrations.runMigration).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, fixLegacy: false })
    );
    expect(strapi.log.error.mock.calls.flat().join(' ')).toContain(word);
  });
});

describe('rate limit middleware', () => {
  it('answers 429 with a stable code and Retry-After once the window is used up', async () => {
    const { default: rateLimit } = await import('../server/src/middlewares/rate-limit.js');
    const strapi = { log: { warn: vi.fn() } };
    const limit = rateLimit({ max: 1, window: 60_000 }, { strapi });
    const ctx = () => ({
      path: '/field-uuid/rate-test',
      state: { user: { id: 42 } },
      request: { ip: '203.0.113.7' },
      set: vi.fn(),
    });
    const next = vi.fn();
    await limit(ctx(), next);
    const blocked = ctx();
    await limit(blocked, next);
    expect(next).toHaveBeenCalledOnce();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.code).toBe('RATE_LIMITED');
    expect(blocked.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
});
