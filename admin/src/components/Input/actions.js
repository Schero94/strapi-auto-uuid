/**
 * Creates the non-visual actions used by the Content Manager UUID field.
 * Regeneration is available only for a valid, manually editable field. The
 * server still validates all submitted values; these checks only govern the
 * field controls and never replace lifecycle validation.
 *
 * @param {Object} options Action dependencies and current field state.
 * @param {boolean} [options.allowEdit=false] Whether field configuration permits manual changes.
 * @param {Object|null} [options.options=null] Normalized options; absent options indicate invalid configuration.
 * @param {() => string} [options.generateValue] Creates a UUID matching the normalized field options.
 * @param {(event: {target: {name: string, type: string, value: unknown}}) => void} [options.onChange]
 *   Content Manager field-change callback.
 * @param {string} [options.name] Content Manager field name.
 * @param {string} [options.type] Strapi attribute type.
 * @param {string} [options.value] Current field value copied by the copy action.
 * @param {{writeText: (value: string) => Promise<void>} [options.clipboard]
 *   Clipboard port, injected so copy behavior can be tested without a browser.
 * @returns {{change: (value: unknown) => boolean, regenerate: () => boolean, copy: () => Promise<boolean>}}
 *   Field actions. Copy and regeneration return false when the action cannot run.
 */
export const createUuidInputActions = ({
  allowEdit = false,
  options = null,
  generateValue,
  onChange,
  name,
  type,
  value,
  clipboard = globalThis.navigator?.clipboard,
} = {}) => ({
  /** Emits the event shape consumed by Strapi's Content Manager form. */
  change(nextValue) {
    if (typeof onChange !== 'function') return false;

    onChange({ target: { name, type, value: nextValue } });
    return true;
  },

  /**
   * Generates and submits a replacement only when the field is editable and
   * its UUID options passed validation during component setup.
   */
  regenerate() {
    if (
      !allowEdit ||
      !options ||
      typeof generateValue !== 'function' ||
      typeof onChange !== 'function'
    ) {
      return false;
    }

    onChange({ target: { name, type, value: generateValue() } });
    return true;
  },

  /** Copies only a non-empty value; clipboard denial is a normal unsupported-action result. */
  async copy() {
    if (!value || typeof clipboard?.writeText !== 'function') return false;

    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Derives how the Content Manager field behaves from its options and values.
 *
 * - Editable when "Allow manual editing" is on, or when auto-generation is
 *   off and no value has been saved yet (enter once, then locked).
 * - Never generates on mount: the server generates missing values on save,
 *   so opening an entry never marks the form as modified.
 * - Replacing a saved value asks for confirmation.
 *
 * @param {Object} state Field state.
 * @param {{ allowEdit: boolean, disableAutoGenerate: boolean }|null} state.options Normalized options.
 * @param {unknown} state.savedValue Value when the form was opened.
 * @param {boolean} [state.disabled=false] Content Manager disabled state (permissions, history).
 * @returns {{ editable: boolean, canGenerate: boolean, confirmReplace: boolean,
 *   placeholder: 'generatedOnSave'|'enterManually'|'none' }}
 */
export const getUuidInputState = ({ options, savedValue, disabled = false }) => {
  if (!options) {
    return { editable: false, canGenerate: false, confirmReplace: false, placeholder: 'none' };
  }
  const saved = typeof savedValue === 'string' && savedValue !== '';
  const editable = !disabled && (options.allowEdit || (options.disableAutoGenerate && !saved));
  return {
    editable,
    canGenerate: editable,
    confirmReplace: saved,
    placeholder: options.disableAutoGenerate ? 'enterManually' : 'generatedOnSave',
  };
};
