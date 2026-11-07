/**
 * Checks the built bundles after `strapi-plugin build`:
 * - @strapi/utils stays external, so the plugin's ValidationError is the
 *   class Strapi's error middleware checks (400 instead of 500);
 * - the Design System and icons stay external (no second copy in the admin);
 * - the CommonJS server entry loads and exposes the plugin hooks.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const server = readFileSync('dist/server/index.js', 'utf8');
check(server.includes('require("@strapi/utils")'), 'server bundle must require @strapi/utils');
check(!/class ApplicationError/.test(server), 'server bundle must not inline @strapi/utils');
check(!server.includes('child_process'), 'server bundle must not contain child_process');

const adminFiles = readdirSync('dist/admin').filter((file) => /\.(m?js)$/.test(file));
let largest = 0;
for (const file of adminFiles) {
  const path = join('dist/admin', file);
  largest = Math.max(largest, statSync(path).size);
}
const adminSource = adminFiles
  .map((file) => readFileSync(join('dist/admin', file), 'utf8'))
  .join('\n');
check(
  /["']@strapi\/design-system["']/.test(adminSource),
  'admin bundle must import @strapi/design-system'
);
check(/["']@strapi\/icons["']/.test(adminSource), 'admin bundle must import @strapi/icons');
check(
  largest < 300 * 1024,
  `largest admin chunk is ${Math.round(largest / 1024)} kB (limit 300 kB)`
);

const plugin = require(join(process.cwd(), 'dist/server/index.js'));
const exported = plugin.default ?? plugin;
for (const key of ['register', 'bootstrap', 'routes', 'services', 'controllers', 'config']) {
  check(Boolean(exported[key]), `server entry must export ${key}`);
}

if (failures.length > 0) {
  console.error(`Bundle verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `Bundle verification passed (${adminFiles.length} admin files, largest ${Math.round(largest / 1024)} kB).`
);
