import { statSync } from 'node:fs';

/**
 * Optional hook a JSON store calls around its own atomic write, under its own
 * lock. Implementations must never throw into the store and never write the
 * store's file; the JSON file stays the primary record.
 */
export interface JsonSaveObserver<T> {
  isActive(): boolean;
  /** Before the rename. `identity` is the file as found on disk. */
  prepare(identity: string): void;
  /** After the rename. `identity` is the file just written. */
  commit(items: readonly T[], identity: string): void;
  /** Without writing JSON: observe whatever is on disk now. */
  reconcile(items: readonly T[], identity: string): void;
}

/** Cheap identity of a JSON file: every atomic rename creates a new inode. */
export function fileIdentity(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${Math.trunc(s.mtimeMs)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Runs an observer step; a fault is the observer's to report, never the store's. */
export function observeSafely(step: () => void): void {
  try { step(); } catch { /* observer reports its own failures */ }
}
