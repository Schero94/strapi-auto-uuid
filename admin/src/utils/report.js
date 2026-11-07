import { getTranslation } from './getTranslation';

/**
 * Translations for the stable codes the server returns with errors and
 * skipped import entries. The server message is only a fallback.
 */
export const CODE_MESSAGES = Object.freeze({
  INVALID_UUID_FIELD_CONFIG: {
    id: getTranslation('code.INVALID_UUID_FIELD_CONFIG'),
    defaultMessage:
      'A UUID field has an invalid version or prefix. Check it in the Content-Type Builder.',
  },
  SCAN_FAILED: {
    id: getTranslation('code.SCAN_FAILED'),
    defaultMessage: 'A UUID field could not be checked. No repairs ran.',
  },
  REPAIR_FAILED: {
    id: getTranslation('code.REPAIR_FAILED'),
    defaultMessage: 'The repair failed and was rolled back. No changes were kept.',
  },
  IMPORT_FAILED: {
    id: getTranslation('code.IMPORT_FAILED'),
    defaultMessage: 'The import failed and was rolled back. No changes were kept.',
  },
  REPAIR_IN_PROGRESS: {
    id: getTranslation('code.REPAIR_IN_PROGRESS'),
    defaultMessage: 'Another repair or import is running. Try again when it has finished.',
  },
  RATE_LIMITED: {
    id: getTranslation('code.RATE_LIMITED'),
    defaultMessage: 'Too many requests in a short time. Wait a minute, then try again.',
  },
  INVALID_REQUEST: {
    id: getTranslation('code.INVALID_REQUEST'),
    defaultMessage: 'The request was rejected. Check the file or the selected options.',
  },
  INVALID_IMPORT: {
    id: getTranslation('code.INVALID_IMPORT'),
    defaultMessage: 'The file is not a UUID mappings export.',
  },
  UNKNOWN_FIELD: {
    id: getTranslation('code.UNKNOWN_FIELD'),
    defaultMessage: 'The file contains a content type or field without a UUID field.',
  },
  IMPORT_VALUE_MISMATCH: {
    id: getTranslation('code.IMPORT_VALUE_MISMATCH'),
    defaultMessage: "A value does not match the field's UUID version and prefix.",
  },
  DUPLICATE_TARGET: {
    id: getTranslation('code.DUPLICATE_TARGET'),
    defaultMessage: 'An entry appears more than once in the file.',
  },
  DUPLICATE_VALUE: {
    id: getTranslation('code.DUPLICATE_VALUE'),
    defaultMessage: 'A UUID appears more than once in the file.',
  },
  CONCURRENT_CHANGE: {
    id: getTranslation('code.CONCURRENT_CHANGE'),
    defaultMessage:
      'An entry changed while the operation ran, for example on another server. It was skipped.',
  },
  TARGET_NOT_FOUND: {
    id: getTranslation('code.TARGET_NOT_FOUND'),
    defaultMessage: 'An entry from the file no longer exists.',
  },
  TARGET_HAS_VALUE: {
    id: getTranslation('code.TARGET_HAS_VALUE'),
    defaultMessage: 'An entry already has a different UUID. Existing values are never replaced.',
  },
  IMPORT_CONFLICT: {
    id: getTranslation('code.IMPORT_CONFLICT'),
    defaultMessage: 'A UUID from the file is already used by another entry.',
  },
});

const UNKNOWN_ERROR = {
  id: getTranslation('code.UNKNOWN'),
  defaultMessage: 'Something went wrong. Refresh the page and try again.',
};

/**
 * Picks a translated message for a request error or a server error item.
 *
 * @param {unknown} error Fetch error (`error.response.data.error`) or an error item with `code`.
 * @returns {{ id: string, defaultMessage: string }} Message descriptor.
 */
export function describeError(error) {
  const payload = error?.response?.data?.error;
  const code =
    error?.code ??
    payload?.details?.code ??
    { 409: 'REPAIR_IN_PROGRESS', 429: 'RATE_LIMITED' }[error?.response?.status];
  return CODE_MESSAGES[code] ?? UNKNOWN_ERROR;
}

/**
 * Number of changes a repair or import result would make or made.
 *
 * @param {Object|null} result Server result.
 * @returns {number} Change count.
 */
export const countChanges = (result) =>
  result ? (result.totalFixed ?? result.imported ?? result.totalGenerated ?? 0) : 0;

/**
 * Builds the lines that summarise a repair or import result. Each line is a
 * message descriptor plus values; previews and applied runs use separate keys.
 *
 * @param {Object} result Server result (redacted).
 * @returns {Array<{ id: string, defaultMessage: string, values?: Object }>} Lines.
 */
export function describeResult(result) {
  if (!result) return [];
  const lines = [];
  const preview = result.dryRun !== false;

  if (result.fixed) {
    const { duplicates = 0, invalid = 0, legacy = 0, empty = 0 } = result.fixed;
    if (duplicates > 0) {
      lines.push(
        preview
          ? {
              id: getTranslation('report.duplicates.preview'),
              defaultMessage:
                '{count, plural, one {# duplicate UUID would be replaced} other {# duplicate UUIDs would be replaced}}',
              values: { count: duplicates },
            }
          : {
              id: getTranslation('report.duplicates.applied'),
              defaultMessage:
                '{count, plural, one {# duplicate UUID replaced} other {# duplicate UUIDs replaced}}',
              values: { count: duplicates },
            }
      );
    }
    if (invalid > 0) {
      lines.push(
        preview
          ? {
              id: getTranslation('report.invalid.preview'),
              defaultMessage:
                '{count, plural, one {# malformed value would be replaced} other {# malformed values would be replaced}}',
              values: { count: invalid },
            }
          : {
              id: getTranslation('report.invalid.applied'),
              defaultMessage:
                '{count, plural, one {# malformed value replaced} other {# malformed values replaced}}',
              values: { count: invalid },
            }
      );
    }
    if (legacy > 0) {
      lines.push(
        preview
          ? {
              id: getTranslation('report.legacy.preview'),
              defaultMessage:
                '{count, plural, one {# value in an older format would be replaced} other {# values in an older format would be replaced}}',
              values: { count: legacy },
            }
          : {
              id: getTranslation('report.legacy.applied'),
              defaultMessage:
                '{count, plural, one {# value in an older format replaced} other {# values in an older format replaced}}',
              values: { count: legacy },
            }
      );
    }
    if (empty > 0) {
      lines.push(
        preview
          ? {
              id: getTranslation('report.empty.preview'),
              defaultMessage:
                '{count, plural, one {# empty field would be filled} other {# empty fields would be filled}}',
              values: { count: empty },
            }
          : {
              id: getTranslation('report.empty.applied'),
              defaultMessage:
                '{count, plural, one {# empty field filled} other {# empty fields filled}}',
              values: { count: empty },
            }
      );
    }
  }

  if (result.imported !== undefined) {
    if (result.imported > 0) {
      lines.push(
        preview
          ? {
              id: getTranslation('report.imported.preview'),
              defaultMessage:
                '{count, plural, one {# UUID would be imported} other {# UUIDs would be imported}}',
              values: { count: result.imported },
            }
          : {
              id: getTranslation('report.imported.applied'),
              defaultMessage: '{count, plural, one {# UUID imported} other {# UUIDs imported}}',
              values: { count: result.imported },
            }
      );
    }
    if (result.unchanged > 0) {
      lines.push({
        id: getTranslation('report.unchanged'),
        defaultMessage:
          '{count, plural, one {# entry already has this UUID} other {# entries already have their UUID}}',
        values: { count: result.unchanged },
      });
    }
    if (result.skipped > 0) {
      lines.push({
        id: getTranslation('report.skipped'),
        defaultMessage: '{count, plural, one {# entry skipped} other {# entries skipped}}',
        values: { count: result.skipped },
      });
    }
  }

  if (lines.length === 0 && !result.failed && !result.aborted) {
    lines.push({
      id: getTranslation('report.nothing'),
      defaultMessage: 'No changes are needed.',
    });
  }
  return lines;
}

/**
 * Lists the distinct error codes of a result with their counts.
 *
 * @param {Object} result Server result.
 * @returns {Array<{ code: string, count: number }>} Error summary.
 */
export function summarizeErrors(result) {
  if (!result) return [];
  if (result.errorCounts && Object.keys(result.errorCounts).length > 0) {
    return Object.entries(result.errorCounts).map(([code, count]) => ({ code, count }));
  }
  const counts = new Map();
  for (const item of result.errors || []) {
    const code = item?.code || 'UNKNOWN';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count }));
}
