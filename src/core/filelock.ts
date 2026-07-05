import { openSync, closeSync, readFileSync, unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface FileLockOptions {
  staleMs?: number;
  retryMs?: number;
  maxRetries?: number;
}

interface LockContent {
  pid: number;
  ts: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_MAX_RETRIES = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockContent(lockPath: string): LockContent | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    return JSON.parse(raw) as LockContent;
  } catch {
    return null;
  }
}

function isLockStale(content: LockContent, staleMs: number): boolean {
  if (Date.now() - content.ts > staleMs) return true;
  if (!isPidAlive(content.pid)) return true;
  return false;
}

export class FileLock {
  private readonly lockPath: string;
  private readonly staleMs: number;
  private readonly retryMs: number;
  private readonly maxRetries: number;
  private held = false;

  constructor(lockPath: string, options?: FileLockOptions) {
    this.lockPath = lockPath;
    this.staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
    this.retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private ensureParentDir(): void {
    const parentDir = dirname(this.lockPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
  }

  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    this.ensureParentDir();
    const lockData = JSON.stringify({ pid: process.pid, ts: Date.now() });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeFileSync(fd, lockData);
        closeSync(fd);
        this.held = true;
        return true;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;

        const content = readLockContent(this.lockPath);
        if (content && isLockStale(content, this.staleMs)) {
          try {
            unlinkSync(this.lockPath);
          } catch {
          }
          continue;
        }

        if (attempt < this.maxRetries) {
          await sleep(this.retryMs);
          continue;
        }
      }
    }

    return false;
  }

  async acquire(): Promise<void> {
    const acquired = await this.tryAcquire();
    if (!acquired) {
      throw new Error(`FileLock: failed to acquire lock after ${this.maxRetries} retries: ${this.lockPath}`);
    }
  }

  refresh(): boolean {
    if (!this.held) return false;

    try {
      const content = readLockContent(this.lockPath);
      if (!content || content.pid !== process.pid) {
        this.held = false;
        return false;
      }

      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (!this.held) return;

    try {
      const content = readLockContent(this.lockPath);
      if (content && content.pid === process.pid) {
        unlinkSync(this.lockPath);
      }
    } catch {
    } finally {
      this.held = false;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
