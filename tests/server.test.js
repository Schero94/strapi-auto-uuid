import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as uuid from 'uuid';
import register from '../server/src/register.js';
import adminRoutes from '../server/src/routes/admin-api.js';
import contentApiRoutes from '../server/src/routes/content-api.js';
import serviceFactory from '../server/src/services/service.js';

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
  });
});

describe('UUID lifecycle behavior', () => {
  let bootstrap;

  beforeEach(async () => {
    ({ default: bootstrap } = await import('../server/src/bootstrap.js'));
  });

  it.each(['v4', 'v7'])('generates valid prefixed UUID %s values on create', async (version) => {
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'uuid-version': version, 'uuid-prefix': 'art_' }) },
    });
    await bootstrap({ strapi });
    const event = { model: { uid }, params: { data: {} } };

    await getSubscriber().beforeCreate(event);

    const generated = event.params.data[field];
    expect(generated).toMatch(/^art_/);
    expect(uuid.validate(generated.slice(4))).toBe(true);
    expect(generated[4 + 14]).toBe(version === 'v4' ? '4' : '7');
  });

  it('keeps a valid prefixed UUID supplied on create', async () => {
    const supplied = `art_${uuid.v4()}`;
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'uuid-prefix': 'art_' }) },
    });
    await bootstrap({ strapi });
    const event = { model: { uid }, params: { data: { [field]: supplied } } };

    await getSubscriber().beforeCreate(event);

    expect(event.params.data[field]).toBe(supplied);
  });

  it('replaces a supplied UUID that belongs to another document', async () => {
    const supplied = uuid.v4();
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute() },
      existing: (where) => (where[field] === supplied ? { documentId: 'other-document' } : null),
    });
    await bootstrap({ strapi });
    const event = {
      model: { uid },
      params: { data: { documentId: 'new-document', [field]: supplied } },
    };

    await getSubscriber().beforeCreate(event);

    expect(event.params.data[field]).not.toBe(supplied);
    expect(uuid.validate(event.params.data[field])).toBe(true);
  });

  it('retries generated values that collide with another document', async () => {
    const first = uuid.v4();
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute() },
      existing: (where) => (where[field] === first ? { documentId: 'existing-document' } : null),
    });
    const second = uuid.v4();
    vi.mocked(uuid.v4).mockClear();
    const generator = vi.mocked(uuid.v4).mockReturnValueOnce(first).mockReturnValueOnce(second);
    await bootstrap({ strapi });
    const event = { model: { uid }, params: { data: {} } };

    await getSubscriber().beforeCreate(event);

    expect(generator).toHaveBeenCalledTimes(2);
    expect(event.params.data[field]).not.toBe(first);
    expect(uuid.validate(event.params.data[field])).toBe(true);
  });

  it('keeps a UUID already owned by the same document during publish/create lifecycle replay', async () => {
    const existingValue = uuid.v4();
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute() },
      existing: (where) => (where[field] === existingValue ? { documentId: 'doc-1' } : null),
    });
    await bootstrap({ strapi });
    const event = {
      model: { uid },
      params: { data: { documentId: 'doc-1', [field]: existingValue } },
    };

    await getSubscriber().beforeCreate(event);

    expect(event.params.data[field]).toBe(existingValue);
  });

  it('does not change an existing value when a regular update omits the field', async () => {
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute() },
    });
    strapi.getModel = () => ({ collectionName: 'articles' });
    strapi.db.connection = () => ({
      select: () => ({ where: () => ({ first: async () => ({ document_id: 'doc-1' }) }) }),
    });
    await bootstrap({ strapi });
    const event = {
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { title: 'Changed' } },
    };

    await expect(getSubscriber().beforeUpdate(event)).resolves.toBeUndefined();
    expect(event.params.data[field]).toBeUndefined();
  });

  it('rejects invalid and duplicate UUID values on update', async () => {
    const existing = uuid.v4();
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'allow-edit': true }) },
      existing: (where) => (where[field] === existing ? { documentId: 'other-doc' } : null),
    });
    await bootstrap({ strapi });
    const subscriber = getSubscriber();
    const makeEvent = (value) => ({
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { [field]: value } },
    });

    await expect(subscriber.beforeUpdate(makeEvent('bad'))).rejects.toMatchObject({
      name: 'ValidationError',
    });
    await expect(subscriber.beforeUpdate(makeEvent(existing))).rejects.toThrow(/already exists/);
  });

  it('rejects manual UUID changes unless the field explicitly allows editing', async () => {
    const oldValue = uuid.v4();
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute() },
    });
    strapi.db.query = vi.fn(() => ({
      findOne: vi.fn(async ({ where }) =>
        where.documentId === 'doc-1' ? { [field]: oldValue } : null
      ),
    }));
    strapi.getModel = () => ({ collectionName: 'articles' });
    strapi.db.connection = () => ({
      select: () => ({ where: () => ({ first: async () => ({ document_id: 'doc-1' }) }) }),
    });
    await bootstrap({ strapi });
    const unchangedEvent = {
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { [field]: oldValue } },
    };
    await expect(getSubscriber().beforeUpdate(unchangedEvent)).resolves.toBeUndefined();

    const event = {
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { [field]: uuid.v4() } },
    };

    await expect(getSubscriber().beforeUpdate(event)).rejects.toThrow(/immutable/i);
  });

  it('allows valid unique UUID changes when the field opts in to editing', async () => {
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'allow-edit': true }) },
    });
    strapi.getModel = () => ({ collectionName: 'articles' });
    strapi.db.connection = () => ({
      select: () => ({ where: () => ({ first: async () => ({ document_id: 'doc-1' }) }) }),
    });
    await bootstrap({ strapi });
    const event = {
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { [field]: uuid.v7() } },
    };

    await expect(getSubscriber().beforeUpdate(event)).resolves.toBeUndefined();
  });

  it('rejects malformed values when auto-generation is disabled', async () => {
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'disable-auto-generate': true }) },
    });
    await bootstrap({ strapi });
    const event = { model: { uid }, params: { data: { [field]: 'not-valid' } } };

    await expect(getSubscriber().beforeCreate(event)).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });

  it('returns a validation error instead of throwing on non-string prefixed updates', async () => {
    const { strapi, getSubscriber } = makeStrapi({
      attributes: { [field]: uuidAttribute({ 'uuid-prefix': 'art_', 'allow-edit': true }) },
    });
    strapi.getModel = () => ({ collectionName: 'articles' });
    strapi.db.connection = () => ({
      select: () => ({ where: () => ({ first: async () => ({ document_id: 'doc-1' }) }) }),
    });
    await bootstrap({ strapi });
    const event = {
      model: { uid },
      params: { where: { documentId: 'doc-1' }, data: { [field]: { value: 'not-a-string' } } },
    };

    await expect(getSubscriber().beforeUpdate(event)).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });
});

describe('admin custom field registration', () => {
  it('registers the matching UUID field and management settings section', async () => {
    const { default: admin } = await import('../admin/src/index.js');
    const app = {
      registerPlugin: vi.fn(),
      customFields: { register: vi.fn() },
      createSettingSection: vi.fn(),
    };

    admin.register(app);

    expect(app.customFields.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'uuid',
        pluginId: 'field-uuid',
        type: 'string',
        components: expect.objectContaining({ Input: expect.any(Function) }),
        options: expect.objectContaining({ validator: expect.any(Function) }),
      })
    );
    expect(app.createSettingSection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'field-uuid' }),
      expect.arrayContaining([expect.objectContaining({ id: 'management' })])
    );
  });
});
