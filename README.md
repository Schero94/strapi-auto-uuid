# Auto UUID for Strapi 5

Give every Strapi 5 entry a UUID that is generated on the server, stays unique across documents and cannot be changed by accident. Add the field in the Content-Type Builder, save an entry, and the value is there, whether it came from the admin, REST, GraphQL or the Document Service.

[![npm version](https://img.shields.io/npm/v/strapi-auto-uuid-v5.svg)](https://www.npmjs.com/package/strapi-auto-uuid-v5)
[![npm downloads](https://img.shields.io/npm/dm/strapi-auto-uuid-v5.svg)](https://www.npmjs.com/package/strapi-auto-uuid-v5)
[![CI](https://github.com/Schero94/strapi-auto-uuid/actions/workflows/ci.yml/badge.svg)](https://github.com/Schero94/strapi-auto-uuid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Strapi 5](https://img.shields.io/badge/Strapi-5.24%2B-4945FF.svg)](https://strapi.io)

![UUID management page in the Strapi admin panel](pics/settings-light.png)

**Project site:** [schero94.github.io/strapi-auto-uuid](https://schero94.github.io/strapi-auto-uuid/)

This is the Strapi 5 continuation of [Cringe-Studio/strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid), which supports Strapi 4 only.

## Contents

- [What you get](#what-you-get)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Field options](#field-options)
- [How values are protected](#how-values-are-protected)
- [UUID management page](#uuid-management-page)
- [Plugin configuration](#plugin-configuration)
- [Admin API](#admin-api)
- [Permissions](#permissions)
- [Security](#security)
- [Performance](#performance)
- [Running several instances (Railway replicas, pm2 cluster)](#running-several-instances-railway-replicas-pm2-cluster)
- [Upgrading from 1.x](#upgrading-from-1x)
- [Upgrading from Strapi 4](#upgrading-from-strapi-4)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Development and release](#development-and-release)

## What you get

- A **UUID** custom field for content types, with UUID v4 (random) or v7 (time-sortable) and an optional prefix such as `usr_`.
- Server-side generation on create, so REST, GraphQL, the Document Service and the admin all get a value.
- Uniqueness across documents, checked on every save, in all locales and in drafts and published versions. UUIDs are compared case-insensitively (RFC 9562), and new values are stored in lowercase.
- Immutable values by default; editing can be allowed per field.
- A settings page with counts per content type, a check, repairs with preview and confirmation, and export/import of all UUIDs.
- Admin UI in English, German, French, Spanish and Portuguese.

## Screenshots

All screenshots use synthetic data.

| UUID management                                                                                  | Repair preview                                                                            |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| ![UUID management page with counts and repair actions](pics/settings-light.png)                  | ![Repair all dialog with options and a preview](pics/repair-dialog-light.png)             |
| **Editable field (copy and generate)**                                                           | **Locked fields, dark mode**                                                              |
| ![Content Manager entry with an editable UUID field](pics/field-editable-light.png)              | ![Content Manager entry with locked UUID fields in dark mode](pics/field-locked-dark.png) |
| **Field options in the Content-Type Builder**                                                    | **UUID management, dark mode**                                                            |
| ![Content-Type Builder dialog with UUID version and prefix](pics/content-type-builder-light.png) | ![UUID management page in dark mode](pics/settings-dark.png)                              |
| **Mobile, light**                                                                                | **Mobile, dark**                                                                          |
| ![UUID management page on a phone](pics/settings-mobile-light.png)                               | ![UUID management page on a phone in dark mode](pics/settings-mobile-dark.png)            |

## Requirements

| Plugin version     | Strapi                                                                                  | Node.js                  | Database                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| 2.x (next release) | 5.24 or newer, tested with 5.61                                                         | 22.12 or newer, up to 26 | Any database Strapi supports; the test suite runs on SQLite and PostgreSQL |
| 1.x                | 5.x                                                                                     | as required by Strapi    | Any database Strapi supports                                               |
| Strapi 4           | use [Cringe-Studio/strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid) |                          |                                                                            |

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

| Situation                                                 | Result                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create with an empty field                                | A value is generated (unless auto-generation is off).                                                                                                            |
| Create with a value, field not editable                   | The value is replaced by a generated one.                                                                                                                        |
| Create with a value, field editable                       | Kept if it matches the version and prefix and no other document uses it; otherwise 400.                                                                          |
| Publish, discard draft, new locale                        | The document's existing value is kept.                                                                                                                           |
| Clone                                                     | The copy gets a new value. On the admin clone page the copied value is cleared: it is generated on save, or the editor enters a new one for manual-entry fields. |
| Update with the same value                                | Always accepted, even if it predates a version or prefix change.                                                                                                 |
| Update with a different value                             | Only for editable fields, or once while the field is empty. Must be valid and unused, otherwise 400.                                                             |
| Existing entry without a value                            | Filled on its next save.                                                                                                                                         |
| Value that differs from another document's only in case   | Treated as a duplicate (400). A new value sent in uppercase is stored in lowercase.                                                                              |
| Bulk `updateMany` that sets one UUID on several documents | Rejected with 400.                                                                                                                                               |

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
- **Run check:** scans every field again (one scan per click).
- **Repair all:** choose duplicates, malformed values, empty fields and (optionally) older-format values, preview the changes, then apply them after a confirmation. The oldest document keeps a shared UUID.
- **Replace duplicates** and **Generate missing UUIDs:** the same repair limited to one category. Fields with auto-generation off are never filled.
- **Export UUIDs:** downloads every UUID with its documentId and locale as compact JSON. A large export is split into several files (`...-part-1-of-3.json`) so that each one fits the import limits.
- **Import UUIDs:** fills empty fields from an export (file or pasted JSON). Existing values are never replaced.

Repairs and imports run in one database transaction and are rolled back completely if a write fails. Only one repair or import runs at a time per Strapi process. For a localized UUID field every locale keeps its own value: a repair fills an empty locale with a new value (or with the value of its own draft) and never copies another locale's value. The **Entries** card counts documents, once per content type, even when a content type has several UUID fields.

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
      rateLimitStore: 'auto', // 'auto' | 'database' | 'memory'
    },
  },
};
```

| Option               | Type                                     | Default  | Description                                                                                                                                                                                 |
| -------------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultVersion`     | `'v4' \| 'v7'`                           | `'v4'`   | Version for fields that do not set one.                                                                                                                                                     |
| `autoGenerate`       | boolean                                  | `true`   | Generate values on create and fill empty fields on save. Per field, **Disable auto-generation** wins.                                                                                       |
| `validateUniqueness` | boolean                                  | `true`   | Reject a value that another document already uses.                                                                                                                                          |
| `maxRetryAttempts`   | integer, 1 to 10                         | `3`      | Retries when a generated value is already taken.                                                                                                                                            |
| `autoMigrate`        | boolean                                  | `false`  | Repair empty, malformed and duplicate values at startup (see below).                                                                                                                        |
| `logLevel`           | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` | Minimum level of the plugin's log lines.                                                                                                                                                    |
| `rateLimitStore`     | `'auto' \| 'database' \| 'memory'`       | `'auto'` | Where admin rate-limit counters live. `auto`: database on PostgreSQL and MySQL, memory on SQLite. See [Running several instances](#running-several-instances-railway-replicas-pm2-cluster). |

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
| `POST /migration/import` | `import`            | `{ mappings, dryRun? }`                                           | Max. 10,000 entries, 100 content types, 20 fields per type |

An import body must also fit Strapi's JSON body limit (`jsonLimit` of the `strapi::body` middleware, 1 MB by default), which holds roughly 9,000 to 11,000 entries depending on prefix and locale. The admin export already splits files to fit both limits. Diagnostic and repair responses never contain documentIds or UUID values; only the export does. A repair while another one runs, on any instance, returns 409. Rate limits per admin and minute (shared by all instances with the database store): diagnose and repairs 5, migration run, export and import 3, status 10, stats 20.

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
- Export holders see every documentId and UUID of every content type; the export is not filtered by Content Manager permissions, so grant it like a backup permission.
- There is no database unique constraint: the draft, published and locale rows of one document share a value, so a plain unique index is not possible (see [Performance](#performance) for an optional lookup index). Concurrent writes from several processes are serialized with transaction-scoped database locks instead; see [Running several instances](#running-several-instances-railway-replicas-pm2-cluster).
- Report security issues privately through [GitHub security advisories](https://github.com/Schero94/strapi-auto-uuid/security/advisories/new).

## Performance

- Each save runs a few lookups per UUID field (`select id ... where field = ? limit 1`). Without an index each one scans the table, so the cost grows with the number of rows.
- Checks, repairs and exports read rows in pages of 5,000 by primary key and only select `id`, `documentId`, `locale`, `publishedAt` and the UUID column. No relations are populated.
- Imports look up targets and conflicts in batches of 500 entries (two queries per batch), then write one `updateMany` per imported value.
- Measured on SQLite with about 5,000 synthetic tickets: the overview scan answered in 40 ms, a 5,000-value import preview took 64 ms and the import itself 315 ms.

For large tables, add an index on each UUID column with a [Strapi database migration](https://docs.strapi.io/cms/database-migrations). Strapi runs these files once, before its schema sync, and keeps indexes it did not create. Add the migration after the column exists (the migration skips a missing table or column and does not run again):

```js
// database/migrations/2026.11.07T00.00.00.uuid-indexes.js
'use strict';

// [table, column] pairs: the snake_case names Strapi uses in the database.
const INDEXES = [
  ['tickets', 'ticket_id'],
  ['articles', 'public_id'],
];

async function up(knex) {
  for (const [table, column] of INDEXES) {
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) {
      continue;
    }
    await knex.schema.alterTable(table, (t) => t.index([column], `${table}_${column}_uuid_idx`));
  }
}

module.exports = { up };
```

The test suite runs this code on SQLite and checks that the lookup changes from `SCAN` to `SEARCH ... USING INDEX`.

## Running several instances (Railway replicas, pm2 cluster)

The plugin is safe when several Strapi processes share one database, for example 2 Railway replicas that each run 4 pm2 cluster workers (8 Node processes, no sticky sessions). The database is the only shared state; Redis or any other service is not needed.

What is coordinated, and how:

| Concern                                                         | Mechanism                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two processes save the same client-supplied UUID                | Before the uniqueness check, the save takes a lock on that value for the rest of its transaction. The second save waits, then sees the first and gets 400 `DUPLICATE_UUID`. |
| Two processes fill the same empty, non-editable field           | The save locks that field of the document and reads the row again. The second save sees the stored value and gets 400 `IMMUTABLE_UUID`.                                     |
| Repair or import started on two processes (also two clicks)     | The repair transaction takes a repair lock without waiting. The other process answers 409 `REPAIR_IN_PROGRESS`.                                                             |
| `autoMigrate` on every booting process                          | Same repair lock: one process repairs, the others log `Boot repair skipped` and continue starting.                                                                          |
| An editor changes a row between the repair's scan and its write | Every repair and import write is guarded by the expected old value. A write that matches no row is not counted and is reported as skipped (`CONCURRENT_CHANGE`).            |
| Admin rate limits (`/migration/run`, export, import, ...)       | One counter per admin and route in the table `field_uuid_rate_limits`, incremented with one atomic upsert, so the limit holds across all processes.                         |

Locks are transaction-scoped and released by the database on commit, rollback or a lost connection, so a crashed worker never leaves one behind:

- **PostgreSQL** (recommended): advisory locks (`pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`). No extra table.
- **MySQL 8 / MariaDB** (not tested live yet): row locks (`SELECT ... FOR UPDATE [NOWAIT]`) on the plugin table `field_uuid_locks` (2,049 small rows, created at startup). Reads after a lock use `FOR UPDATE`, because MySQL's default REPEATABLE READ would otherwise return an older snapshot. Add the [lookup index](#performance) on each UUID column so these reads lock only matching rows.
- **SQLite**: one writer per file, so writes are already serialized. Running several processes on one SQLite file is not supported by Strapi; use one process.

Values are hashed into 1,024 lock buckets per kind, so a large import holds at most 1,024 locks. Server-generated random values take no lock. Writes that run outside a transaction (a bare `strapi.db.query().create()`) take no lock either; the Document Service, the Content Manager and the REST and GraphQL APIs always use a transaction.

The plugin creates two tables at startup when they are missing: `field_uuid_rate_limits` (PostgreSQL and MySQL, or SQLite with `rateLimitStore: 'database'`) and `field_uuid_locks` (MySQL only). Strapi's schema sync leaves tables it did not create alone. Rate-limit keys are SHA-256 hashes; no admin id or IP address is stored. Rows expired for more than an hour are deleted on later requests.

### Configuration

Railway service variables (each replica):

```bash
DATABASE_CLIENT=postgres
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
# Optional: only if autoMigrate should run on boot in production.
# STRAPI_AUTO_UUID_ALLOW_PRODUCTION_MIGRATE=true
```

`config/plugins.js`:

```js
module.exports = {
  'field-uuid': {
    enabled: true,
    config: {
      rateLimitStore: 'auto', // 'database' on PostgreSQL and MySQL
      autoMigrate: false, // recommended: run repairs from the admin page instead
    },
  },
};
```

pm2 cluster mode needs a JavaScript entry point ([Strapi pm2 guide](https://docs.strapi.io/cms/deployment/guides/pm2)):

```js
// server.js
const strapi = require('@strapi/strapi');
strapi.createStrapi({ distDir: './dist' }).start(); // distDir for TypeScript projects
```

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'strapi',
      script: './server.js',
      exec_mode: 'cluster',
      instances: 4,
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

Size the database pool for all processes: `processes x pool max` (for example 8 x 10 = 80 with Strapi's default `pool.max`) must stay below the PostgreSQL `max_connections` of your plan, or lower `pool.max` in `config/database.js`.

### Rolling deploys and schema changes

Each process reads the UUID fields and their options once at startup. During a rolling deploy, old and new replicas run side by side: until every replica runs the new code, old ones do not generate or validate a newly added UUID field and apply the old field options. Nothing is lost (empty values are filled on the next save or by a repair, older-format values are kept). After a deploy that adds a UUID field or changes its options, wait until every replica is up, then run **Check** and **Repair all** (or **Generate missing**) once from the admin page.

### Verify it

`npm run test:concurrency` starts 8 Node processes against one database and races the cases above. Run it against PostgreSQL with `AUTO_UUID_PG_URL=postgres://user@host:5432/db npm run test:concurrency -- --client postgres`.

## Upgrading from 1.x

The next release is a major version (2.0.0) because some write rules are stricter:

1. Node.js 22.12 or newer and Strapi 5.24 or newer are required.
2. Fields with **Allow manual editing** off are generated on the server only. A value sent on create is replaced. API clients that send their own UUIDs need **Allow manual editing** on for that field.
3. A create that sends a UUID another document already uses is rejected with 400 `DUPLICATE_UUID`. This includes the same UUID in different letter case.
4. `POST /field-uuid/check-duplicate` was removed (the admin never used it). `POST /field-uuid/migration/import` no longer accepts `overwrite: true` and takes at most 10,000 entries.
5. Unknown plugin config keys fail at boot. `allowManualEdit` is still accepted and still has no effect.
6. The Content Manager no longer shows a UUID on the create form; the value appears after the first save.

After upgrading, open **Settings > Auto UUID > UUID management**, run the check and export a backup before you use **Repair all**.

## Upgrading from Strapi 4

1. Rename the plugin key in `config/plugins.js` from `strapi-auto-uuid` to `field-uuid`.
2. Start Strapi, open **Settings > Auto UUID > UUID management** and run the check.
3. Export the UUIDs as a backup, then use **Repair all** with the preview if duplicates or empty fields are reported.

Existing values are kept: the field type changed from `uid` to `string`, which does not alter the stored data.

## Troubleshooting and FAQ

- **The UUID field is missing in the Content-Type Builder:** check that the key is `field-uuid` and rebuild the admin.
- **"UUID field '...' is immutable":** the field does not allow manual editing. Turn on **Allow manual editing** if editors or API clients must change it.
- **A value sent on create was replaced:** the field is generated on the server because manual editing is off.
- **The Import dialog says the file is larger than 1 MB:** export again. The export is split into files that each fit one import. Import the parts one after another.
- **"Entity could not be cloned" when using Duplicate in the list view:** Strapi refuses its quick clone for any attribute with `unique: true`. Open the entry and use the clone page instead, or turn off **Unique values** for the field (the plugin rejects duplicates on every save either way).
- **429 "Too many requests":** the management routes are rate limited per admin (see [Admin API](#admin-api)). Wait a minute.
- **Does the plugin manage UUID fields inside components?** Only in the admin: an empty one is filled when the component is shown. The server does not generate, validate or repair them.
- **Values are reported as "older version or prefix":** the field's version or prefix was changed. The values keep working; replace them with **Repair all** and the older-format option only if no integration depends on them.

## Development and release

```bash
npm ci --legacy-peer-deps
npm run lint          # ESLint 10 flat config
npm run format:check  # Prettier
npm test              # Vitest, including lifecycle and repair tests on a real SQLite database
                      # (set AUTO_UUID_PG_URL to also run the PostgreSQL tests)
npm run test:concurrency  # 8 processes on one database (SQLite, or PostgreSQL with --client postgres)
npm run build         # strapi-plugin build + bundle checks (externals, chunk size)
npm run verify        # strapi-plugin verify
```

Issues and pull requests are welcome on [GitHub](https://github.com/Schero94/strapi-auto-uuid/issues). Use Conventional Commits; semantic-release picks the version from them.

Releases are published by semantic-release from `main` with npm provenance (see [CHANGELOG.md](CHANGELOG.md)). Pull requests run the same gates on Node 22 and 24.

## License

MIT, see [LICENSE](LICENSE). Originally created by [Cringe Studio](https://github.com/Cringe-Studio).
