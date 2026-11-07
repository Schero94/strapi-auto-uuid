/**
 * Guard that lets only one UUID repair or import run at a time. Repairs scan
 * and rewrite whole tables; two overlapping runs could replay each other's
 * stale plans and lock the same rows in opposite order.
 *
 * Two gates:
 * 1. A process-local flag, checked first, so a second click on the same
 *    process is rejected without touching the database.
 * 2. A transaction-scoped database lock (see `cluster-lock.js`), taken as the
 *    first statement of the repair transaction, so a repair started on
 *    another replica or pm2 worker is rejected with the same error. The
 *    database releases it on commit, rollback or a lost connection.
 */
import { tryNamedLock } from './cluster-lock.js';

let activeOperation = null;

/** Raised when another repair or import is already running. */
export class RepairInProgressError extends Error {
  constructor() {
    super('Another UUID repair or import is already running. Try again when it has finished.');
    this.name = 'RepairInProgressError';
    this.code = 'REPAIR_IN_PROGRESS';
  }
}

/**
 * Runs `operation` while holding the process-local repair lock.
 *
 * @template T
 * @param {string} name Operation name, kept for diagnostics.
 * @param {() => Promise<T>} operation Repair work.
 * @returns {Promise<T>} The operation result.
 * @throws {RepairInProgressError} When another operation holds the lock.
 */
export async function runExclusiveRepair(name, operation) {
  if (activeOperation) throw new RepairInProgressError();
  activeOperation = name;
  try {
    return await operation();
  } finally {
    activeOperation = null;
  }
}

/**
 * Takes the cross-process repair lock for the open transaction. Call it as
 * the first statement inside the repair transaction.
 *
 * @param {Object} strapi Strapi instance.
 * @returns {Promise<void>}
 * @throws {RepairInProgressError} When another process runs a repair or import.
 */
export async function assertClusterRepairLock(strapi) {
  if (!(await tryNamedLock(strapi, 'repair'))) throw new RepairInProgressError();
}

/**
 * @returns {string|null} Name of the repair running in this process, or null.
 */
export const getActiveRepair = () => activeOperation;
