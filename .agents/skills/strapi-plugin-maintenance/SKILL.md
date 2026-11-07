---
name: strapi-plugin-maintenance
description: Maintain the Auto UUID Strapi 5 custom-field plugin with reproducible generation, schema safety, admin permissions and UI checks.
---

# Auto UUID maintenance

Use Node 22 and verify current Strapi 5 custom-field, document and plugin docs via Context7 before changing lifecycle hooks or field registration. Compare current compatible 5.x to the pinned workbench version. Do not store secrets in skills or Git and do not push without an explicit request.

Inspect `server/src/routes/admin-api.js`, `content-api.js`, bootstrap, custom field and settings. Map anonymous, unauthorised admin, allowed admin, owner and other-user outcomes for settings or batch operations. Require server-side permission and content-type ownership checks; client visibility is not authorization. Test UUID v4/v7 uniqueness, immutability, draft/publish behavior, duplicate/import paths, error handling and idempotent migration before changing persistence.

For UI changes, load the workbench skills `strapi-admin-ui-ux`, `strapi-design-system`, `strapi-styled-components` and `strapi-browser-acceptance` (by name; they live in the workbench, not in this repository). Use Strapi 5 Design System components and theme tokens; Playwright CLI checks field registration, keyboard use, validation and narrow layouts on an isolated host.

Gates before every commit: `npm run lint` (ESLint 10 flat config), `npm run format:check` (Prettier), `npm test` (Vitest: unit tests plus `tests/sqlite-*.test.js`, which boot `@strapi/database` on a temporary SQLite file and drive the lifecycle hooks and repairs the way the Document Service does), `npm run build` (includes `scripts/verify-bundle.mjs`, which fails if `@strapi/utils` or the Design System get bundled) and `npm run verify`. Lifecycle lookups must use `strapi.db.query()`, never a raw knex connection: on SQLite the pool holds one connection that the open transaction owns. Keep `yup` at Strapi's exact version (Content-Type Builder validator contract).

## Shared product quality contract

Use spec-first development: define acceptance criteria and API response/error contracts before implementation.

Follow the detailed JSDoc contract in the always-applied plugin rule for new and substantially changed exported or non-trivial functions, handlers, services, hooks, middleware, policies and components. Document purpose, context, applicable `@param` and `@returns`, and only actually propagated `@throws`. Verify HTTP `@route`, access, inputs and outcomes against the implementation; describe applicable mutations and security/privacy effects with `@sideeffect`. These are custom tags; respect configured tools, never invent behavior, and update comments when contracts change.

Every behavior change starts with a written current-state and target-state analysis covering screens, controls, routes, roles, data, known gaps and non-goals. Define acceptance criteria and API response/error contracts before implementation, then add a failing regression test first. A primary task should take no more than four meaningful user interactions from the plugin entry page; exclude login and mandatory security confirmations, and measure and document any justified exception. Use the Strapi Design System, responsive layouts, keyboard accessibility and explicit loading, empty, success and error states. Enforce authentication, plugin permissions, validation and owner boundaries server-side. Keep API error contracts consistent within each Strapi surface and never return stack traces or internal details. Do not log secrets, tokens, cookies, request bodies, email, IP or stable user/session identifiers. Use fakes for providers and record unverified behavior accurately.
