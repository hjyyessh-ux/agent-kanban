import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { withTempDir } from './setup';

describe('PlacementTargetsStore', () => {
  test('seeds Claude/Codex user and cold builtin targets on first load', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      const targets = await store.getTargets();
      expect(targets.length).toBeGreaterThanOrEqual(3);
      const user = targets.find((t) => t.kind === 'user' && t.runtime === 'claude');
      const codexUser = targets.find((t) => t.kind === 'user' && t.runtime === 'codex');
      const cold = targets.find((t) => t.kind === 'cold');
      expect(user).toBeDefined();
      expect(user?.builtin).toBe(true);
      expect(codexUser?.builtin).toBe(true);
      expect(cold).toBeDefined();
      expect(cold?.builtin).toBe(true);
    });
  });

  test('builtin targets have correct labels', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      const targets = await store.getTargets();
      expect(targets.find((t) => t.label === 'Global (user)')).toBeDefined();
      expect(targets.find((t) => t.label === 'Codex Global (user)')).toBeDefined();
      expect(targets.find((t) => t.label === 'Cold Storage')).toBeDefined();
    });
  });

  test('addTarget persists a new target', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      const added = await store.addTarget({
        label: 'My Project',
        dir: '/tmp/my-project',
        kind: 'local',
        teamShared: false,
      });
      expect(added.id).toBeTruthy();
      expect(added.label).toBe('My Project');
      expect(added.dir).toBe('/tmp/my-project');
      expect(added.kind).toBe('local');
      expect(added.builtin).toBeUndefined();

      const targets = await store.getTargets();
      expect(targets.find((t) => t.id === added.id)).toBeDefined();
    });
  });

  test('addTarget rejects duplicate dir', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      await store.addTarget({ label: 'A', dir: '/tmp/dedupe-test', kind: 'local', teamShared: false });
      let err: Error | undefined;
      try {
        await store.addTarget({ label: 'B', dir: '/tmp/dedupe-test', kind: 'project', teamShared: true });
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/already exists/i);
    });
  });

  test('removeTarget deletes a non-builtin target', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      const added = await store.addTarget({
        label: 'To Remove',
        dir: '/tmp/to-remove',
        kind: 'local',
        teamShared: false,
      });
      await store.removeTarget(added.id);
      const targets = await store.getTargets();
      expect(targets.find((t) => t.id === added.id)).toBeUndefined();
    });
  });

  test('removeTarget throws for unknown id', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      let err: Error | undefined;
      try {
        await store.removeTarget('nonexistent-id');
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/not found/i);
    });
  });

  test('removeTarget rejects builtin targets', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      const targets = await store.getTargets();
      const builtin = targets.find((t) => t.builtin);
      expect(builtin).toBeDefined();
      let err: Error | undefined;
      try {
        await store.removeTarget(builtin!.id);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/builtin/i);
    });
  });

  test('builtins are re-seeded if missing from persisted state', async () => {
    await withTempDir(async (dir) => {
      const store1 = new PlacementTargetsStore(dir);
      // Add a custom target to create the file
      await store1.addTarget({ label: 'X', dir: '/tmp/x', kind: 'local', teamShared: false });

      // Manually corrupt: remove builtins from saved JSON
      const { join } = await import('node:path');
      const targetsPath = join(dir, 'placement-targets.json');
      const raw = JSON.parse(await Bun.file(targetsPath).text());
      raw.targets = raw.targets.filter((t: { builtin?: boolean }) => !t.builtin);
      await Bun.write(targetsPath, JSON.stringify(raw));

      // Load again — builtins must be re-seeded
      const store2 = new PlacementTargetsStore(dir);
      const targets = await store2.getTargets();
      expect(targets.find((t) => t.kind === 'user')).toBeDefined();
      expect(targets.find((t) => t.kind === 'cold')).toBeDefined();
    });
  });

  test('persists state across store instances', async () => {
    await withTempDir(async (dir) => {
      const store1 = new PlacementTargetsStore(dir);
      const added = await store1.addTarget({
        label: 'Persist Me',
        dir: '/tmp/persist-me',
        kind: 'project',
        teamShared: true,
      });

      const store2 = new PlacementTargetsStore(dir);
      const targets = await store2.getTargets();
      const found = targets.find((t) => t.id === added.id);
      expect(found).toBeDefined();
      expect(found?.label).toBe('Persist Me');
      expect(found?.teamShared).toBe(true);
    });
  });

  test('migrates legacy targets without runtime to Claude without dropping entries', async () => {
    await withTempDir(async (dir) => {
      const legacy = {
        version: 1,
        targets: [{
          id: 'legacy-target',
          label: 'Legacy',
          dir: '/tmp/legacy-target',
          kind: 'project',
          teamShared: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        lastModified: '2026-01-01T00:00:00.000Z',
      };
      await Bun.write(join(dir, 'placement-targets.json'), JSON.stringify(legacy));

      const targets = await new PlacementTargetsStore(dir).getTargets();
      const migrated = targets.find((target) => target.id === 'legacy-target');
      expect(migrated?.runtime).toBe('claude');
      expect(migrated?.dir).toBe('/tmp/legacy-target');
    });
  });

  test('allows the same directory for different runtimes', async () => {
    await withTempDir(async (dir) => {
      const store = new PlacementTargetsStore(dir);
      await store.addTarget({
        label: 'Claude Repo',
        dir: '/tmp/shared-runtime-dir',
        kind: 'project',
        teamShared: true,
        runtime: 'claude',
      });
      await store.addTarget({
        label: 'Codex Repo',
        dir: '/tmp/shared-runtime-dir',
        kind: 'project',
        teamShared: true,
        runtime: 'codex',
      });
      const matching = (await store.getTargets())
        .filter((target) => target.dir === '/tmp/shared-runtime-dir');
      expect(matching.map((target) => target.runtime).sort()).toEqual(['claude', 'codex']);
    });
  });
});
