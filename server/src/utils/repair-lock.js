/**
 * Process-wide guard that lets only one UUID repair or import run at a time.
 * Repairs scan and rewrite whole tables; two overlapping runs could replay
 * each other's stale plans. The guard is per Node.js process: deployments
 * with several Strapi replicas must still avoid starting repairs on two
 * replicas at the same moment.
 */

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
 * Runs `operation` while holding the repair lock.
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
 * @returns {string|null} Name of the running repair, or null.
 */
export const getActiveRepair = () => activeOperation;
