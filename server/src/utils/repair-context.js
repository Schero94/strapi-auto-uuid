import { AsyncLocalStorage } from 'node:async_hooks';

const uuidRepairContext = new AsyncLocalStorage();

/**
 * Runs an internal, explicitly requested UUID repair in an isolated async
 * context. Database lifecycle hooks use this marker to permit maintenance
 * replacements while keeping ordinary UUID edits immutable.
 *
 * @template T
 * @param {() => Promise<T>|T} operation Repair operation to execute.
 * @returns {Promise<T>|T} The operation result.
 */
export function withUuidRepairContext(operation) {
  return uuidRepairContext.run(true, operation);
}

/**
 * Reports whether the current asynchronous call chain is executing an
 * internal UUID repair.
 *
 * @returns {boolean} True only inside `withUuidRepairContext`.
 */
export function isUuidRepairContext() {
  return uuidRepairContext.getStore() === true;
}
