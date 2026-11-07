/**
 * strapi-auto-uuid admin entry: registers the UUID custom field for the
 * Content-Type Builder and Content Manager, and the "UUID management"
 * settings page.
 *
 * @see https://docs.strapi.io/cms/features/custom-fields
 * @see https://docs.strapi.io/cms/plugins-development/admin-panel-api
 */
// The Content-Type Builder merges `options.validator` into its own yup 0.32
// object schema, so it must return yup schemas (Strapi custom-field contract).
// yup is pinned to the exact version Strapi 5 uses; zod cannot be used here.
import * as yup from 'yup';
import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';
import { getTranslation } from './utils/getTranslation';
import { PERMISSIONS } from './utils/permissions';
import { SUPPORTED_UUID_VERSIONS, UUID_PREFIX_PATTERN } from '../../shared/uuid-field.js';

/**
 * Prefixes translation keys with the plugin id.
 *
 * @param {Record<string, string>} data Translation catalogue.
 * @returns {Record<string, string>} Prefixed catalogue.
 */
const prefixPluginTranslations = (data) =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [`${PLUGIN_ID}.${key}`, value]));

/**
 * Returns the yup schemas the Content-Type Builder uses to validate the
 * field options. Error messages are translation ids: the builder passes the
 * message to `formatMessage` as the id.
 *
 * @returns {Record<string, import('yup').AnySchema>} Option schemas.
 */
export const uuidOptionsValidator = () => ({
  'uuid-version': yup
    .string()
    .oneOf([...SUPPORTED_UUID_VERSIONS])
    .default('v4'),
  'uuid-prefix': yup
    .string()
    .max(16, getTranslation('field.options.prefix.error'))
    .matches(UUID_PREFIX_PATTERN, {
      excludeEmptyString: true,
      message: getTranslation('field.options.prefix.error'),
    })
    .nullable()
    .notRequired(),
  'disable-auto-generate': yup.boolean().notRequired(),
  'allow-edit': yup.boolean().notRequired(),
});

export default {
  /**
   * Registers the plugin, the custom field and the settings link.
   *
   * @param {Object} app Strapi admin application.
   */
  register(app) {
    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });

    app.customFields.register({
      name: 'uuid',
      pluginId: PLUGIN_ID,
      type: 'string',
      intlLabel: { id: getTranslation('form.label'), defaultMessage: 'UUID' },
      intlDescription: {
        id: getTranslation('form.description'),
        defaultMessage: 'Generates a UUID v4 or v7 for each entry',
      },
      icon: PluginIcon,
      components: {
        Input: async () =>
          import('./components/Input').then((module) => ({ default: module.default })),
      },
      options: {
        base: [
          {
            sectionTitle: {
              id: getTranslation('field.options.uuid'),
              defaultMessage: 'UUID options',
            },
            items: [
              {
                name: 'options.uuid-version',
                type: 'select',
                intlLabel: {
                  id: getTranslation('field.options.version'),
                  defaultMessage: 'UUID version',
                },
                description: {
                  id: getTranslation('field.options.version.description'),
                  defaultMessage:
                    'v4 is random. v7 is time-sortable and recommended for new fields. Changing the version later keeps existing values.',
                },
                options: [
                  {
                    key: 'v4',
                    value: 'v4',
                    metadatas: {
                      intlLabel: {
                        id: getTranslation('field.options.version.v4'),
                        defaultMessage: 'UUID v4 (random)',
                      },
                    },
                  },
                  {
                    key: 'v7',
                    value: 'v7',
                    metadatas: {
                      intlLabel: {
                        id: getTranslation('field.options.version.v7'),
                        defaultMessage: 'UUID v7 (time-sortable)',
                      },
                    },
                  },
                ],
                defaultValue: 'v4',
              },
              {
                name: 'options.uuid-prefix',
                type: 'text',
                intlLabel: {
                  id: getTranslation('field.options.prefix'),
                  defaultMessage: 'Prefix (optional)',
                },
                description: {
                  id: getTranslation('field.options.prefix.description'),
                  defaultMessage:
                    'Up to 16 letters, numbers, underscores or hyphens added before every UUID, for example usr_',
                },
              },
            ],
          },
        ],
        advanced: [
          {
            sectionTitle: { id: 'global.settings', defaultMessage: 'Settings' },
            items: [
              {
                name: 'unique',
                type: 'checkbox',
                intlLabel: {
                  id: getTranslation('field.options.unique'),
                  defaultMessage: 'Unique values',
                },
                description: {
                  id: getTranslation('field.options.unique.description'),
                  defaultMessage:
                    'Strapi also checks uniqueness when an entry is published. This is not a database constraint; the plugin rejects duplicates on every save.',
                },
                defaultValue: true,
              },
              {
                name: 'private',
                type: 'checkbox',
                intlLabel: {
                  id: getTranslation('field.options.private'),
                  defaultMessage: 'Private field',
                },
                description: {
                  id: getTranslation('field.options.private.description'),
                  defaultMessage: 'The field is not returned by the API',
                },
              },
              {
                name: 'options.disable-auto-generate',
                type: 'checkbox',
                intlLabel: {
                  id: getTranslation('field.options.disableAutoGenerate'),
                  defaultMessage: 'Disable auto-generation',
                },
                description: {
                  id: getTranslation('field.options.disableAutoGenerate.description'),
                  defaultMessage:
                    'Editors enter the UUID themselves. Without manual editing it can be entered once and is then locked.',
                },
              },
              {
                name: 'options.allow-edit',
                type: 'checkbox',
                intlLabel: {
                  id: getTranslation('field.options.allowEdit'),
                  defaultMessage: 'Allow manual editing',
                },
                description: {
                  id: getTranslation('field.options.allowEdit.description'),
                  defaultMessage:
                    'Editors and API clients can set and change the UUID. When off, the server generates it and it cannot be changed.',
                },
              },
            ],
          },
        ],
        validator: uuidOptionsValidator,
      },
    });

    app.addSettingsLink(
      {
        id: PLUGIN_ID,
        intlLabel: { id: getTranslation('settings.section'), defaultMessage: 'Auto UUID' },
      },
      {
        id: 'management',
        to: `${PLUGIN_ID}/management`,
        intlLabel: {
          id: getTranslation('settings.management'),
          defaultMessage: 'UUID management',
        },
        Component: () => import('./pages/SettingsPage'),
        permissions: PERMISSIONS.read,
      }
    );
  },

  /**
   * Loads the plugin translations for the admin locales. Unknown locales
   * fall back to English.
   *
   * @param {{ locales: string[] }} params Admin locales.
   * @returns {Promise<Array<{ data: Record<string, string>, locale: string }>>}
   */
  async registerTrads({ locales }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data: prefixPluginTranslations(data), locale };
        } catch {
          const { default: data } = await import('./translations/en.json');
          return { data: prefixPluginTranslations(data), locale };
        }
      })
    );
  },
};
