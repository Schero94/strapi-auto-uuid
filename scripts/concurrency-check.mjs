#!/usr/bin/env node
/**
 * Multi-process concurrency check: starts N Node processes (default 8, like
 * 2 Railway replicas x 4 pm2 workers) against ONE database and lets them
 * race the plugin's critical paths at the same moment:
 *
 * - unique-create: all create a document with the same client-supplied UUID.
 *   Expected: exactly one succeeds, the others get DUPLICATE_UUID.
 * - write-once: all fill the same empty, non-editable UUID field with their
 *   own value. Expected: exactly one succeeds, the others get IMMUTABLE_UUID,
 *   and the stored value is the winner's.
 * - repair: all start a full repair. Expected: the fixes are counted exactly
 *   once in total (no double reporting), the others answer
 *   REPAIR_IN_PROGRESS or find nothing left to fix, and no duplicate or empty
 *   value remains.
 * - rate-limit: all send requests for one admin user to a route with
 *   max=10/min. Expected: exactly 10 requests pass across all processes.
 *
 * Usage:
 *   node scripts/concurrency-check.mjs                      # SQLite file
 *   AUTO_UUID_PG_URL=postgres://user@127.0.0.1:5432/db \
 *     node scripts/concurrency-check.mjs --client postgres   # PostgreSQL
 *   Options: --workers 8
 *
 * SQLite allows one writer per file and is not a supported multi-process
 * setup; there the check only asserts that no duplicate is stored and no
 * fix is counted twice (losers may also fail with SQLITE_BUSY). The rate-limit
 * scenario runs on PostgreSQL only.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createSqliteHost } from '../tests/helpers/sqlite-strapi.js';

const { values: args } = parseArgs({
  options: {
    client: { type: 'string', default: process.env.AUTO_UUID_PG_URL ? 'postgres' : 'sqlite' },
    workers: { type: 'string', default: '8' },
  },
});
const CLIENT = args.client;
const WORKERS = Number(args.workers);
const here = dirname(fileURLToPath(import.meta.url));

if (CLIENT === 'postgres' && !process.env.AUTO_UUID_PG_URL) {
  console.error('Set AUTO_UUID_PG_URL to run the PostgreSQL check.');
  process.exit(2);
}

/**
 * Runs one scenario in WORKERS processes and returns their results.
 *
 * @param {Object} host Creator host (owns the database).
 * @param {string} scenario Scenario name.
 * @param {Object} payload Scenario input.
 * @returns {Promise<Array<Object>>} Worker results.
 */
async function race(host, scenario, payload) {
  const children = [];
  const ready = [];
  const results = [];
  for (let worker = 0; worker < WORKERS; worker += 1) {
    const child = fork(join(here, 'concurrency-worker.mjs'), [], {
      env: {
        ...process.env,
        CLIENT,
        SCHEMA: host.schema,
        FILENAME: host.filename,
        SCENARIO: scenario,
        WORKER: String(worker),
        PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    ready.push(
      new Promise((resolve, reject) => {
        child.on('message', (message) => {
          if (message.type === 'ready') resolve();
          if (message.type === 'result') results.push(message);
        });
        child.on('exit', (code) => code !== 0 && reject(new Error(`worker exit ${code}`)));
      })
    );
  }
  await Promise.all(ready);
  const exited = children.map((child) => new Promise((resolve) => child.on('exit', resolve)));
  for (const child of children) child.send({ type: 'go' });
  await Promise.all(exited);
  return results.sort((a, b) => a.worker - b.worker);
}

const failures = [];
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!condition) failures.push(name);
};
const codes = (results) =>
  results.reduce((acc, { result }) => {
    const key = result.ok ? 'ok' : result.code;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const strict = CLIENT !== 'sqlite';
console.log(`Concurrency check: ${WORKERS} processes on ${CLIENT}`);

const newHost = () => createSqliteHost({ client: CLIENT });

// 1. Same client-supplied value from every process.
{
  const host = await newHost();
  const value = randomUUID();
  const results = await race(host, 'unique-create', { value, delayMs: 150 });
  const stored = (await host.rows()).filter((row) => row.editableId === value);
  const winners = results.filter(({ result }) => result.ok).length;
  check('unique-create: one value stored once', stored.length <= 1, `stored=${stored.length}`);
  check(
    'unique-create: exactly one winner',
    strict ? winners === 1 : winners <= 1,
    JSON.stringify(codes(results))
  );
  if (strict) {
    check(
      'unique-create: losers get DUPLICATE_UUID',
      results.every(({ result }) => result.ok || result.code === 'DUPLICATE_UUID')
    );
  }
  await host.close();
}

// 2. Write-once field filled concurrently.
{
  const host = await newHost();
  await host.insertRaw([{ documentId: 'doc-write-once', publicId: null }]);
  const [{ id }] = await host.rows();
  const values = Array.from({ length: WORKERS }, () => randomUUID());
  const results = await race(host, 'write-once', { id, values, delayMs: 150 });
  const [row] = await host.rows();
  const winners = results.filter(({ result }) => result.ok);
  check(
    'write-once: exactly one winner',
    strict ? winners.length === 1 : winners.length <= 1,
    JSON.stringify(codes(results))
  );
  if (winners.length === 1) {
    check('write-once: stored value is the winner', row.publicId === winners[0].result.value);
  }
  if (strict) {
    check(
      'write-once: losers get IMMUTABLE_UUID',
      results.every(({ result }) => result.ok || result.code === 'IMMUTABLE_UUID')
    );
  }
  await host.close();
}

// 3. Repair started on every process at once.
{
  const host = await newHost();
  const shared = randomUUID();
  const seed = [];
  for (let i = 0; i < 40; i += 1) seed.push({ documentId: `doc-empty-${i}`, publicId: null });
  for (let i = 0; i < 5; i += 1) seed.push({ documentId: `doc-dup-${i}`, publicId: shared });
  await host.insertRaw(seed);
  // 40 empty units + 4 duplicates (the oldest keeps the value), per field
  // publicId; editableId is empty on all 45 documents.
  const expected = 40 + 4 + 45;
  const results = await race(host, 'repair', { repairDelayMs: 20 });
  const total = results.reduce((sum, { result }) => sum + (result.fixed || 0), 0);
  const rows = await host.rows();
  const publicIds = rows.map((row) => row.publicId);
  check(
    'repair: fixes counted once in total',
    strict ? total === expected : total <= expected,
    `total=${total} expected=${expected} ${JSON.stringify(codes(results))}`
  );
  if (strict) {
    check(
      'repair: concurrent runs are rejected across processes',
      results.some(({ result }) => result.code === 'REPAIR_IN_PROGRESS')
    );
    check('repair: no empty value left', publicIds.every(Boolean));
    check('repair: no duplicate left', new Set(publicIds).size === publicIds.length);
    check(
      'repair: others answer REPAIR_IN_PROGRESS or find nothing',
      results.every(
        ({ result }) =>
          (result.ok && (result.fixed === expected || result.fixed === 0)) ||
          result.code === 'REPAIR_IN_PROGRESS'
      )
    );
  }
  await host.close();
}

// 4. Shared rate limit.
if (strict) {
  const host = await newHost();
  const results = await race(host, 'rate-limit', {
    max: 10,
    requests: 5,
    config: { rateLimitStore: 'database' },
  });
  const allowed = results.reduce((sum, { result }) => sum + (result.allowed || 0), 0);
  const fallback = results.some(({ warnings }) =>
    warnings.some((text) => text.includes('Rate-limit'))
  );
  check('rate-limit: shared counter allows exactly max', allowed === 10, `allowed=${allowed}`);
  check('rate-limit: no fallback to per-process counters', !fallback);
  await host.close();
} else {
  console.log('SKIP rate-limit: SQLite uses per-process counters by default');
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('All concurrency checks passed');
