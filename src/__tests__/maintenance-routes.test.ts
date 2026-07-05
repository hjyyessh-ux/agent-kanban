import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { __resetKanbanDataDirCache } from '../core/data-dir';
import { createServer } from '../server/index';

async function withMaintenanceServer(callback: (baseUrl: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kanban-maintenance-'));
  const previousDataDir = process.env.KANBAN_DATA_DIR;
  const previousRepoRoot = process.env.KANBAN_REPO_ROOT;
  process.env.KANBAN_DATA_DIR = dataDir;
  process.env.KANBAN_REPO_ROOT = join(dataDir, 'missing-repo');
  __resetKanbanDataDirCache();

  const store = new KanbanStore(dataDir);
  const { stop, port } = createServer(store, 0);
  try {
    await callback(`http://localhost:${port}`);
  } finally {
    stop();
    if (previousDataDir === undefined) delete process.env.KANBAN_DATA_DIR;
    else process.env.KANBAN_DATA_DIR = previousDataDir;
    if (previousRepoRoot === undefined) delete process.env.KANBAN_REPO_ROOT;
    else process.env.KANBAN_REPO_ROOT = previousRepoRoot;
    __resetKanbanDataDirCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('maintenance routes', () => {
  test('reports idle status and empty log before a run starts', async () => {
    await withMaintenanceServer(async (baseUrl) => {
      const statusRes = await fetch(`${baseUrl}/api/maintenance/status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json() as { state: string; logPath: string };
      expect(status.state).toBe('idle');
      expect(status.logPath).toContain('maintenance-update.log');

      const logRes = await fetch(`${baseUrl}/api/maintenance/restart-log`);
      expect(logRes.status).toBe(200);
      const log = await logRes.json() as { log: string; logPath: string };
      expect(log.log).toBe('');
      expect(log.logPath).toContain('maintenance-update.log');
    });
  });

  test('does not start when repo scripts cannot be resolved', async () => {
    await withMaintenanceServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/maintenance/apply-update-restart`, {
        method: 'POST',
      });
      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Install script not found');
    });
  });
});
