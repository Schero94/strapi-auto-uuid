import { PLUGIN_ID } from '../pluginId';

/**
 * Prefixes a translation key with the plugin id. Always call it with a string
 * literal so the i18n completeness test can find every key.
 *
 * @param {string} id Key inside admin/src/translations/*.json.
 * @returns {string} Fully qualified react-intl message id.
 */
export const getTranslation = (id) => `${PLUGIN_ID}.${id}`;
