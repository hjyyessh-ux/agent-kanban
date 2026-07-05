import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../server/index';
import { KanbanStore } from '../core/store';
import { ScriptStore } from '../core/script-store';
import { withTempDir } from './setup';

async function withScriptServer(
  callback: (baseUrl: string, stores: { kanbanStore: KanbanStore; scriptStore: ScriptStore; dataDir: string }) => Promise<void>,
) {
  await withTempDir(async (dir) => {
    const kanbanStore = new KanbanStore(dir);
    const scriptStore = new ScriptStore(dir);
    const scriptsDir = scriptStore.scriptsDir;
    if (!scriptsDir) throw new Error('scriptsDir missing');
    mkdirSync(scriptsDir, { recursive: true });

    const port = 24700 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(
      kanbanStore,
      port,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scriptStore,
    );
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback(baseUrl, { kanbanStore, scriptStore, dataDir: dir });
    } finally {
      stop();
    }
  });
}

describe('script routes', () => {
  test('POST /api/scripts/sync reads runtime data-dir scripts folder', async () => {
    await withScriptServer(async (url, { scriptStore }) => {
      const scriptsDir = scriptStore.scriptsDir!;
      writeFileSync(join(scriptsDir, 'data-only.sh'), '#!/bin/bash\necho runtime');

      const res = await fetch(`${url}/api/scripts/sync`, { method: 'POST' });
      expect(res.status).toBe(200);

      const body = await res.json() as { created: number; updated: number; removed: number };
      expect(body.created).toBe(1);

      const entries = await scriptStore.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('data-only');
      expect(entries[0].description).toBe('Synced from data scripts/data-only.sh');
      expect(entries[0].content).toBe('#!/bin/bash\necho runtime');
    });
  });
});
