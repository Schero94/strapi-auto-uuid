import { describe, expect, it, vi } from 'vitest';
import admin from '../admin/src/index.js';

describe('UUID custom-field registration', () => {
  it('registers select options with the Content-Type Builder metadata shape', () => {
    const app = {
      registerPlugin: vi.fn(),
      addMenuLink: vi.fn(),
      createSettingSection: vi.fn(),
      customFields: { register: vi.fn() },
    };

    admin.register(app);

    const field = app.customFields.register.mock.calls[0][0];
    const version = field.options.base
      .flatMap((section) => section.items || [])
      .find((item) => item.name === 'options.uuid-version');

    expect(version.options).toHaveLength(2);
    expect(version.options.map((option) => option.value)).toEqual(['v4', 'v7']);
    expect(version.options.every((option) => option.key && option.metadatas?.intlLabel)).toBe(true);

    const advancedOptions = field.options.advanced.flatMap((section) => section.items || []);
    const unique = advancedOptions.find((item) => item.name === 'unique');
    expect(unique?.type).toBe('checkbox');
    expect(unique?.defaultValue).toBe(true);
  });
});
