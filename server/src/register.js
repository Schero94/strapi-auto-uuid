/**
 * Register Custom Field for UUID
 *
 * Registers the 'uuid' custom field type for Content-Type Builder.
 * The field type is 'string' (not 'uid' which is for slugs).
 * Uniqueness is enforced via lifecycle hooks in bootstrap.js.
 *
 * @see https://docs.strapi.io/cms/features/custom-fields
 */
const register = ({ strapi }) => {
  strapi.customFields.register({
    name: 'uuid',
    plugin: 'field-uuid',
    type: 'string', // String is correct for UUIDs (uid is for slugs with targetField)
    inputSize: {
      default: 12,
      isResizable: true,
    },
  });
  
  strapi.log.info('[strapi-auto-uuid] Custom field registered');
};

export default register;
