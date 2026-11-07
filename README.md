# Auto UUID for Strapi 5

A UUID custom field for Strapi 5. Every entry gets a UUID v4 or v7 when it is saved, duplicates are rejected, and values that should not change stay locked. A settings page checks, repairs, exports and imports the UUIDs of all content types.

[![npm version](https://img.shields.io/npm/v/strapi-auto-uuid-v5.svg)](https://www.npmjs.com/package/strapi-auto-uuid-v5)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Strapi 5](https://img.shields.io/badge/Strapi-5.24%2B-4945FF.svg)](https://strapi.io)

**Project site:** [schero94.github.io/strapi-auto-uuid](https://schero94.github.io/strapi-auto-uuid/)

This is the Strapi 5 continuation of [Cringe-Studio/strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid), which supports Strapi 4 only.

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Field options](#field-options)
- [How values are protected](#how-values-are-protected)
- [UUID management page](#uuid-management-page)
- [Plugin configuration](#plugin-configuration)
- [Admin API](#admin-api)
- [Permissions](#permissions)
- [Security](#security)
- [Upgrading from Strapi 4](#upgrading-from-strapi-4)
- [Troubleshooting](#troubleshooting)
- [Development and release](#development-and-release)

## What you get

- A **UUID** custom field for content types, with UUID v4 (random) or v7 (time-sortable) and an optional prefix such as `usr_`.
- Server-side generation on create, so REST, GraphQL, the Document Service and the admin all get a value.
- Uniqueness across documents, checked on every save, in all locales and in drafts and published versions.
- Immutable values by default; editing can be allowed per field.
- A settings page with counts per content type, a check, repairs with preview and confirmation, and export/import of all UUIDs.
- Admin UI in English, German, French, Spanish and Portuguese.

## Requirements

|          | Version                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| Strapi   | 5.24 or newer (tested with 5.61)                                              |
| Node.js  | 22.12 or newer (Strapi 5.61 supports up to 26)                                |
| Database | Any database Strapi supports. The test suite runs on SQLite (better-sqlite3). |

## Quick start

1. Install the package in your Strapi project:

   ```bash
   npm install strapi-auto-uuid-v5
   ```

2. Enable the plugin in `config/plugins.js` (or `.ts`):

   ```js
   module.exports = {
     'field-uuid': {
       enabled: true,
     },
   };
   ```

3. Rebuild the admin and start Strapi: `npm run build && npm run develop`.
4. In the Content-Type Builder, open a content type, choose **Add another field**, then **Custom** and **UUID**.
5. Save an entry. The UUID is generated on save and shown in the field.

## Field options

Set these when you add or edit the field in the Content-Type Builder.

| Option                  | Default | Effect                                                                                                                                                                                                 |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UUID version            | `v4`    | `v4` is random. `v7` is time-sortable and recommended for new fields. Changing it later keeps existing values.                                                                                         |
| Prefix                  | none    | Up to 16 letters, numbers, `_` or `-`, added before the UUID (`usr_018f...`).                                                                                                                          |
| Unique values           | on      | Strapi also checks uniqueness when an entry is published. This is **not** a database constraint; Strapi 5 does not create one for this option. The plugin rejects duplicates on every save either way. |
| Private field           | off     | The field is not returned by the API.                                                                                                                                                                  |
| Disable auto-generation | off     | Editors enter the UUID themselves. Without manual editing it can be entered once and is then locked.                                                                                                   |
| Allow manual editing    | off     | Editors and API clients can set and change the UUID. When off, the server generates the value and nobody can change it.                                                                                |

## How values are protected

| Situation                                                 | Result                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Create with an empty field                                | A value is generated (unless auto-generation is off).                                                |
| Create with a value, field not editable                   | The value is replaced by a generated one.                                                            |
| Create with a value, field editable                       | Kept if it matches the version and prefix and no other document uses it; otherwise 400.              |
| Publish, discard draft, new locale                        | The document's existing value is kept.                                                               |
| Clone                                                     | The copy gets a new value.                                                                           |
| Update with the same value                                | Always accepted, even if it predates a version or prefix change.                                     |
| Update with a different value                             | Only for editable fields, or once while the field is empty. Must be valid and unused, otherwise 400. |
| Existing entry without a value                            | Filled on its next save.                                                                             |
| Bulk `updateMany` that sets one UUID on several documents | Rejected with 400.                                                                                   |

Rows of the same document (draft and published version, and the locales of a non-localized field) may share a value. Two documents may not. Under heavy concurrent writes of _client-supplied_ values, two creates can still race between the check and the insert, because Strapi has no database constraint for this field; generated v4/v7 values do not collide in practice. UUID fields inside components and dynamic zones are filled by the admin panel when the component is shown with an empty value; the server does not generate, validate or repair them (API writes, cloned entries and duplicated components keep whatever value they carry). Use a content-type field when the value must be unique. The plugin logs a warning at startup when it finds such a field.

Errors use Strapi's standard envelope, for example:

```json
{
  "data": null,
  "error": {
    "status": 400,
    "name": "ValidationError",
    "message": "UUID already exists for field 'publicId'. Please use a unique value.",
    "details": { "field": "publicId", "code": "DUPLICATE_UUID" }
  }
}
```

Codes: `INVALID_UUID`, `DUPLICATE_UUID`, `IMMUTABLE_UUID`, `BULK_UUID_WRITE`, `INVALID_UUID_FIELD_CONFIG`, `UUID_TARGET_UNKNOWN`.

## UUID management page

**Settings > Auto UUID > UUID management**

- **Overview:** content types, UUID fields, entries, duplicates, empty and malformed values. Values in an older version or prefix are counted separately; they still work and are kept by default.
- **Run check:** scans every field again.
- **Repair all:** choose duplicates, malformed values, empty fields and (optionally) older-format values, preview the changes, then apply them after a confirmation. The oldest document keeps a shared UUID.
- **Replace duplicates** and **Generate missing UUIDs:** the same repair limited to one category. Fields with auto-generation off are never filled.
- **Export UUIDs:** downloads every UUID with its documentId and locale as JSON.
- **Import UUIDs:** fills empty fields from an export (file or pasted JSON). Existing values are never replaced.

Repairs and imports run in one database transaction and are rolled back completely if a write fails. Only one repair or import runs at a time per Strapi process.

## Plugin configuration

All keys are optional. Unknown keys and wrong types fail at boot.

```js
module.exports = {
  'field-uuid': {
    enabled: true,
    config: {
      defaultVersion: 'v4', // version for fields without an explicit version: 'v4' | 'v7'
      autoGenerate: true, // generate values on create and for empty fields on save
      validateUniqueness: true, // reject values used by another document
      maxRetryAttempts: 3, // collision retries per generated value, integer 1-10
      autoMigrate: false, // repair empty, malformed and duplicate values on boot
      logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
    },
  },
};
```

`autoMigrate` writes data on every start. It is refused when `NODE_ENV=production` unless `STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE=true` is set, and it never replaces older-format values. `allowManualEdit` from 1.x is accepted but has no effect; use the per-field option.

## Admin API

All routes are admin routes under `/field-uuid` (for example `GET /field-uuid/stats` on your Strapi host), require an admin JWT and, except `/health`, the listed permission. The plugin has no Content API routes. Write endpoints default to a preview: send `"dryRun": false` to write.

| Method and path          | Permission          | Body                                                              | Notes                                                      |
| ------------------------ | ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /health`            | authenticated admin |                                                                   | `{ status: 'ok' }`                                         |
| `GET /stats`             | `read`              |                                                                   | Counts, per-field counts, UUID fields per content type     |
| `GET /models`            | `read`              |                                                                   | `{ models: { uid: [field] } }`                             |
| `GET /diagnose`          | `read`              |                                                                   | Counts per field, no values                                |
| `GET /migration/status`  | `read`              |                                                                   | Counts per field, no values                                |
| `POST /autofix`          | `migrate`           | `{ dryRun? }`                                                     | Replace duplicates                                         |
| `POST /generate-missing` | `migrate`           | `{ dryRun? }`                                                     | Fill empty fields                                          |
| `POST /migration/run`    | `migrate`           | `{ dryRun?, fixEmpty?, fixInvalid?, fixDuplicates?, fixLegacy? }` | At least one option must be true                           |
| `GET /migration/export`  | `export`            |                                                                   | JSON attachment with all mappings                          |
| `POST /migration/import` | `import`            | `{ mappings, dryRun? }`                                           | Max. 50,000 entries, 100 content types, 20 fields per type |

Diagnostic and repair responses never contain documentIds or UUID values; only the export does. A repair while another one runs returns 409. Rate limits per admin and minute: diagnose and repairs 5, migration run, export and import 3, status 10, stats 20.

## Permissions

Settings > Administration Panel > Roles > Plugins > Auto UUID:

| Action                                 | Allows                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Read UUID status and diagnostics       | The settings page, counts and the check                                                             |
| Repair UUIDs                           | Replace duplicates and malformed values, fill empty fields                                          |
| Export all UUID mappings               | Download every documentId and UUID of every content type, regardless of Content Manager permissions |
| Import UUID mappings into empty fields | Fill empty UUID fields from a file                                                                  |

The settings link and each action are shown only to roles that have the permission.

## Security

- Every admin route checks authentication and the plugin permission on the server; request bodies are validated with strict zod schemas.
- Errors never contain stack traces, database errors or stored values. Logs contain the admin id for repairs, exports and imports (audit) but no values, IP addresses or request bodies.
- Report security issues privately through [GitHub security advisories](https://github.com/Schero94/strapi-auto-uuid/security/advisories/new).

## Upgrading from Strapi 4

1. Rename the plugin key in `config/plugins.js` from `strapi-auto-uuid` to `field-uuid`.
2. Start Strapi, open **Settings > Auto UUID > UUID management** and run the check.
3. Export the UUIDs as a backup, then use **Repair all** with the preview if duplicates or empty fields are reported.

Existing values are kept: the field type changed from `uid` to `string`, which does not alter the stored data.

## Troubleshooting

- **The UUID field is missing in the Content-Type Builder:** check that the key is `field-uuid` and rebuild the admin.
- **"UUID field '...' is immutable":** the field does not allow manual editing. Turn on **Allow manual editing** if editors or API clients must change it.
- **A value sent on create was replaced:** the field is generated on the server because manual editing is off.
- **Values are reported as "older version or prefix":** the field's version or prefix was changed. The values keep working; replace them with **Repair all** and the older-format option only if no integration depends on them.

## Development and release

```bash
npm ci --legacy-peer-deps
npm run lint          # ESLint 10 flat config
npm run format:check  # Prettier
npm test              # Vitest, including lifecycle and repair tests on a real SQLite database
npm run build         # strapi-plugin build + bundle checks (externals, chunk size)
npm run verify        # strapi-plugin verify
```

Releases are published by semantic-release from `main` with npm provenance (see [CHANGELOG.md](CHANGELOG.md)). Pull requests run the same gates on Node 22 and 24.

## License

MIT, see [LICENSE](LICENSE). Originally created by [Cringe Studio](https://github.com/Cringe-Studio).
