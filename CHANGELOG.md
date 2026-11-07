## [Unreleased]

Next release: **1.2.0** (minor, no breaking API change). Auto UUID now saves
reliably on SQLite, checks and repairs every locale and every draft/published
row, and the admin page was reworked within the existing design.

### Upgrade notes

1. Run Node.js 22.12 or newer (uuid 14 is ESM-only and is loaded with
   `require(esm)`). Strapi 5.24 or newer is required; 5.61 is tested.
2. Fields with **Allow manual editing** off are now generated on the server
   only: a value sent on create (REST, GraphQL, Document Service) is replaced
   with a generated one. API clients that supply their own UUIDs need
   **Allow manual editing** on for that field.
3. A create that sends a UUID already used by another document is rejected
   with a 400 `ValidationError` instead of being stored as a duplicate.
4. The admin route `POST /field-uuid/check-duplicate` was removed (the admin
   UI never used it). `POST /field-uuid/migration/import` no longer accepts
   `overwrite: true`; imports only fill empty fields.
5. The plugin config is validated strictly: unknown keys fail at boot and
   `maxRetryAttempts` must be an integer from 1 to 10. `allowManualEdit` is
   still accepted but has no effect (it never had one).
6. "Unique values" in the Content-Type Builder does not create a database
   constraint in Strapi 5. The plugin enforces uniqueness on every save; the
   option text now says so.

### Fixed

- Every locale of a cloned document gets the same value for a non-localized
  UUID field. Document Service `clone({ locale: '*' })` creates the locale
  rows concurrently and gave each locale its own value.
- A duplicate value inside one `createMany` batch is rejected instead of being
  replaced silently when the rows carry new documentIds.
- Plugin validation errors now carry `details.errors[].path`, so the Content
  Manager shows the message under the UUID field. Before, saving an invalid
  value crashed the form error handler (`join is not a function`).
- UUID fields inside components and dynamic zones are filled in the admin
  panel again when the component is shown with an empty value. The server
  does not manage these fields; the startup warning and README say so.
- Focus returns to the generate button after the "Replace this UUID?"
  confirmation is closed.
- A rate-limited request (429) now says "Too many requests in a short time.
  Wait a minute, then try again." instead of "Something went wrong. Refresh
  the page". The 429 body carries `details.code: 'RATE_LIMITED'`.
- Refresh, Run check, Export UUIDs and Try again keep keyboard focus on
  their button. The buttons are disabled while they run, which dropped focus
  to the page body.
- Saving an entry with a UUID field on SQLite no longer stalls until the
  connection timeout and fails: the update target is read inside the
  Document Service transaction.
- Immutability is checked against the row being saved, not an arbitrary
  locale or draft/published row of the same document.
- Changing a field's version or prefix no longer blocks saves of existing
  entries, no longer gives published rows a different UUID than the draft,
  and `autoMigrate` no longer rewrites those values.
- Validation errors from the plugin return 400 with a message instead of
  500: `@strapi/utils` is no longer bundled into the server build.
- The Design System and icons are no longer bundled into the admin build
  (largest admin chunk 1.8 MB -> 53 kB).
- Check, repairs, export and import cover all locales and both draft and
  published rows; duplicates are counted per document and the oldest
  document keeps a shared UUID; draft and published rows stay in sync.
- `createMany` and `updateMany` are validated; clones get a new UUID.
- The admin page no longer replaces itself with a loader during actions,
  no longer shows the empty state when loading failed, and refreshes its
  counts after every change.
- The Content Manager input no longer marks the form as modified when an
  entry is opened, and manual-entry fields can be filled when manual editing
  is off (once, then locked).

### Documentation

- README and the project site show screenshots of the UUID management page,
  the repair preview, the field in the Content Manager (editable and locked,
  light and dark), the Content-Type Builder options and the mobile layout,
  all from synthetic data.
- The project site no longer scrolls sideways on phones (long inline code
  and the section navigation overflowed by up to 120 px at 320 px).

### Added

- Repair preview inside the dialog and a confirmation before any write.
- Repair option for values in an older version or prefix (off by default).
- Import from a file, with imported/unchanged/skipped counts.
- French, Spanish and Portuguese translations.
- Real SQLite test host for lifecycles and repairs; CI on Node 22 and 24;
  Dependabot with verified auto-merge.

### Security

- Repairs and imports run one at a time (409 while another one runs) and
  re-read the data inside their transaction.
- Strict, bounded request schemas for repair and import endpoints; import
  errors are returned as counts plus at most 20 samples.
- The settings link and each action are shown only to roles with the
  matching permission; the server checks the same permissions.
- Rate-limit logs no longer contain user ids or IP addresses.
- Release workflow: SHA-pinned actions, least-privilege permissions,
  installs without lifecycle scripts, npm token fallback with provenance.

### Dependencies

- Peer dependencies: `@strapi/utils`, `@strapi/design-system` and
  `@strapi/icons` added; React ranges aligned with Strapi 5.61.
- `yup` stays pinned to 0.32.9 on purpose: the Content-Type Builder merges
  the custom-field validator into its own yup 0.32.9 schema, so the plugin
  must return schemas from that exact version. Server validation uses zod 4.

# [1.1.0](https://github.com/Schero94/strapi-auto-uuid/compare/v1.0.3...v1.1.0) (2026-04-21)


### Features

* **security:** zod validation, rbac, rate-limiting, audit logs ([05cfed0](https://github.com/Schero94/strapi-auto-uuid/commit/05cfed0651ceb70e0b09a60fd403c2d26c24ee2d))

## [1.0.3](https://github.com/Schero94/strapi-auto-uuid/compare/v1.0.2...v1.0.3) (2026-04-15)


### Bug Fixes

* comprehensive audit - security, bugs, and dependency updates (v1.1.0) ([0e9321b](https://github.com/Schero94/strapi-auto-uuid/commit/0e9321bf2a6df39ec28c1171616018680d0fc930))
* pin styled-components to ^6.3.8 to avoid @types/react@19 peer conflict ([f31165d](https://github.com/Schero94/strapi-auto-uuid/commit/f31165dd666878443b2b0a0c6ee165d8bc461e26))

## [1.0.2](https://github.com/Schero94/strapi-auto-uuid/compare/v1.0.1...v1.0.2) (2025-12-14)


### Bug Fixes

* add publishConfig access public for npm provenance ([76d1449](https://github.com/Schero94/strapi-auto-uuid/commit/76d144925864751d207865f45fa354ff15d84b40))

## [1.0.1](https://github.com/Schero94/strapi-auto-uuid/compare/v1.0.0...v1.0.1) (2025-12-14)


### Bug Fixes

* rename package to strapi-auto-uuid-v5 ([6b030db](https://github.com/Schero94/strapi-auto-uuid/commit/6b030dbdf2cb848a317ad01dc37201a065910ba7))

# 1.0.0 (2025-12-14)


### Features

* initial release for Strapi v5 ([f706f7e](https://github.com/Schero94/strapi-auto-uuid/commit/f706f7ea96a925a22b08debcce1321540dbf35db))
