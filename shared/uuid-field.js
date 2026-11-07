import * as uuid from 'uuid';

export const SUPPORTED_UUID_VERSIONS = Object.freeze(['v4', 'v7']);
export const UUID_PREFIX_PATTERN = /^[a-zA-Z0-9_-]{1,16}$/;

/**
 * Checks custom-field options and returns a normalized configuration without
 * echoing untrusted option values in its error messages.
 *
 * @param {unknown} options Content-Type Builder field options.
 * @param {string} [defaultVersion='v4'] Plugin-level default UUID version.
 * @returns {{ valid: true, options: { version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean } } | { valid: false, option: string, message: string }}
 */
export function validateUuidFieldOptions(options = {}, defaultVersion = 'v4') {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {
      valid: false,
      option: 'options',
      message: 'UUID field options must be an object.',
    };
  }

  const version = options['uuid-version'] ?? defaultVersion;
  if (!SUPPORTED_UUID_VERSIONS.includes(version)) {
    return {
      valid: false,
      option: 'uuid-version',
      message: "UUID version must be 'v4' or 'v7'.",
    };
  }

  const prefix = options['uuid-prefix'] ?? '';
  if (typeof prefix !== 'string' || (prefix !== '' && !UUID_PREFIX_PATTERN.test(prefix))) {
    return {
      valid: false,
      option: 'uuid-prefix',
      message: 'UUID prefix must contain 1 to 16 letters, numbers, underscores or hyphens.',
    };
  }

  for (const option of ['disable-auto-generate', 'allow-edit']) {
    if (options[option] !== undefined && typeof options[option] !== 'boolean') {
      return {
        valid: false,
        option,
        message: `UUID option '${option}' must be a boolean.`,
      };
    }
  }

  return {
    valid: true,
    options: {
      version,
      prefix,
      disableAutoGenerate: options['disable-auto-generate'] === true,
      allowEdit: options['allow-edit'] === true,
    },
  };
}

/**
 * Resolves custom-field options or throws a stable, non-sensitive error that
 * callers can report without exposing the stored configuration value.
 *
 * @param {unknown} options Content-Type Builder field options.
 * @param {string} [defaultVersion='v4'] Plugin-level default UUID version.
 * @returns {{ version: string, prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
 * @throws {TypeError} When an option is unsupported or malformed.
 */
export function resolveUuidFieldOptions(options = {}, defaultVersion = 'v4') {
  const result = validateUuidFieldOptions(options, defaultVersion);
  if (!result.valid) {
    const error = new TypeError(result.message);
    error.code = 'INVALID_UUID_FIELD_CONFIG';
    error.option = result.option;
    throw error;
  }

  return result.options;
}

/**
 * Validates the UUID version nibble after checking the UUID structure.
 *
 * @param {unknown} value Candidate UUID string.
 * @param {'v4'|'v7'} version Required UUID version.
 * @returns {boolean} Whether the value is a UUID of the requested version.
 */
export function isUuidOfVersion(value, version) {
  return (
    SUPPORTED_UUID_VERSIONS.includes(version) &&
    typeof value === 'string' &&
    uuid.validate(value) &&
    value[14] === version.slice(1)
  );
}

/**
 * Checks the complete field value, including its configured prefix and UUID
 * version. Prefix comparison is exact and case-sensitive.
 *
 * @param {unknown} value Stored or user-entered field value.
 * @param {{ version: 'v4'|'v7', prefix: string }} options Normalized field options.
 * @returns {boolean} Whether the value satisfies the field configuration.
 */
export function isUuidFieldValue(value, options) {
  if (typeof value !== 'string' || !value.startsWith(options.prefix)) return false;
  return isUuidOfVersion(value.slice(options.prefix.length), options.version);
}

const UUID_LENGTH = 36;

/**
 * Classifies a stored value against the field configuration.
 *
 * - `empty`: null, undefined or an empty string.
 * - `valid`: matches the configured prefix and UUID version.
 * - `legacy`: a well-formed UUID with an optional valid prefix that no longer
 *   matches the current field options, typically after the version or prefix
 *   was changed in the Content-Type Builder. It is still a usable identifier.
 * - `malformed`: anything else (not a UUID at all).
 *
 * @param {unknown} value Stored field value.
 * @param {{ version: 'v4'|'v7', prefix: string }} options Normalized field options.
 * @returns {'empty'|'valid'|'legacy'|'malformed'} Value category.
 */
export function classifyUuidFieldValue(value, options) {
  if (value === null || value === undefined || value === '') return 'empty';
  if (isUuidFieldValue(value, options)) return 'valid';
  if (typeof value !== 'string' || value.length < UUID_LENGTH) return 'malformed';

  const prefix = value.slice(0, value.length - UUID_LENGTH);
  const candidate = value.slice(value.length - UUID_LENGTH);
  if ((prefix === '' || UUID_PREFIX_PATTERN.test(prefix)) && uuid.validate(candidate)) {
    return 'legacy';
  }
  return 'malformed';
}

/**
 * Creates a UUID in the configured version and adds the field's prefix.
 *
 * @param {{ version: 'v4'|'v7', prefix: string }} options Normalized field options.
 * @returns {string} The prefixed UUID value.
 * @throws {TypeError} When the version is unsupported or its generator is unavailable.
 */
export function generateUuidFieldValue(options) {
  if (!SUPPORTED_UUID_VERSIONS.includes(options?.version)) {
    throw new TypeError("UUID version must be 'v4' or 'v7'.");
  }

  const generator = options.version === 'v7' ? uuid.v7 : uuid.v4;
  if (typeof generator !== 'function') {
    throw new TypeError(`UUID ${options.version} generator is unavailable.`);
  }

  return `${options.prefix || ''}${generator()}`;
}
