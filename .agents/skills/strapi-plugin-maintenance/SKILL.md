---
name: strapi-plugin-maintenance
description: Maintain the Auto UUID Strapi 5 custom-field plugin with reproducible generation, schema safety, admin permissions and UI checks.
---

# Auto UUID maintenance

Use Node 22 and verify current Strapi 5 custom-field, document and plugin docs via Context7 before changing lifecycle hooks or field registration. Compare current compatible 5.x to the pinned workbench version. Do not store secrets in skills or Git and do not push without an explicit request.

Inspect `server/src/routes/admin-api.js`, `content-api.js`, bootstrap, custom field and settings. Map anonymous, unauthorised admin, allowed admin, owner and other-user outcomes for settings or batch operations. Require server-side permission and content-type ownership checks; client visibility is not authorization. Test UUID v4/v7 uniqueness, immutability, draft/publish behavior, duplicate/import paths, error handling and idempotent migration before changing persistence.

For UI changes, first read the workbench root skill's `references/ui-ux-standards.md`; it defines the shared responsive, alignment, readable-copy, accessibility and Playwright acceptance checks. Use Strapi 5 Design System and accessible settings controls; Playwright CLI checks field registration, keyboard use, validation and narrow layouts in the shared test app. Run `npm run build`, `npm run verify`, add focused tests for behavior changes, then shared app build/boot and negative-access checks. No upstream `npm test` script currently exists; do not call this a unit-test pass.

## Shared product quality contract

Use spec-first development: define acceptance criteria and API response/error contracts before implementation.

Follow the detailed JSDoc contract in the always-applied plugin rule for new and substantially changed exported or non-trivial functions, handlers, services, hooks, middleware, policies and components. Document purpose, context, applicable `@param` and `@returns`, and only actually propagated `@throws`. Verify HTTP `@route`, access, inputs and outcomes against the implementation; describe applicable mutations and security/privacy effects with `@sideeffect`. These are custom tags; respect configured tools, never invent behavior, and update comments when contracts change.

Every behavior change starts with a written current-state and target-state analysis covering screens, controls, routes, roles, data, known gaps and non-goals. Define acceptance criteria and API response/error contracts before implementation, then add a failing regression test first. A primary task should take no more than four meaningful user interactions from the plugin entry page; exclude login and mandatory security confirmations, and measure and document any justified exception. Use the Strapi Design System, responsive layouts, keyboard accessibility and explicit loading, empty, success and error states. Enforce authentication, plugin permissions, validation and owner boundaries server-side. Keep API error contracts consistent within each Strapi surface and never return stack traces or internal details. Do not log secrets, tokens, cookies, request bodies, email, IP or stable user/session identifiers. Use fakes for providers and record unverified behavior accurately.
