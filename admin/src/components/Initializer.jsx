'use strict';

import { useEffect, useRef } from 'react';
import { PLUGIN_ID } from '../pluginId';

/**
 * Initializer Component
 * 
 * Required by Strapi plugin system to signal when the plugin is ready.
 */
export const Initializer = ({ setPlugin }) => {
  const ref = useRef(setPlugin);

  useEffect(() => {
    ref.current(PLUGIN_ID);
  }, []);

  return null;
};

export default Initializer;
