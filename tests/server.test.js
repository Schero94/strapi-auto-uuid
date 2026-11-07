import { describe, expect, it, vi } from 'vitest';
import * as uuid from 'uuid';
import register from '../server/src/register.js';
import adminRoutes from '../server/src/routes/admin-api.js';
import contentApiRoutes from '../server/src/routes/content-api.js';
import serviceFactory from '../server/src/services/service.js';
import pluginConfig, { normalizePluginConfig } from '../server/src/config/index.js';

vi.mock('uuid', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    v4: vi.fn(actual.v4),
    v7: vi.fn(actual.v7),
  };
});

vi.mock('@strapi/utils', () => ({
  errors: {
    ValidationError: class ValidationError extends Error {
      constructor(message, details) {
        super(message);
        this.name = 'ValidationError';
        this.details = details;
      }
    },
    ApplicationError: class ApplicationError extends Error {
      constructor(message) {
        super(message);
        this.name = 'ApplicationError';
      }
    },
  },
}));

const uid = 'api::article.article';
const field = 'publicId';
const makeStrapi = ({ attributes = {}, config = {}, existing = () => null } = {}) => {
  let subscriber;
  const strapi = {
    contentTypes: { [uid]: { attributes } },
    config: { get: (_key, fallback) => ({ ...fallback, ...config }) },
    customFields: { register: vi.fn() },
    db: {
      lifecycles: {
        subscribe: vi.fn((value) => {
          subscriber = value;
        }),
      },
      query: vi.fn(() => ({ findOne: vi.fn(async ({ where }) => existing(where)) })),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    admin: { services: { permission: { actionProvider: { registerMany: vi.fn() } } } },
  };
  return { strapi, getSubscriber: () => subscriber };
};

const uuidAttribute = (options = {}) => ({
  customField: 'plugin::field-uuid.uuid',
  options,
});

describe('UUID generation service', () => {
  it.each(['v4', 'v7'])('generates valid, unique %s identifiers', (version) => {
    const service = serviceFactory({
      strapi: { config: { get: () => ({ defaultVersion: version }) } },
    });
    const values = Array.from({ length: 200 }, () => service.generate());

    expect(values.every(uuid.validate)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => value[14] === (version === 'v4' ? '4' : '7'))).toBe(true);
  });

  it('preserves valid UUID values and replaces malformed values', () => {
    const service = serviceFactory({
      strapi: { config: { get: () => ({ defaultVersion: 'v7' }) } },
    });
    const valid = uuid.v4();

    expect(service.ensureUuid(valid)).toBe(valid);
    expect(service.validate(valid)).toBe(true);
    expect(uuid.validate(service.ensureUuid('not-a-uuid'))).toBe(true);
    expect(service.ensureUuid('not-a-uuid')[14]).toBe('7');
  });

  it('retries field-specific UUID collisions and keeps the configured prefix', async () => {
    const first = uuid.v7();
    const second = uuid.v7();
    vi.mocked(uuid.v7).mockClear();
    const generator = vi.mocked(uuid.v7).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { strapi } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'uuid-version': 'v7', 'uuid-prefix': 'art_' }) },
      existing: (where) => (where[field] === `art_${first}` ? { id: 1 } : null),
    });
    const service = serviceFactory({ strapi });

    await expect(service.generateUniqueFieldValue(uid, field)).resolves.toBe(`art_${second}`);
    expect(generator).toHaveBeenCalledTimes(2);
  });
});

describe('custom field registration', () => {
  it('registers a server string field under the same plugin key used by the admin', () => {
    const { strapi } = makeStrapi();

    register({ strapi });

    expect(strapi.customFields.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'uuid',
        plugin: 'field-uuid',
        type: 'string',
        inputSize: { default: 12, isResizable: true },
      })
    );
  });
});

describe('plugin configuration', () => {
  it('rejects unsupported default UUID versions and unsafe retry counts', () => {
    expect(() => pluginConfig.validator({ defaultVersion: 'v1' })).toThrow(/defaultVersion/);
    expect(() => pluginConfig.validator({ maxRetryAttempts: 0 })).toThrow(/maxRetryAttempts/);
    expect(() => pluginConfig.validator({ maxRetryAttempts: 2.5 })).toThrow(/maxRetryAttempts/);
    expect(() => pluginConfig.validator({ maxRetryAttempts: 1e9 })).toThrow(/maxRetryAttempts/);
    expect(() => pluginConfig.validator({ validateUniqueness: 'yes' })).toThrow(
      /validateUniqueness/
    );
    expect(() => pluginConfig.validator({ autoGenrate: false })).toThrow(/autoGenrate/);
  });

  it('accepts the defaults and the deprecated allowManualEdit key without using it', () => {
    expect(() => pluginConfig.validator(pluginConfig.default)).not.toThrow();
    expect(normalizePluginConfig({ allowManualEdit: true, maxRetryAttempts: 5 })).toEqual({
      ...pluginConfig.default,
      maxRetryAttempts: 5,
    });
  });
});

describe('administrative route access', () => {
  it('requires an authenticated administrator and explicit permission for every endpoint', () => {
    for (const route of adminRoutes.routes) {
      expect(route.config.policies).toContain('admin::isAuthenticatedAdmin');
      if (route.path !== '/health') {
        expect(route.config.policies).toContainEqual(
          expect.objectContaining({
            name: 'admin::hasPermissions',
          })
        );
      }
    }
    expect(contentApiRoutes.routes).toEqual([]);
    expect(adminRoutes.routes.map((route) => route.path)).not.toContain('/check-duplicate');
  });
});
