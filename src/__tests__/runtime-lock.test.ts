import { describe, test, expect } from 'bun:test';
import { RuntimeLock } from '../plugin/runtime-lock';
import { withTempDir } from './setup';

describe('RuntimeLock', () => {
  test('only one instance acquires the runtime lock at a time', async () => {
    await withTempDir(async (dir) => {
      const lock1 = new RuntimeLock(dir, 'singleton-runtime');
      const lock2 = new RuntimeLock(dir, 'singleton-runtime');

      expect(await lock1.acquire()).toBe(true);
      expect(lock1.isOwner()).toBe(true);

      expect(await lock2.acquire()).toBe(false);
      expect(lock2.isOwner()).toBe(false);

      lock1.release();
      expect(lock1.isOwner()).toBe(false);

      expect(await lock2.acquire()).toBe(true);
      expect(lock2.isOwner()).toBe(true);

      lock2.release();
    });
  });
});
