/**
 * Loads the plugin's ESM source files (server/, shared/, tests/helpers/) as
 * ES modules when they run in plain Node.js. The package is `type:
 * commonjs` for its published CommonJS entry files, while the source is
 * written as ESM and bundled by @strapi/sdk-plugin; Vitest transforms it on
 * its own. Used with `node --import ./scripts/esm-source-hooks.mjs`.
 *
 * Uses the synchronous `module.registerHooks` API (Node.js >= 22.15):
 * https://nodejs.org/docs/latest-v22.x/api/module.html#moduleregisterhooksoptions
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url).href;
const sourceDirs = ['server/', 'shared/', 'tests/helpers/'].map((dir) => root + dir);

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('.js') && sourceDirs.some((dir) => url.startsWith(dir))) {
      return {
        ...result,
        format: 'module',
        source: result.source ?? readFileSync(fileURLToPath(url), 'utf8'),
      };
    }
    return result;
  },
});
