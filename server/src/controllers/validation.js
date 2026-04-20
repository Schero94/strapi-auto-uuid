/**
 * Zod validation schemas for UUID plugin controller.
 *
 * Every schema is applied to ctx.request.body BEFORE the payload reaches
 * any service method. A ValidationError from @strapi/utils is thrown on
 * the first failing field so Strapi returns the standard error envelope.
 */
import { z } from 'zod';
import { errors } from '@strapi/utils';

const { ValidationError } = errors;

export const checkDuplicateSchema = z.object({
  contentType: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('api::'), {
      message: 'contentType must be an api:: UID',
    }),
  field: z.string().min(1),
  uuid: z.string().min(1),
  excludeDocumentId: z.string().min(1).optional(),
});

export const dryRunOnlySchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

export const migrationRunSchema = z
  .object({
    dryRun: z.boolean().optional().default(true),
    fixEmpty: z.boolean().optional().default(true),
    fixInvalid: z.boolean().optional().default(true),
    fixDuplicates: z.boolean().optional().default(true),
  })
  .strict();

const MAX_IMPORT_ENTRIES_PER_FIELD = 100_000;

const mappingEntrySchema = z.object({
  documentId: z.string().min(1).max(64),
  uuid: z.string().min(1).max(256),
});

const mappingContentTypeSchema = z.object({
  fields: z.record(
    z.string().min(1).max(128),
    z.array(mappingEntrySchema).max(MAX_IMPORT_ENTRIES_PER_FIELD)
  ),
});

/**
 * The import payload wraps a previously-exported JSON file under `mappings`.
 * Export shape: { exportedAt, version, mappings: Record<UID, ...> }.
 * The inner `mappings` is what the service actually iterates over.
 */
export const importMappingsSchema = z.object({
  mappings: z.object({
    exportedAt: z.string().optional(),
    version: z.string().optional(),
    mappings: z.record(
      z.string().regex(/^api::[a-z0-9-]+\.[a-z0-9-]+$/, {
        message: 'Content type UID must match api::<api>.<model>',
      }),
      mappingContentTypeSchema
    ),
  }),
  dryRun: z.boolean().optional().default(true),
  overwrite: z.boolean().optional().default(false),
});

/**
 * Parses an input with a Zod schema and converts any error into a Strapi
 * ValidationError so the framework formats the response envelope correctly.
 *
 * @param {z.ZodTypeAny} schema - Zod schema to apply
 * @param {unknown} input - Raw ctx.request.body or similar
 * @returns {any} Parsed, typed, and defaulted value
 * @throws {ValidationError} When validation fails
 */
export const parseBody = (schema, input) => {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join('.') || '(root)';
    throw new ValidationError(`Invalid request body at '${path}': ${first.message}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
};
