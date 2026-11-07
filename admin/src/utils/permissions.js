/**
 * RBAC permissions of the plugin, as checked by the admin routes. The admin
 * UI only uses them for visibility; the server enforces them on every route.
 */
export const PERMISSIONS = Object.freeze({
  read: [{ action: 'plugin::field-uuid.read', subject: null }],
  migrate: [{ action: 'plugin::field-uuid.migrate', subject: null }],
  export: [{ action: 'plugin::field-uuid.export', subject: null }],
  import: [{ action: 'plugin::field-uuid.import', subject: null }],
});

/** All four permissions, for `useRBAC` (yields canRead, canMigrate, canExport, canImport). */
export const ALL_PERMISSIONS = Object.freeze([
  ...PERMISSIONS.read,
  ...PERMISSIONS.migrate,
  ...PERMISSIONS.export,
  ...PERMISSIONS.import,
]);
