/**
 * CI contract: the workflow tests what package.json promises. Every Node major
 * in engines.node runs in the matrix, the peer floor of @strapi/strapi has its
 * own job, and main is checked on push so the README badge shows main.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

test('the Node matrix covers every even Node major in engines.node', () => {
  const [, low, high] = pkg.engines.node.match(/>=\s*(\d+)\S*\s+<=\s*(\d+)/) || [];
  assert.ok(low && high, `cannot read engines.node "${pkg.engines.node}"`);
  const matrix = (ci.match(/node:\s*\[([^\]]*)\]/) || [])[1] || '';
  const tested = new Set(matrix.match(/\d+/g));
  const missing = [];
  for (let major = Number(low); major <= Number(high); major += 1) {
    if (major % 2 === 0 && !tested.has(String(major))) missing.push(major);
  }
  assert.deepEqual(missing, []);
});

test('a CI job installs the @strapi/strapi peer floor', () => {
  // The job may use a later patch of the floor's minor version when npm has
  // deprecated the first patches, but never a later minor.
  const floor = pkg.peerDependencies['@strapi/strapi'].replace(/^[\^~]/, '').split('.');
  const job = ((ci.match(/STRAPI_FLOOR:\s*([\d.]+)/) || [])[1] || '').split('.');
  assert.deepEqual(job.slice(0, 2), floor.slice(0, 2));
  assert.ok(Number(job[2]) >= Number(floor[2]), `job ${job.join('.')} below floor`);
  assert.match(ci, /"@strapi\/strapi@\$STRAPI_FLOOR"/);
});

test('CI runs on push to main', () => {
  assert.match(ci, /^ {2}push:\n {4}branches:\n {6}- main$/m);
});
