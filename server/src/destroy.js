/**
 * Plugin destroy hook. Lifecycle subscriptions are released by Strapi when
 * the database connection closes, so there is nothing to clean up.
 *
 * @returns {void}
 */
const destroy = () => {};

export default destroy;
