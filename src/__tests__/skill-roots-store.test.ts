import { describe, test, expect } from 'bun:test';
import { SkillRootsStore } from '../core/skill-roots-store';
import { withTempDir } from './setup';

describe('SkillRootsStore', () => {
  test('returns default roots on first load', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      const roots = await store.getRoots();
      expect(roots.length).toBeGreaterThan(0);
      expect(roots.every((r) => r.id && r.dir && r.agent && r.source)).toBe(true);
      expect(roots.every((r) => typeof r.enabled === 'boolean')).toBe(true);
    });
  });

  test('default roots include claude, codex, and opencode agents', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      const roots = await store.getRoots();
      const agents = roots.map((r) => r.agent);
      expect(agents).toContain('claude');
      expect(agents).toContain('codex');
      expect(agents).toContain('opencode');
    });
  });

  test('addRoot persists a new root', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      const added = await store.addRoot({
        dir: '/custom/skills',
        agent: 'claude',
        source: 'custom-user',
        enabled: true,
      });
      expect(added.id).toBeTruthy();
      expect(added.dir).toBe('/custom/skills');
      expect(added.agent).toBe('claude');

      const roots = await store.getRoots();
      expect(roots.find((r) => r.id === added.id)).toBeDefined();
    });
  });

  test('removeRoot deletes the specified root', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      const added = await store.addRoot({
        dir: '/to/remove',
        agent: 'codex',
        source: 'test',
        enabled: true,
      });
      await store.removeRoot(added.id);
      const roots = await store.getRoots();
      expect(roots.find((r) => r.id === added.id)).toBeUndefined();
    });
  });

  test('removeRoot throws for unknown id', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      let err: Error | undefined;
      try { await store.removeRoot('nonexistent-id'); } catch (e) { err = e as Error; }
      expect(err?.message).toContain('not found');
    });
  });

  test('updateRoot patches enabled flag', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      const added = await store.addRoot({
        dir: '/toggle',
        agent: 'opencode',
        source: 'toggle-test',
        enabled: true,
      });
      const updated = await store.updateRoot(added.id, { enabled: false });
      expect(updated.enabled).toBe(false);
      expect(updated.dir).toBe('/toggle');

      const roots = await store.getRoots();
      expect(roots.find((r) => r.id === added.id)?.enabled).toBe(false);
    });
  });

  test('updateRoot throws for unknown id', async () => {
    await withTempDir(async (dir) => {
      const store = new SkillRootsStore(dir);
      let err: Error | undefined;
      try { await store.updateRoot('bad-id', { enabled: false }); } catch (e) { err = e as Error; }
      expect(err?.message).toContain('not found');
    });
  });

  test('persists state across store instances (same dir)', async () => {
    await withTempDir(async (dir) => {
      const store1 = new SkillRootsStore(dir);
      const added = await store1.addRoot({
        dir: '/persist/me',
        agent: 'claude',
        source: 'persist-test',
        enabled: false,
      });

      const store2 = new SkillRootsStore(dir);
      const roots = await store2.getRoots();
      const found = roots.find((r) => r.id === added.id);
      expect(found).toBeDefined();
      expect(found?.dir).toBe('/persist/me');
      expect(found?.enabled).toBe(false);
    });
  });
});
