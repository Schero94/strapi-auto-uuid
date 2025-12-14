'use strict';

/**
 * Register Custom Field for UUID
 * 
 * This registers the 'uuid' custom field type that can be used
 * in Content-Type Builder. The field type is 'string' which is
 * correct for UUID values. The 'uid' type is designed for slugs
 * with targetField and is not appropriate for UUIDs.
 * 
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
