import { canonicalUuidValue, resolveUuidFieldOptions } from '../../../shared/uuid-field.js';

export const UUID_CUSTOM_FIELD = 'plugin::field-uuid.uuid';

/** Page size for full-table scans. Rows are read in primary-key order. */
export const SCAN_PAGE_SIZE = 5000;

/**
 * Returns whether a content-type attribute is the UUID custom field.
 *
 * @param {unknown} attribute Content-type attribute.
 * @returns {boolean} True for `plugin::field-uuid.uuid` attributes.
 */
export const isUuidAttribute = (attribute) => attribute?.customField === UUID_CUSTOM_FIELD;

/**
 * Lists every content type (api:: and plugin:: alike) that has at least one
 * UUID custom field, as `{ uid: [fieldName, ...] }`. Components are not
 * included: see {@link findComponentUuidFields}.
 *
 * @param {{ contentTypes: Record<string, { attributes?: Record<string, unknown> }> }} strapi
 * @returns {Record<string, string[]>} UUID fields per content type.
 */
export function getUuidModels(strapi) {
  const models = {};
  for (const [uid, contentType] of Object.entries(strapi.contentTypes || {})) {
    const fields = Object.entries(contentType?.attributes || {})
      .filter(([, attribute]) => isUuidAttribute(attribute))
      .map(([name]) => name);
    if (fields.length > 0) models[uid] = fields;
  }
  return models;
}

/**
 * Lists UUID custom fields declared inside components. These fields are not
 * managed by the plugin (no server-side generation, validation or repair),
 * so bootstrap warns about them.
 *
 * @param {{ components?: Record<string, { attributes?: Record<string, unknown> }> }} strapi
 * @returns {string[]} `component.uid.field` names.
 */
export function findComponentUuidFields(strapi) {
  const found = [];
  for (const [uid, component] of Object.entries(strapi.components || {})) {
    for (const [name, attribute] of Object.entries(component?.attributes || {})) {
      if (isUuidAttribute(attribute)) found.push(`${uid}.${name}`);
    }
  }
  return found;
}

/**
 * Returns whether the attribute has a separate value per locale. Strapi's
 * i18n plugin copies non-localized attributes to every locale of a document.
 *
 * @param {unknown} attribute Content-type attribute.
 * @returns {boolean} True when `pluginOptions.i18n.localized` is true.
 */
export const isLocalizedAttribute = (attribute) =>
  attribute?.pluginOptions?.i18n?.localized === true;

/**
 * Resolves normalized options for a UUID field of a content type.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} uid Content type UID.
 * @param {string} field UUID field name.
 * @param {'v4'|'v7'} defaultVersion Plugin default version.
 * @returns {{ version: 'v4'|'v7', prefix: string, disableAutoGenerate: boolean, allowEdit: boolean }}
 * @throws {TypeError} With code INVALID_UUID_FIELD_CONFIG when the options are invalid.
 */
export function resolveFieldOptions(strapi, uid, field, defaultVersion) {
  const attribute = strapi.contentTypes?.[uid]?.attributes?.[field];
  return resolveUuidFieldOptions(attribute?.options || {}, defaultVersion);
}

/**
 * Reads every database row of a content type (all locales, drafts and
 * published versions) with the given UUID field. Uses the transaction-aware
 * query engine, so the scan joins an open transaction, and pages by primary
 * key so rows are never skipped or repeated.
 *
 * @param {Object} strapi Strapi instance.
 * @param {string} uid Content type UID.
 * @param {string} field UUID field name.
 * @param {Object} [where] Extra query-engine filter.
 * @returns {Promise<Array<{ id: number, documentId: string, locale?: string|null,
 *   publishedAt?: string|null } & Record<string, unknown>>>} Rows in id order.
 */
export async function fetchFieldRows(strapi, uid, field, where = {}) {
  const contentType = strapi.contentTypes?.[uid];
  const select = ['id', 'documentId', field];
  if (contentType?.attributes?.locale) select.push('locale');
  if (contentType?.attributes?.publishedAt) select.push('publishedAt');

  const rows = [];
  let lastId = 0;
  for (;;) {
    const page = await strapi.db.query(uid).findMany({
      select,
      where:
        Object.keys(where).length > 0
          ? { $and: [{ id: { $gt: lastId } }, where] }
          : { id: { $gt: lastId } },
      orderBy: { id: 'asc' },
      limit: SCAN_PAGE_SIZE,
    });
    rows.push(...page);
    if (page.length < SCAN_PAGE_SIZE) break;
    lastId = page[page.length - 1].id;
  }
  return rows;
}

/**
 * Groups rows by value and returns the values held by more than one
 * document. Rows of the same document (draft and published version, and the
 * locales of a non-localized field) legitimately share a value and never
 * count as duplicates. Documents are listed by their lowest row id, so the
 * oldest document is first and keeps its value during a repair.
 *
 * Values are compared in canonical form (UUID part in lowercase), so
 * `0A1B...` and `0a1b...` held by two documents are one duplicate group.
 * `uuid` is the canonical value of the group.
 *
 * @param {Array<Record<string, unknown>>} rows Rows from {@link fetchFieldRows}.
 * @param {string} field UUID field name.
 * @returns {Array<{ uuid: string, count: number, documentIds: string[] }>} Duplicate groups.
 */
export function groupDuplicates(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = canonicalUuidValue(raw);
    let owners = groups.get(value);
    if (!owners) {
      owners = new Map();
      groups.set(value, owners);
    }
    const firstId = owners.get(row.documentId);
    if (firstId === undefined || row.id < firstId) owners.set(row.documentId, row.id);
  }

  const duplicates = [];
  for (const [uuid, owners] of groups) {
    if (owners.size < 2) continue;
    const documentIds = [...owners.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    duplicates.push({ uuid, count: documentIds.length, documentIds });
  }
  return duplicates;
}
