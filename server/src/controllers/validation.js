/**
 * Zod 4 schemas for the admin controller. Every request body is parsed
 * before it reaches a service; failures become a Strapi ValidationError so
 * the admin receives the standard error envelope.
 */
import { z } from 'zod';
import { errors } from '@strapi/utils';

const { ValidationError } = errors;

/** Upper bounds that keep imports well inside the default 1 MB JSON body limit. */
export const IMPORT_LIMITS = Object.freeze({
  contentTypes: 100,
  fieldsPerContentType: 20,
  totalEntries: 50_000,
  documentIdLength: 64,
  localeLength: 32,
  // 16-character prefix + 36-character UUID.
  uuidLength: 52,
  fieldNameLength: 128,
});

export const dryRunOnlySchema = z.strictObject({
  // Writes require an explicit `{ dryRun: false }`.
  dryRun: z.boolean().optional().default(true),
});

export const migrationRunSchema = z
  .strictObject({
    dryRun: z.boolean().optional().default(true),
    fixEmpty: z.boolean().optional().default(true),
    fixInvalid: z.boolean().optional().default(true),
    fixDuplicates: z.boolean().optional().default(true),
    fixLegacy: z.boolean().optional().default(false),
  })
  .refine((value) => value.fixEmpty || value.fixInvalid || value.fixDuplicates || value.fixLegacy, {
    message: 'Select at least one repair option.',
  });

const mappingEntrySchema = z.strictObject({
  documentId: z.string().min(1).max(IMPORT_LIMITS.documentIdLength),
  locale: z.string().min(1).max(IMPORT_LIMITS.localeLength).optional(),
  uuid: z.string().min(1).max(IMPORT_LIMITS.uuidLength),
});

const fieldNameSchema = z
  .string()
  .min(1)
  .max(IMPORT_LIMITS.fieldNameLength)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, { message: 'Invalid field name.' });

const mappingContentTypeSchema = z.strictObject({
  fields: z
    .record(fieldNameSchema, z.array(mappingEntrySchema))
    .refine((fields) => Object.keys(fields).length <= IMPORT_LIMITS.fieldsPerContentType, {
      message: `At most ${IMPORT_LIMITS.fieldsPerContentType} fields per content type.`,
    }),
});

const uidSchema = z.string().regex(/^(api|plugin)::[a-z0-9-]+\.[a-z0-9-]+$/, {
  message: 'Content type UID must match api::<api>.<model> or plugin::<plugin>.<model>',
});

/**
 * The import body wraps a previously exported file under `mappings`.
 * Export shape: `{ exportedAt, format, mappings: Record<UID, { fields }> }`.
 * Files from 1.x carry `version` instead of `format` and are accepted.
 * `overwrite` was removed: existing values are never replaced by an import.
 * `overwrite: false` is still accepted for older clients.
 */
export const importMappingsSchema = z.strictObject({
  mappings: z.strictObject({
    exportedAt: z.string().max(64).optional(),
    version: z.string().max(32).optional(),
    format: z.number().int().optional(),
    mappings: z
      .record(uidSchema, mappingContentTypeSchema)
      .refine((value) => Object.keys(value).length <= IMPORT_LIMITS.contentTypes, {
        message: `At most ${IMPORT_LIMITS.contentTypes} content types per import.`,
      })
      .refine(
        (value) =>
          Object.values(value).reduce(
            (sum, ct) =>
              sum + Object.values(ct.fields).reduce((inner, list) => inner + list.length, 0),
            0
          ) <= IMPORT_LIMITS.totalEntries,
        { message: `At most ${IMPORT_LIMITS.totalEntries} entries per import.` }
      ),
  }),
  dryRun: z.boolean().optional().default(true),
  overwrite: z.literal(false).optional(),
});

/**
 * Parses an input with a Zod schema and converts failures into a Strapi
 * ValidationError. Only the first issue's path and message are returned;
 * submitted values are never echoed.
 *
 * @param {z.ZodType} schema Zod schema.
 * @param {unknown} input Raw request body.
 * @returns {any} Parsed and defaulted value.
 * @throws {ValidationError} When validation fails.
 */
export const parseBody = (schema, input) => {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join('.') || '(root)';
    throw new ValidationError(`Invalid request body at '${path}': ${first.message}`, {
      code: 'INVALID_REQUEST',
      path,
    });
  }
  return result.data;
};
