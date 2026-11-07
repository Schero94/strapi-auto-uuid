import { describe, expect, it, vi } from 'vitest';
import * as yup from 'yup';
import admin, { uuidOptionsValidator } from '../admin/src/index.js';

const register = () => {
  const app = {
    registerPlugin: vi.fn(),
    addSettingsLink: vi.fn(),
    customFields: { register: vi.fn() },
  };
  admin.register(app);
  return { app, field: app.customFields.register.mock.calls[0][0] };
};

describe('UUID custom-field registration', () => {
  it('registers select options with the Content-Type Builder metadata shape', () => {
    const { field } = register();
    const version = field.options.base
      .flatMap((section) => section.items || [])
      .find((item) => item.name === 'options.uuid-version');

    expect(field).toMatchObject({ name: 'uuid', pluginId: 'field-uuid', type: 'string' });
    expect(version.options.map((option) => option.value)).toEqual(['v4', 'v7']);
    expect(version.options.every((option) => option.key && option.metadatas?.intlLabel)).toBe(true);

    const unique = field.options.advanced
      .flatMap((section) => section.items || [])
      .find((item) => item.name === 'unique');
    expect(unique?.defaultValue).toBe(true);
    // Strapi 5 does not create a database constraint for `unique`.
    expect(unique.description.defaultMessage).toMatch(/not a database constraint/);
  });

  it('returns yup schemas that the Content-Type Builder can merge into its object schema', () => {
    const schema = yup.object().shape(uuidOptionsValidator());
    expect(schema.isValidSync({ 'uuid-version': 'v7', 'uuid-prefix': 'art_' })).toBe(true);
    expect(schema.isValidSync({ 'uuid-version': 'v1' })).toBe(false);
    expect(schema.isValidSync({ 'uuid-prefix': '../bad' })).toBe(false);
    expect(schema.isValidSync({ 'uuid-prefix': 'a'.repeat(17) })).toBe(false);
    expect(() => schema.validateSync({ 'uuid-prefix': 'bad prefix' })).toThrow(
      'field-uuid.field.options.prefix.error'
    );
  });

  it('registers the settings link with the read permission', () => {
    const { app } = register();
    expect(app.addSettingsLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'field-uuid' }),
      expect.objectContaining({
        id: 'management',
        to: 'field-uuid/management',
        permissions: [{ action: 'plugin::field-uuid.read', subject: null }],
      })
    );
  });
});
