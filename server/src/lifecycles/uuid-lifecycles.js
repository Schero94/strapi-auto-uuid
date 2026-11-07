import { errors } from '@strapi/utils';
import {
  canonicalUuidValue,
  generateUuidFieldValue,
  isUuidFieldValue,
  resolveUuidFieldOptions,
  uuidValueSpellings,
} from '../../../shared/uuid-field.js';
import {
  LOCK_SPACES,
  documentLockKey,
  getDialect,
  lockKeys,
  valueLockKey,
} from '../utils/cluster-lock.js';
import { isUuidRepairContext } from '../utils/repair-context.js';
import { isLocalizedAttribute } from '../utils/uuid-models.js';

const { ValidationError, ApplicationError } = errors;

/**
 * Creates a ValidationError in the shape the admin forms read. The Content
 * Manager maps `details.errors[].path` to a form field (`useAPIErrorHandler`
 * `_unstableFormatValidationErrors`), so the message is shown under the UUID
 * input. Without `errors` it calls `join()` on every other details key and
 * throws. `field` and `code` stay for API clients.
 *
 * @param {string} message Error message.
 * @param {{ field?: string, code: string }} details Error details.
 * @returns {InstanceType<typeof ValidationError>} The error to throw.
 */
export const uuidValidationError = (message, details) =>
  new ValidationError(message, {
    ...details,
    errors: details.field ? [{ path: [details.field], message, name: 'ValidationError' }] : [],
  });

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
 * Several processes (replicas, pm2 workers) may write at the same time. The
 * uniqueness check and the write-once rule are therefore serialized with
 * transaction-scoped database locks (see `utils/cluster-lock.js`), taken on
 * the connection of the Document Service transaction:
 * - before a client-supplied value is checked for uniqueness, a lock on that
 *   value (field + canonical value);
 * - before an empty, non-editable field is filled on update, a lock on that
 *   field of the document, followed by a fresh read of the target rows.
 * The second transaction waits until the first commits and then sees its
 * row, so it rejects the duplicate instead of inserting it. Server-generated
 * random values take no lock. Writes outside a transaction take no lock.
 *
 * Rules:
 * - Rows of the same document (draft and published version, and the locales
 *   of a non-localized field) may share a value. Two documents may not.
 * - On create, an empty field is generated when auto-generation is on.
 *   Fields that are auto-generated and not manually editable are always
 *   generated on the server; a client-supplied value is replaced unless it
 *   already belongs to the same document (publish, discard draft, new locale).
 * - A copy that carries a new documentId (Document Service `clone`) gets a
 *   fresh value when its copied value belongs to the source document. The
 *   later locales of a multi-locale clone reuse the value of the first one
 *   for non-localized fields. Duplicates inside one batch are rejected.
 * - Any other create with a value used by another document is rejected.
 * - New and changed values are stored in canonical form (UUID part in
 *   lowercase, prefix unchanged). Uniqueness checks also match the uppercase
 *   spelling, so a case variant of another document's value is a duplicate.
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
      throw uuidValidationError(
        `Invalid UUID field configuration for '${field}': ${error.message}`,
        {
          field,
          code: 'INVALID_UUID_FIELD_CONFIG',
        }
      );
    }
  };

  /**
   * Returns the documentId of another document holding `value`, or null.
   * The lookup also matches the lowercase and uppercase spelling of the UUID
   * part, so a case variant of an existing value counts as a duplicate on
   * every database (RFC 9562 treats UUIDs as case-insensitive).
   */
  const findOtherOwner = async (uid, field, value, documentId, latest = false) => {
    if (!config.validateUniqueness) return null;
    const spellings = uuidValueSpellings(value);
    const where = { [field]: spellings.length === 1 ? spellings[0] : { $in: spellings } };
    if (documentId) where.documentId = { $ne: documentId };
    const row = latest
      ? await findOneLatest(uid, { where, select: ['documentId'] })
      : await strapi.db.query(uid).findOne({ where, select: ['documentId'] });
    return row?.documentId ?? null;
  };

  /**
   * Whether reads after a lock must be locking reads. MySQL runs
   * transactions in REPEATABLE READ, where a plain read returns the snapshot
   * of the first read; `FOR UPDATE` returns the latest committed row.
   * PostgreSQL runs READ COMMITTED, where each statement sees the latest
   * committed rows. SQLite has a single writer.
   */
  const needsLockingRead = () => getDialect(strapi) === 'mysql' && strapi.db.inTransaction();

  /** findMany that returns the latest committed rows (see needsLockingRead). */
  const findManyLatest = (uid, query) =>
    needsLockingRead()
      ? strapi.db.queryBuilder(uid).init(query).forUpdate().execute()
      : strapi.db.query(uid).findMany(query);

  /** findOne that returns the latest committed row (see needsLockingRead). */
  const findOneLatest = async (uid, query) =>
    needsLockingRead()
      ? ((
          await strapi.db
            .queryBuilder(uid)
            .init({ ...query, limit: 1 })
            .forUpdate()
            .execute()
        )?.[0] ?? null)
      : strapi.db.query(uid).findOne(query);

  /**
   * Locks one value of a field until the transaction ends.
   *
   * @returns {Promise<boolean>} Whether a lock was taken.
   */
  const lockValue = async (uid, field, value) =>
    config.validateUniqueness &&
    lockKeys(strapi, LOCK_SPACES.value, [valueLockKey(uid, field, value)]);

  /** Returns whether any row of `documentId` (optionally except row `exceptId`) holds `value`. */
  const documentHolds = async (uid, field, value, documentId, exceptId) => {
    const where = { documentId, [field]: value };
    if (exceptId !== undefined) where.id = { $ne: exceptId };
    const row = await strapi.db.query(uid).findOne({ where, select: ['id'] });
    return Boolean(row);
  };

  /** Returns the non-empty value that another row of `documentId` already holds, or null. */
  const findDocumentValue = async (uid, field, documentId) => {
    const row = await strapi.db.query(uid).findOne({
      where: { documentId, $and: [{ [field]: { $notNull: true } }, { [field]: { $ne: '' } }] },
      select: [field],
    });
    return row?.[field] ?? null;
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

  // Document Service `clone` creates the rows of all locales concurrently
  // (`async.map`), so the database cannot tell the later rows which value the
  // first one received. Values generated for a new document are remembered
  // briefly, keyed by documentId, so every row of the clone gets the same one.
  const documentValues = new Map();
  const DOCUMENT_VALUE_TTL_MS = 60_000;
  const DOCUMENT_VALUE_MAX = 1_000;

  /**
   * Generates a value once per document and non-localized field.
   *
   * @returns {Promise<string>} The value shared by all rows of the document.
   */
  const generateForDocument = (uid, field, options, reserved, documentId) => {
    const key = `${uid}\u0000${field}\u0000${documentId}`;
    const now = Date.now();
    const hit = documentValues.get(key);
    if (hit && hit.expires > now) return hit.promise;

    if (documentValues.size >= DOCUMENT_VALUE_MAX) {
      for (const [k, entry] of documentValues) {
        if (entry.expires <= now || documentValues.size >= DOCUMENT_VALUE_MAX) {
          documentValues.delete(k);
        }
      }
    }
    const promise = generateUnique(uid, field, options, reserved);
    documentValues.set(key, { promise, expires: now + DOCUMENT_VALUE_TTL_MS });
    promise.catch(() => documentValues.delete(key));
    return promise;
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
      let value = data[field];
      const reserve = (v) => reserved.add(`${field}\u0000${v}`);
      const shared = Boolean(documentId) && !isLocalizedAttribute(attribute);
      const generate = () =>
        shared
          ? generateForDocument(uid, field, options, reserved, documentId)
          : generateUnique(uid, field, options, reserved);

      // Rows of one document share the value of a non-localized field. A
      // multi-locale clone creates one row per locale with the new
      // documentId; later locales take the value given to the first one.
      const sharedValue = shared ? await findDocumentValue(uid, field, documentId) : null;

      if (isEmpty(value)) {
        if (!isEmpty(sharedValue)) {
          data[field] = sharedValue;
          reserve(sharedValue);
          continue;
        }
        if (autoGenerate) {
          data[field] = await generate();
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

      // New values are stored in canonical form: the UUID part in lowercase.
      const canonical = canonicalUuidValue(value);
      if (canonical !== value) {
        value = canonical;
        data[field] = canonical;
        if (documentId && (await documentHolds(uid, field, value, documentId))) {
          reserve(value);
          continue;
        }
      }

      // A client-supplied value is claimed: serialize with other processes
      // that claim the same value, then read the latest owner.
      const latest = !serverGenerated && (await lockValue(uid, field, value));

      if (
        !isEmpty(sharedValue) &&
        (serverGenerated || (await findOtherOwner(uid, field, value, documentId, latest)))
      ) {
        data[field] = sharedValue;
        reserve(sharedValue);
        continue;
      }

      const isClone = Boolean(documentId) && (await checkNewDocument());

      if (serverGenerated) {
        data[field] = await generate();
        reserve(data[field]);
        log.debug(`[strapi-auto-uuid] Replaced a client-supplied value for ${uid}.${field}`);
        continue;
      }

      const valid = isUuidFieldValue(value, options);
      // A duplicate inside the same batch is a client error, never a clone copy.
      const batchDuplicate = valid && reserved.has(`${field}\u0000${value}`);
      const ownedElsewhere =
        valid &&
        !batchDuplicate &&
        Boolean(await findOtherOwner(uid, field, value, documentId, latest));
      const duplicate = batchDuplicate || ownedElsewhere;

      if (isClone && autoGenerate && (!valid || ownedElsewhere)) {
        data[field] = await generate();
        reserve(data[field]);
        log.info(`[strapi-auto-uuid] Generated a new value for a cloned ${uid}.${field}`);
        continue;
      }

      if (!valid) {
        throw uuidValidationError(`Invalid UUID format for field '${field}'`, {
          field,
          code: 'INVALID_UUID',
        });
      }
      if (duplicate) {
        throw uuidValidationError(
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
      throw uuidValidationError(
        `UUID field '${field}' is immutable. Enable manual editing in the field options to change it.`,
        { field, code: 'IMMUTABLE_UUID' }
      );
    }

    if (isEmpty(newValue) || copiesOwnValue) return;

    if (!isUuidFieldValue(newValue, options)) {
      throw uuidValidationError(`Invalid UUID format for field '${field}'`, {
        field,
        code: 'INVALID_UUID',
      });
    }
    const latest = await lockValue(uid, field, newValue);
    if (await findOtherOwner(uid, field, newValue, documentId, latest)) {
      throw uuidValidationError(
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
        throw uuidValidationError(`Invalid UUID format for field '${field}'`, {
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
  const loadTargets = (uid, where, touched, many, latest = false) => {
    const query = {
      where: where || {},
      select: ['id', 'documentId', ...touched.map(({ field }) => field)],
    };
    if (latest) return many ? findManyLatest(uid, query) : findOneLatest(uid, query);
    return many ? strapi.db.query(uid).findMany(query) : strapi.db.query(uid).findOne(query);
  };

  /**
   * Locks the write-once fields of the target documents that are still
   * empty, so two concurrent saves cannot both pass the "still empty" check.
   *
   * @param {string} uid Content type UID.
   * @param {Array<{ field: string, attribute: Object }>} touched Fields in the update.
   * @param {Array<Record<string, unknown>>} rows Target rows read without a lock.
   * @returns {Promise<boolean>} Whether locks were taken; the caller must then read the rows again.
   */
  const lockWriteOnceFields = (uid, touched, rows) => {
    const keys = [];
    for (const { field, attribute } of touched) {
      if (getOptions(uid, field, attribute).allowEdit) continue;
      for (const row of rows) {
        if (isEmpty(row[field])) keys.push(documentLockKey(uid, field, row.documentId));
      }
    }
    return lockKeys(strapi, LOCK_SPACES.document, keys);
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

      let row = await loadTargets(uid, params.where, touched, false);
      if (row && (await lockWriteOnceFields(uid, touched, [row]))) {
        row = await loadTargets(uid, params.where, touched, false, true);
      }
      if (!row) {
        throw uuidValidationError(
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
        // A changed value is stored in canonical form (lowercase UUID part).
        // An unchanged value is kept exactly as stored.
        if (!isEmpty(data[field]) && data[field] !== row[field]) {
          data[field] = canonicalUuidValue(data[field]);
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

      let rows = await loadTargets(uid, params.where, touched, true);
      if (rows.length > 0 && (await lockWriteOnceFields(uid, touched, rows))) {
        rows = await loadTargets(uid, params.where, touched, true, true);
      }
      if (rows.length === 0) return;

      for (const { field, attribute } of touched) {
        if (rows.every((row) => sameValue(row[field], data[field]))) continue;
        if (!isEmpty(data[field])) data[field] = canonicalUuidValue(data[field]);
        const newValue = data[field];
        if (rows.every((row) => sameValue(row[field], newValue))) continue;

        const documentIds = new Set(rows.map((row) => row.documentId));
        if (documentIds.size > 1) {
          throw uuidValidationError(
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
