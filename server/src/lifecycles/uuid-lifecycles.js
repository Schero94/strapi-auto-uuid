import { errors } from '@strapi/utils';
import {
  generateUuidFieldValue,
  isUuidFieldValue,
  resolveUuidFieldOptions,
} from '../../../shared/uuid-field.js';
import { isUuidRepairContext } from '../utils/repair-context.js';
import { isLocalizedAttribute } from '../utils/uuid-models.js';

const { ValidationError, ApplicationError } = errors;

const isEmpty = (value) => value === null || value === undefined || value === '';
const sameValue = (a, b) => (isEmpty(a) && isEmpty(b)) || a === b;

/**
 * Creates the database lifecycle subscriber that generates, validates and
 * protects UUID field values.
 *
 * All lookups use `strapi.db.query()`, which joins the transaction that the
 * Document Service opens around every write. Raw knex connections must not be
 * used here: on SQLite the pool holds a single connection that the open
 * transaction already owns, so a raw query would wait until the acquire
 * timeout.
 *
 * Rules:
 * - Rows of the same document (draft and published version, and the locales
 *   of a non-localized field) may share a value. Two documents may not.
 * - On create, an empty field is generated when auto-generation is on.
 *   Fields that are auto-generated and not manually editable are always
 *   generated on the server; a client-supplied value is replaced unless it
 *   already belongs to the same document (publish, discard draft, new locale).
 * - A copy that carries a new documentId (Document Service `clone`) gets a
 *   fresh value when its copied value belongs to the source document.
 * - Any other create with a value used by another document is rejected.
 * - On update, an unchanged value is always accepted, even when it no longer
 *   matches the current version or prefix. Changes are validated, must be
 *   unique and are only allowed for fields with "Allow manual editing" or
 *   while the field is still empty (write once). Internal repairs and imports
 *   run in the repair context and may replace values.
 *
 * @param {Object} deps Dependencies.
 * @param {Object} deps.strapi Strapi instance.
 * @param {Record<string, Array<{ field: string, attribute: Object }>>} deps.models UUID fields per UID.
 * @param {ReturnType<import('../config/index.js').normalizePluginConfig>} deps.config Plugin config.
 * @param {{ debug: Function, info: Function, warn: Function }} deps.log Level-filtered logger.
 * @returns {Object} Lifecycle subscriber for `strapi.db.lifecycles.subscribe`.
 */
export function createUuidLifecycles({ strapi, models, config, log }) {
  /**
   * @throws {ValidationError} When the stored field options are invalid.
   */
  const getOptions = (uid, field, attribute) => {
    try {
      return resolveUuidFieldOptions(attribute?.options || {}, config.defaultVersion);
    } catch (error) {
      throw new ValidationError(
        `Invalid UUID field configuration for '${field}': ${error.message}`,
        {
          field,
          code: 'INVALID_UUID_FIELD_CONFIG',
        }
      );
    }
  };

  /** Returns the documentId of another document holding `value`, or null. */
  const findOtherOwner = async (uid, field, value, documentId) => {
    if (!config.validateUniqueness) return null;
    const where = { [field]: value };
    if (documentId) where.documentId = { $ne: documentId };
    const row = await strapi.db.query(uid).findOne({ where, select: ['documentId'] });
    return row?.documentId ?? null;
  };

  /** Returns whether any row of `documentId` (optionally except row `exceptId`) holds `value`. */
  const documentHolds = async (uid, field, value, documentId, exceptId) => {
    const where = { documentId, [field]: value };
    if (exceptId !== undefined) where.id = { $ne: exceptId };
    const row = await strapi.db.query(uid).findOne({ where, select: ['id'] });
    return Boolean(row);
  };

  const documentExists = async (uid, documentId) => {
    const row = await strapi.db.query(uid).findOne({ where: { documentId }, select: ['id'] });
    return Boolean(row);
  };

  /**
   * Generates a value for the field and retries when the preflight lookup
   * finds it in use. Random v4/v7 collisions are practically impossible; the
   * retry exists for prefix/value combinations imported from elsewhere.
   *
   * @throws {ApplicationError} When every attempt collides.
   */
  const generateUnique = async (uid, field, options, reserved) => {
    for (let attempt = 1; attempt <= config.maxRetryAttempts; attempt += 1) {
      const candidate = generateUuidFieldValue(options);
      if (reserved?.has(`${field}\u0000${candidate}`)) continue;
      if (!(await findOtherOwner(uid, field, candidate, null))) return candidate;
      log.warn(
        `[strapi-auto-uuid] UUID collision for ${uid}.${field}, retrying (${attempt}/${config.maxRetryAttempts})`
      );
    }
    throw new ApplicationError(`Failed to generate a unique UUID for '${field}'.`, {
      field,
      code: 'UUID_GENERATION_FAILED',
    });
  };

  /**
   * Generates, keeps, replaces or rejects the UUID values of one row that is
   * about to be inserted.
   *
   * @param {string} uid Content type UID.
   * @param {Record<string, unknown>} data Row data (mutated in place).
   * @param {Set<string>} reserved Values already used earlier in the same batch.
   * @throws {ValidationError} For malformed or duplicate client-supplied values.
   */
  const prepareCreate = async (uid, data, reserved) => {
    const documentId = isEmpty(data.documentId) ? null : data.documentId;
    let isNewDocument;
    const checkNewDocument = async () => {
      if (isNewDocument === undefined) {
        isNewDocument = !documentId || !(await documentExists(uid, documentId));
      }
      return isNewDocument;
    };

    for (const { field, attribute } of models[uid]) {
      const options = getOptions(uid, field, attribute);
      const autoGenerate = config.autoGenerate && !options.disableAutoGenerate;
      const serverGenerated = autoGenerate && !options.allowEdit && !isUuidRepairContext();
      const value = data[field];
      const reserve = (v) => reserved.add(`${field}\u0000${v}`);

      if (isEmpty(value)) {
        if (autoGenerate) {
          data[field] = await generateUnique(uid, field, options, reserved);
          reserve(data[field]);
        }
        continue;
      }

      // Publish, discard draft and new-locale creates copy the value of the
      // same document. Keep it, even when it predates a version/prefix change.
      if (documentId && (await documentHolds(uid, field, value, documentId))) {
        reserve(value);
        continue;
      }

      const isClone = Boolean(documentId) && (await checkNewDocument());

      if (serverGenerated) {
        data[field] = await generateUnique(uid, field, options, reserved);
        reserve(data[field]);
        log.debug(`[strapi-auto-uuid] Replaced a client-supplied value for ${uid}.${field}`);
        continue;
      }

      const valid = isUuidFieldValue(value, options);
      const duplicate =
        valid &&
        (reserved.has(`${field}\u0000${value}`) ||
          Boolean(await findOtherOwner(uid, field, value, documentId)));

      if (isClone && autoGenerate && (!valid || duplicate)) {
        data[field] = await generateUnique(uid, field, options, reserved);
        reserve(data[field]);
        log.info(`[strapi-auto-uuid] Generated a new value for a cloned ${uid}.${field}`);
        continue;
      }

      if (!valid) {
        throw new ValidationError(`Invalid UUID format for field '${field}'`, {
          field,
          code: 'INVALID_UUID',
        });
      }
      if (duplicate) {
        throw new ValidationError(
          `UUID already exists for field '${field}'. Please use a unique value.`,
          { field, code: 'DUPLICATE_UUID' }
        );
      }
      reserve(value);
    }
  };

  /**
   * Validates a change of one UUID field for rows of a single document.
   *
   * @throws {ValidationError} When the change is not allowed.
   */
  const assertChangeAllowed = async ({ uid, field, attribute, options, newValue, rows }) => {
    const documentId = rows[0].documentId;
    const changedRows = rows.filter((row) => !sameValue(row[field], newValue));
    if (changedRows.length === 0) return;

    // Strapi's i18n plugin copies non-localized fields to the other locales
    // of a document. Accept the document's own existing value.
    const copiesOwnValue =
      !isEmpty(newValue) &&
      !isLocalizedAttribute(attribute) &&
      (await documentHolds(uid, field, newValue, documentId));

    if (!options.allowEdit && !copiesOwnValue && changedRows.some((row) => !isEmpty(row[field]))) {
      throw new ValidationError(
        `UUID field '${field}' is immutable. Enable manual editing in the field options to change it.`,
        { field, code: 'IMMUTABLE_UUID' }
      );
    }

    if (isEmpty(newValue) || copiesOwnValue) return;

    if (!isUuidFieldValue(newValue, options)) {
      throw new ValidationError(`Invalid UUID format for field '${field}'`, {
        field,
        code: 'INVALID_UUID',
      });
    }
    if (await findOtherOwner(uid, field, newValue, documentId)) {
      throw new ValidationError(
        `UUID already exists for field '${field}'. Please use a unique value.`,
        { field, code: 'DUPLICATE_UUID' }
      );
    }
  };

  /** Rejects malformed values written by internal repairs. */
  const assertRepairValues = (uid, data, touched) => {
    for (const { field, attribute } of touched) {
      const options = getOptions(uid, field, attribute);
      if (!isEmpty(data[field]) && !isUuidFieldValue(data[field], options)) {
        throw new ValidationError(`Invalid UUID format for field '${field}'`, {
          field,
          code: 'INVALID_UUID',
        });
      }
    }
  };

  /**
   * Loads the rows targeted by an update through the transaction-aware
   * query engine.
   */
  const loadTargets = (uid, where, touched, many) => {
    const query = {
      where: where || {},
      select: ['id', 'documentId', ...touched.map(({ field }) => field)],
    };
    return many ? strapi.db.query(uid).findMany(query) : strapi.db.query(uid).findOne(query);
  };

  return {
    models: Object.keys(models),

    async beforeCreate(event) {
      const { model, params } = event;
      if (!models[model.uid] || !params?.data) return;
      await prepareCreate(model.uid, params.data, new Set());
    },

    async beforeCreateMany(event) {
      const { model, params } = event;
      if (!models[model.uid] || !Array.isArray(params?.data)) return;
      const reserved = new Set();
      for (const data of params.data) {
        await prepareCreate(model.uid, data, reserved);
      }
    },

    async beforeUpdate(event) {
      const { model, params } = event;
      const uid = model.uid;
      if (!models[uid] || !params?.data) return;

      const data = params.data;
      const touched = models[uid].filter(({ field }) => Object.hasOwn(data, field));
      if (touched.length === 0) return;

      if (isUuidRepairContext()) {
        assertRepairValues(uid, data, touched);
        return;
      }

      const row = await loadTargets(uid, params.where, touched, false);
      if (!row) {
        throw new ValidationError(
          'Unable to verify the target entry for a UUID update. The update was rejected.',
          { code: 'UUID_TARGET_UNKNOWN' }
        );
      }

      for (const { field, attribute } of touched) {
        const options = getOptions(uid, field, attribute);
        const autoGenerate = config.autoGenerate && !options.disableAutoGenerate;

        // Entries created before the field existed are filled on their next save.
        if (isEmpty(row[field]) && isEmpty(data[field]) && autoGenerate) {
          data[field] = await generateUnique(uid, field, options);
          continue;
        }

        await assertChangeAllowed({
          uid,
          field,
          attribute,
          options,
          newValue: data[field],
          rows: [row],
        });
      }
    },

    async beforeUpdateMany(event) {
      const { model, params } = event;
      const uid = model.uid;
      if (!models[uid] || !params?.data) return;

      const data = params.data;
      const touched = models[uid].filter(({ field }) => Object.hasOwn(data, field));
      if (touched.length === 0) return;

      if (isUuidRepairContext()) {
        assertRepairValues(uid, data, touched);
        return;
      }

      const rows = await loadTargets(uid, params.where, touched, true);
      if (rows.length === 0) return;

      for (const { field, attribute } of touched) {
        const newValue = data[field];
        if (rows.every((row) => sameValue(row[field], newValue))) continue;

        const documentIds = new Set(rows.map((row) => row.documentId));
        if (documentIds.size > 1) {
          throw new ValidationError(
            `UUID field '${field}' cannot be set on several documents at once.`,
            { field, code: 'BULK_UUID_WRITE' }
          );
        }

        await assertChangeAllowed({
          uid,
          field,
          attribute,
          options: getOptions(uid, field, attribute),
          newValue,
          rows,
        });
      }
    },
  };
}
