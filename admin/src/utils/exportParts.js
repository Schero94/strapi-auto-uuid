/**
 * Splits a UUID export into files that the Import dialog accepts.
 *
 * An import is sent as one JSON request body. Strapi's body parser
 * (`strapi::body`, koa-body) rejects JSON bodies over `jsonLimit`, 1 MB by
 * default, and the server accepts at most `IMPORT_LIMITS.totalEntries`
 * values per import. Each part is a complete export document in compact
 * JSON that stays inside both limits, so any export can be imported again,
 * one part at a time.
 */

/** Same limit as the Import dialog and Strapi's default JSON body limit. */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/** Must match `IMPORT_LIMITS.totalEntries` in server/src/controllers/validation.js. */
export const MAX_IMPORT_ENTRIES = 10_000;
/** Room for the request wrapper `{"mappings":…,"dryRun":false}`. */
const WRAPPER_BYTES = 1024;

const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;

/**
 * @param {{ exportedAt?: string, format?: number, mappings: Record<string, { fields: Record<string, Array<Object>> }> }} data
 *   Export document from GET /field-uuid/migration/export.
 * @param {{ maxBytes?: number, maxEntries?: number }} [limits] Limits per part (for tests).
 * @returns {string[]} Compact JSON documents, at least one.
 */
export function splitExport(
  data,
  { maxBytes = MAX_IMPORT_BYTES - WRAPPER_BYTES, maxEntries = MAX_IMPORT_ENTRIES } = {}
) {
  const header = { exportedAt: data?.exportedAt, format: data?.format };
  const parts = [];
  let current;
  let bytes;
  let entries;

  const start = () => {
    current = { ...header, mappings: {} };
    bytes = byteLength(JSON.stringify(current));
    entries = 0;
  };
  const flush = () => {
    if (entries > 0 || parts.length === 0) parts.push(current);
    start();
  };

  start();
  for (const [uid, contentType] of Object.entries(data?.mappings ?? {})) {
    for (const [field, list] of Object.entries(contentType?.fields ?? {})) {
      // `"uid":{"fields":{` + `"field":[` + closing brackets and commas.
      const fieldCost = () =>
        (current.mappings[uid] ? 0 : byteLength(JSON.stringify(uid)) + 14) +
        byteLength(JSON.stringify(field)) +
        4;
      const ensureField = () => {
        if (!current.mappings[uid]) current.mappings[uid] = { fields: {} };
        if (!current.mappings[uid].fields[field]) {
          bytes += fieldCost();
          current.mappings[uid].fields[field] = [];
        }
        return current.mappings[uid].fields[field];
      };

      if (list.length === 0) {
        ensureField();
        continue;
      }
      for (const entry of list) {
        const cost = byteLength(JSON.stringify(entry)) + 1;
        const extra = current.mappings[uid]?.fields[field] ? 0 : fieldCost();
        if (entries > 0 && (bytes + extra + cost > maxBytes || entries + 1 > maxEntries)) flush();
        ensureField().push(entry);
        bytes += cost;
        entries += 1;
      }
    }
  }
  flush();
  return parts.map((part) => JSON.stringify(part));
}
