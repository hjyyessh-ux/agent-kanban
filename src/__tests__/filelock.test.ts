import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { FileLock } from '../core/filelock';
import { withTempDir } from './setup';

describe('FileLock', () => {
  test('acquire creates lock file with pid and timestamp', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      await lock.acquire();
      expect(existsSync(lockPath)).toBe(true);
      const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(typeof content.ts).toBe('number');
      lock.release();
    });
  });

  test('release removes lock file', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      await lock.acquire();
      expect(existsSync(lockPath)).toBe(true);
      lock.release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('release is no-op when not holding lock', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      // Should not throw
      lock.release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('withLock executes function and releases', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      let executed = false;
      await lock.withLock(async () => {
        executed = true;
        expect(existsSync(lockPath)).toBe(true);
      });
      expect(executed).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('withLock releases even if function throws', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      try {
        await lock.withLock(async () => {
          throw new Error('Test error');
        });
      } catch (e: unknown) {
        expect((e as Error).message).toBe('Test error');
      }
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('withLock returns function result', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);
      const result = await lock.withLock(async () => 42);
      expect(result).toBe(42);
    });
  });

  test('second acquire waits for first release', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock1 = new FileLock(lockPath, { retryMs: 10, maxRetries: 50 });
      const lock2 = new FileLock(lockPath, { retryMs: 10, maxRetries: 50 });

      await lock1.acquire();
      const order: string[] = [];

      const p2 = (async () => {
        await lock2.acquire();
        order.push('acquired-2');
        lock2.release();
      })();

      // Give lock2 a chance to start waiting
      await new Promise(r => setTimeout(r, 50));
      order.push('releasing-1');
      lock1.release();

      await p2;
      expect(order).toEqual(['releasing-1', 'acquired-2']);
    });
  });

  test('stale lock is reclaimed', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      // Write a stale lock file (old timestamp, fake PID)
      const staleLock = JSON.stringify({ pid: 999999, ts: Date.now() - 60_000 });
      await Bun.write(lockPath, staleLock);

      const lock = new FileLock(lockPath, { staleMs: 30_000 });
      await lock.acquire();
      expect(existsSync(lockPath)).toBe(true);
      const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      lock.release();
    });
  });

  test('tryAcquire returns false when lock is held by active process', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock1 = new FileLock(lockPath, { retryMs: 0, maxRetries: 0, staleMs: 60_000 });
      const lock2 = new FileLock(lockPath, { retryMs: 0, maxRetries: 0, staleMs: 60_000 });

      await lock1.acquire();
      expect(await lock2.tryAcquire()).toBe(false);

      lock1.release();
    });
  });

  test('refresh updates timestamp while holding lock', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      const lock = new FileLock(lockPath);

      await lock.acquire();
      const before = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; ts: number };

      await new Promise((resolve) => setTimeout(resolve, 10));
      lock.refresh();

      const after = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; ts: number };
      expect(after.pid).toBe(process.pid);
      expect(after.ts).toBeGreaterThan(before.ts);

      lock.release();
    });
  });

  test('throws after max retries exceeded', async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, 'test.lock');
      // Write a lock file held by current process's PID (not stale)
      const activeLock = JSON.stringify({ pid: process.pid, ts: Date.now() });
      await Bun.write(lockPath, activeLock);

      const lock = new FileLock(lockPath, { retryMs: 5, maxRetries: 3, staleMs: 60_000 });
      // This should fail because current PID is alive and lock is fresh
      // But wait — it's checking isPidAlive with our OWN pid, so it won't think it's stale
      // We need a different FileLock instance (separate held state)
      try {
        await lock.acquire();
        expect(true).toBe(false); // Should not reach here
      } catch (e: unknown) {
        expect((e as Error).message).toContain('failed to acquire lock');
      }
    });
  });
});
