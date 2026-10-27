import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks work whose deletes are not a person's mass delete (the super admin
 * purge of a whole organization). Soft-deletes inside `withoutDeleteCounting`
 * are not counted towards `security.mass_delete`. Deletes behave exactly the
 * same either way; only the counting is skipped.
 */
const suppressed = new AsyncLocalStorage<true>();

export function withoutDeleteCounting<T>(fn: () => Promise<T>): Promise<T> {
  return suppressed.run(true, fn);
}

export function deleteCountingSuppressed(): boolean {
  return suppressed.getStore() === true;
}
