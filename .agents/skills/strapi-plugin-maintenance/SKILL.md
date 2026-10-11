---
name: strapi-plugin-maintenance
description: Maintain the Auto UUID Strapi 5 custom-field plugin with reproducible generation, schema safety, admin permissions and UI checks.
---

# Auto UUID maintenance

Use Node 22 and verify current Strapi 5 custom-field, document and plugin docs via Context7 before changing lifecycle hooks or field registration. Compare current compatible 5.x to the pinned workbench version. Do not store secrets in skills or Git and do not push without an explicit request.

Inspect `server/src/routes/admin-api.js`, `content-api.js`, bootstrap, custom field and settings. Map anonymous, unauthorised admin, allowed admin, owner and other-user outcomes for settings or batch operations. Require server-side permission and content-type ownership checks; client visibility is not authorization. Test UUID v4/v7 uniqueness, immutability, draft/publish behavior, duplicate/import paths, error handling and idempotent migration before changing persistence.

Use Strapi 5 Design System and accessible settings controls; Playwright CLI checks field registration, keyboard use, validation and narrow layouts in the shared test app. Run `npm run build`, `npm run verify`, add focused tests for behavior changes, then shared app build/boot and negative-access checks. No upstream `npm test` script currently exists; do not call this a unit-test pass.
