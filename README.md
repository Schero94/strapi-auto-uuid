# Strapi Auto UUID

[![NPM Version](https://img.shields.io/npm/v/strapi-auto-uuid-v5.svg)](https://www.npmjs.com/package/strapi-auto-uuid-v5)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Strapi v5](https://img.shields.io/badge/Strapi-v5-blue.svg)](https://strapi.io)

> 🔄 **This is the official Strapi v5 continuation of [Cringe-Studio/strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid)**
> 
> The original plugin only supports Strapi v4. This fork provides full Strapi v5 compatibility with new features and improvements.

A powerful UUID custom field plugin for Strapi v5 that automatically generates and manages UUID v4/v7 values for your content types.

## Features

- **Auto-generation**: Automatically generates UUID on entry creation
- **UUID v4 & v7 Support**: Choose between random (v4) or time-sortable (v7) UUIDs
- **Uniqueness Validation**: Prevents duplicate UUIDs across entries
- **Copy to Clipboard**: One-click copy button in the admin panel
- **Admin Panel Management**: Diagnose, auto-fix, and generate missing UUIDs
- **Migration Support**: Built-in tools to migrate from older versions
- **Export/Import**: Backup and restore UUID mappings
- **Configurable**: Extensive configuration options via `config/plugins.js`
- **Per-field Options**: Configure UUID version and prefix per field

## Installation

```bash
npm install strapi-auto-uuid-v5
# or
yarn add strapi-auto-uuid-v5
```

## Quick Start

1. **Enable the plugin** in `config/plugins.js`:

```javascript
module.exports = {
  'field-uuid': {
    enabled: true,
    config: {
      // Optional configuration (see Configuration section)
    },
  },
};
```

2. **Add the UUID field** to your content type via Content-Type Builder:
   - Go to Content-Type Builder
   - Select your content type
   - Click "Add another field"
   - Choose "UUID" from Custom fields

3. **That's it!** UUIDs will be automatically generated for new entries.

## Configuration

Configure the plugin in `config/plugins.js`:

```javascript
module.exports = {
  'field-uuid': {
    enabled: true,
    config: {
      // UUID version: 'v4' (random) or 'v7' (time-sortable)
      defaultVersion: 'v4',
      
      // Auto-generate UUIDs on create (default: true)
      autoGenerate: true,
      
      // Validate uniqueness before save (default: true)
      validateUniqueness: true,
      
      // Allow manual UUID editing in admin panel (default: false)
      allowManualEdit: false,
      
      // Maximum retry attempts for UUID collision (default: 3)
      maxRetryAttempts: 3,
      
      // Run auto-migration on bootstrap (default: false)
      // Warning: This modifies data on server start
      autoMigrate: false,
      
      // Log level: 'debug', 'info', 'warn', 'error' (default: 'info')
      logLevel: 'info',
    },
  },
};
```

### Per-field Configuration

When adding a UUID field in Content-Type Builder, you can configure:

| Option | Description |
|--------|-------------|
| UUID Version | `v4` (random) or `v7` (time-sortable) |
| Prefix | Optional prefix for all UUIDs (e.g., `usr_`) |
| Disable auto-generation | Require manual UUID input |
| Allow manual editing | Let users edit the UUID value |
| Private | Hide field from API responses |

## UUID Versions

### UUID v4 (Random)
- Completely random identifiers
- No ordering properties
- Best for: General purpose unique identifiers

### UUID v7 (Time-sortable)
- Time-based with millisecond precision
- Naturally sortable by creation time
- Best for: Database indexes, chronological ordering

Example:
```
v4: 550e8400-e29b-41d4-a716-446655440000
v7: 018f6b3c-8e2d-7f00-8000-000000000000
```

## Admin Panel

Access UUID management at: **Settings > Auto UUID > UUID Management**

### Features

1. **Dashboard**: Overview of content types with UUID fields
2. **Diagnosis**: Scan for duplicates, empty fields, and invalid UUIDs
3. **Auto-Fix**: Automatically replace duplicate UUIDs
4. **Generate Missing**: Create UUIDs for empty fields
5. **Export/Import**: Backup and restore UUID mappings

## API Endpoints

All endpoints require admin authentication.

### Check Duplicate
```
POST /api/field-uuid/check-duplicate
Body: { contentType, field, uuid, excludeDocumentId? }
```

### Diagnose
```
GET /api/field-uuid/diagnose
```

### Auto-Fix
```
POST /api/field-uuid/autofix
Body: { dryRun: boolean }
```

### Generate Missing
```
POST /api/field-uuid/generate-missing
Body: { dryRun: boolean }
```

### Get Models
```
GET /api/field-uuid/models
```

### Migration Status
```
GET /api/field-uuid/migration/status
```

### Run Migration
```
POST /api/field-uuid/migration/run
Body: { dryRun: boolean, fixEmpty: boolean, fixInvalid: boolean, fixDuplicates: boolean }
```

### Export Mappings
```
GET /api/field-uuid/migration/export
```

### Import Mappings
```
POST /api/field-uuid/migration/import
Body: { mappings: object, dryRun: boolean, overwrite: boolean }
```

### Statistics
```
GET /api/field-uuid/stats
```

## Migration Guide

### From strapi-auto-uuid v4 (Strapi 4) to v5 (Strapi 5)

The v5 version includes breaking changes to support Strapi 5. Here's how to migrate:

#### 1. Update your plugin configuration

Change from:
```javascript
// Old (Strapi 4)
module.exports = {
  'strapi-auto-uuid': {
    enabled: true,
  },
};
```

To:
```javascript
// New (Strapi 5)
module.exports = {
  'field-uuid': {
    enabled: true,
  },
};
```

#### 2. Check migration status

After upgrading, go to **Settings > Auto UUID > UUID Management** and click "Run Diagnosis" to check for any issues.

#### 3. Fix any issues

If duplicates or invalid UUIDs are found:
1. Use the "Auto-Fix Duplicates" feature with "Dry Run" first
2. Review the changes
3. Run without dry run to apply fixes

### Data Safety

- **UUIDs are preserved**: The underlying data type change from `uid` to `string` does not affect existing UUID values
- **Backup recommended**: Always backup your database before running migrations
- **Dry run available**: All migration operations support dry run mode

## Troubleshooting

### UUID field not appearing in Content-Type Builder

Ensure the plugin is properly enabled:
1. Check `config/plugins.js` has `'field-uuid': { enabled: true }`
2. Restart Strapi: `npm run develop`

### "Custom Field not found" error

This usually means the plugin name in `config/plugins.js` doesn't match. Use `'field-uuid'` (not `'strapi-auto-uuid'`).

### Duplicate UUIDs after migration

Run the diagnostic tool:
1. Go to Settings > Auto UUID > UUID Management
2. Click "Run Diagnosis"
3. Use "Auto-Fix Duplicates" to resolve

### Performance concerns with large datasets

For large datasets:
- Set `validateUniqueness: false` in config (if uniqueness is ensured elsewhere)
- Use database-level unique constraints
- Consider using UUID v7 for better index performance

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit PRs.

## License

MIT License - see LICENSE file for details.

## Support

- GitHub Issues: [Report bugs](https://github.com/Schero94/strapi-auto-uuid/issues)
- Documentation: [Full docs](https://github.com/Schero94/strapi-auto-uuid#readme)

## Credits

This plugin is a Strapi v5 continuation of the original [strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid) by [Cringe Studio](https://github.com/Cringe-Studio). Thanks for the great foundation!

## Changelog

### v2.0.0 (Strapi v5)
- 🚀 **Complete rewrite for Strapi v5**
- ✨ Added UUID v7 support (time-sortable)
- 🎨 New admin panel with management tools
- 🔄 Migration support from Strapi v4
- 📦 Export/Import functionality
- ⚙️ Per-field configuration options
- 📋 Copy to clipboard button
- 🔧 Improved uniqueness validation

### Previous versions (Strapi v4)
See [Cringe-Studio/strapi-auto-uuid](https://github.com/Cringe-Studio/strapi-auto-uuid) for Strapi v4 releases.
