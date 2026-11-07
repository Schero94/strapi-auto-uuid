/**
 * Worker process of `scripts/concurrency-check.mjs`. Attaches to the shared
 * test database, runs the plugin bootstrap (so several workers also race the
 * table preparation), waits for the parent's "go" and runs one scenario.
 * Results are sent back over IPC. Synthetic data only.
 */
import { createSqliteHost, UID } from '../tests/helpers/sqlite-strapi.js';
import rateLimit from '../server/src/middlewares/rate-limit.js';

const { CLIENT, SCHEMA, FILENAME, SCENARIO, WORKER, PAYLOAD } = process.env;
const payload = JSON.parse(PAYLOAD || '{}');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error) =>
  error?.details?.code || error?.code || error?.name || String(error?.message || error);

const host = await createSqliteHost({
  client: CLIENT,
  schema: SCHEMA,
  filename: FILENAME,
  attach: true,
  config: payload.config ?? {},
});

// Widens the race window between the plugin's checks and the write, the way
// a slow request or a busy database would. Subscribed after the plugin, so it
// runs after the plugin's beforeCreate/beforeUpdate hooks.
host.db.lifecycles.subscribe({
  models: [UID],
  async beforeCreate() {
    await sleep(payload.delayMs ?? 0);
  },
  async beforeUpdate() {
    await sleep(payload.delayMs ?? 0);
  },
  async beforeUpdateMany() {
    await sleep(payload.repairDelayMs ?? 0);
  },
});

const scenarios = {
  /** Every worker creates a document with the same client-supplied value. */
  async 'unique-create'() {
    try {
      await host.inTransaction(() =>
        host.db.query(UID).create({
          data: { title: `worker ${WORKER}`, locale: 'en', editableId: payload.value },
        })
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  },

  /** Every worker fills the same empty write-once field with its own value. */
  async 'write-once'() {
    try {
      await host.inTransaction(() =>
        host.db.query(UID).update({
          where: { id: payload.id },
          data: { publicId: payload.values[Number(WORKER)] },
        })
      );
      return { ok: true, value: payload.values[Number(WORKER)] };
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  },

  /** Every worker starts a full repair at the same moment. */
  async repair() {
    try {
      const result = await host.services.migrations.runMigration({ dryRun: false });
      return {
        ok: !result.failed,
        fixed: result.totalFixed,
        skipped: result.skipped,
        code: result.failed ? 'REPAIR_FAILED' : undefined,
      };
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  },

  /** Every worker sends requests for the same admin user to a limited route. */
  async 'rate-limit'() {
    const limit = rateLimit({ max: payload.max, window: 60_000 }, { strapi: host.strapi });
    let allowed = 0;
    let limited = 0;
    for (let i = 0; i < payload.requests; i += 1) {
      const ctx = {
        path: '/field-uuid/migration/run',
        state: { user: { id: 1 } },
        request: {},
        set: () => {},
      };
      let passed = false;
      await limit(ctx, async () => {
        passed = true;
      });
      if (passed) allowed += 1;
      else limited += 1;
    }
    return { ok: true, allowed, limited };
  },
};

process.send({ type: 'ready' });
process.on('message', async (message) => {
  if (message?.type !== 'go') return;
  let result;
  try {
    result = await scenarios[SCENARIO]();
  } catch (error) {
    result = { ok: false, code: errorCode(error) };
  }
  const warnings = host.logs.filter(([level]) => level === 'warn').map(([, text]) => text);
  await host.close();
  process.send({ type: 'result', worker: Number(WORKER), result, warnings });
  process.exit(0);
});
