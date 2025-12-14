'use strict';

/**
 * strapi-auto-uuid - Admin Entry Point
 * 
 * Registers the UUID custom field and settings page in the Strapi admin panel.
 * This allows the field to be used in Content-Type Builder and provides
 * management tools for UUID maintenance.
 * 
 * @see https://docs.strapi.io/cms/features/custom-fields
 */
import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';

/**
 * Prefix translation keys with pluginId
 * @param {Object} data - Translation data
 * @param {string} pluginId - Plugin identifier
 * @returns {Object} Prefixed translations
 */
const prefixPluginTranslations = (data, pluginId) => {
  const prefixed = {};
  Object.keys(data).forEach((key) => {
    prefixed[`${pluginId}.${key}`] = data[key];
  });
  return prefixed;
};

export default {
  /**
   * Register the plugin, custom field, and settings section
   * @param {Object} app - Strapi admin app instance
   */
  register(app) {
    // Register the plugin
    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });

    // Register the UUID Custom Field
    app.customFields.register({
      name: 'uuid',
      pluginId: PLUGIN_ID,
      type: 'string',
      
      intlLabel: {
        id: `${PLUGIN_ID}.form.label`,
        defaultMessage: 'UUID',
      },
      
      intlDescription: {
        id: `${PLUGIN_ID}.form.description`,
        defaultMessage: 'Automatically generates UUID v4',
      },
      
      icon: PluginIcon,
      
      components: {
        Input: async () =>
          import('./components/Input').then((module) => ({
            default: module.default,
          })),
      },
      
      options: {
        base: [
          {
            sectionTitle: {
              id: `${PLUGIN_ID}.field.options.uuid`,
              defaultMessage: 'UUID Options',
            },
            items: [
              {
                name: 'options.uuid-version',
                type: 'select',
                intlLabel: {
                  id: `${PLUGIN_ID}.field.options.version`,
                  defaultMessage: 'UUID Version',
                },
                description: {
                  id: `${PLUGIN_ID}.field.options.version.description`,
                  defaultMessage: 'v4 is random, v7 is time-sortable (recommended for new projects)',
                },
                options: [
                  { value: 'v4', label: 'UUID v4 (Random)' },
                  { value: 'v7', label: 'UUID v7 (Time-sortable)' },
                ],
                defaultValue: 'v4',
              },
              {
                name: 'options.uuid-prefix',
                type: 'text',
                intlLabel: {
                  id: `${PLUGIN_ID}.field.options.prefix`,
                  defaultMessage: 'Prefix (optional)',
                },
                description: {
                  id: `${PLUGIN_ID}.field.options.prefix.description`,
                  defaultMessage: 'Add a prefix to all UUIDs (e.g., "usr_" for user IDs)',
                },
              },
            ],
          },
        ],
        advanced: [
          {
            sectionTitle: {
              id: 'global.settings',
              defaultMessage: 'Settings',
            },
            items: [
              {
                name: 'private',
                type: 'checkbox',
                intlLabel: {
                  id: `${PLUGIN_ID}.settings.private`,
                  defaultMessage: 'Private field',
                },
                description: {
                  id: `${PLUGIN_ID}.settings.private.description`,
                  defaultMessage: 'This field will not show up in the API response',
                },
              },
              {
                name: 'options.disable-auto-generate',
                type: 'checkbox',
                intlLabel: {
                  id: `${PLUGIN_ID}.field.options.disableAutoGenerate`,
                  defaultMessage: 'Disable auto-generation',
                },
                description: {
                  id: `${PLUGIN_ID}.field.options.disableAutoGenerate.description`,
                  defaultMessage: 'Do not auto-generate UUID on create (must be provided manually)',
                },
              },
              {
                name: 'options.allow-edit',
                type: 'checkbox',
                intlLabel: {
                  id: `${PLUGIN_ID}.field.options.allowEdit`,
                  defaultMessage: 'Allow manual editing',
                },
                description: {
                  id: `${PLUGIN_ID}.field.options.allowEdit.description`,
                  defaultMessage: 'Allow users to manually edit the UUID value',
                },
              },
            ],
          },
        ],
        validator: () => ({}),
      },
    });

    // Add Settings section under /admin/settings/field-uuid
    app.createSettingSection(
      {
        id: PLUGIN_ID,
        intlLabel: { 
          id: `${PLUGIN_ID}.settings.section`, 
          defaultMessage: 'Auto UUID' 
        },
      },
      [
        {
          intlLabel: {
            id: `${PLUGIN_ID}.settings.management`,
            defaultMessage: 'UUID Management',
          },
          id: 'management',
          to: `${PLUGIN_ID}/management`,
          Component: () => import('./pages/SettingsPage'),
        },
      ]
    );

    console.log(`[${PLUGIN_ID}] Custom field registered in admin panel`);
  },

  /**
   * Bootstrap the plugin after all registrations
   * @param {Object} app - Strapi admin app instance
   */
  async bootstrap(app) {
    console.log(`[${PLUGIN_ID}] Plugin bootstrapped`);
  },

  /**
   * Register translations for i18n support
   * @param {Object} params - Locale information
   * @returns {Promise<Array>} Translated data for each locale
   */
  async registerTrads({ locales }) {
    const importedTrads = await Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data: prefixPluginTranslations(data, PLUGIN_ID), locale };
        } catch {
          try {
            const { default: data } = await import('./translations/en.json');
            return { data: prefixPluginTranslations(data, PLUGIN_ID), locale };
          } catch {
            return { data: {}, locale };
          }
        }
      })
    );

    return importedTrads;
  },
};
