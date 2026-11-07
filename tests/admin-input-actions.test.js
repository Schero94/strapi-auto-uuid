import { describe, expect, it, vi } from 'vitest';
import { createUuidInputActions } from '../admin/src/components/Input/actions.js';

describe('UUID Content Manager input actions', () => {
  it('emits the Strapi field-change event expected by Content Manager', () => {
    const onChange = vi.fn();
    const actions = createUuidInputActions({
      name: 'publicId',
      type: 'string',
      onChange,
    });

    actions.change('art_123');

    expect(onChange).toHaveBeenCalledWith({
      target: { name: 'publicId', type: 'string', value: 'art_123' },
    });
  });

  it('regenerates only when editing is enabled and field options are valid', () => {
    const onChange = vi.fn();
    const generateValue = vi.fn(() => 'art_generated-v7');
    const actions = createUuidInputActions({
      allowEdit: true,
      options: { version: 'v7', prefix: 'art_' },
      generateValue,
      onChange,
      name: 'publicId',
      type: 'string',
    });

    expect(actions.regenerate()).toBe(true);
    expect(generateValue).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      target: { name: 'publicId', type: 'string', value: 'art_generated-v7' },
    });
  });

  it.each([
    ['manual editing is disabled', false, { version: 'v4', prefix: '' }],
    ['field options are invalid', true, null],
  ])('does not regenerate when %s', (_reason, allowEdit, options) => {
    const onChange = vi.fn();
    const generateValue = vi.fn(() => 'not-written');
    const actions = createUuidInputActions({
      allowEdit,
      options,
      generateValue,
      onChange,
      name: 'publicId',
      type: 'string',
    });

    expect(actions.regenerate()).toBe(false);
    expect(generateValue).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('copies the current field value and reports clipboard success', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const actions = createUuidInputActions({ value: 'art_current-v4', clipboard });

    await expect(actions.copy()).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('art_current-v4');
  });

  it('does not copy empty values and contains clipboard failures', async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };
    const emptyActions = createUuidInputActions({ value: '', clipboard });
    const deniedActions = createUuidInputActions({ value: 'art_current-v4', clipboard });

    await expect(emptyActions.copy()).resolves.toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await expect(deniedActions.copy()).resolves.toBe(false);
  });
});
