import { describe, test, expect } from 'bun:test';
import { createRouteHandler } from '../server/routes';
import { KanbanStore } from '../core/store';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import type { CardRunProgress } from '../core/types';
import { withTempDir } from './setup';

function buildHandler(store: KanbanStore, runStore?: RuntimeRunStore) {
  return createRouteHandler(
    store,
    undefined, // dispatchFn
    undefined, // schedulerStore
    undefined, // schedulerEngine
    undefined, // settingsStore
    undefined, // onNetworkSettingChange
    undefined, // scriptStore
    undefined, // modelsFn
    undefined, // questionMonitor
    undefined, // aggregateSessionsFn
    undefined, // localPeerSessionsFn
    undefined, // peerTokenFn
    undefined, // runtimeCatalogFn
    undefined, // wikiWorker
    undefined, // skillStore
    undefined, // skillRootsStore
    undefined, // placementTargetsStore
    runStore,
  ).handleRequest;
}

describe('GET /api/cards/:id/progress', () => {
  test('serves the parsed step timeline of the card latest run', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });

      const run = await runStore.createRun({
        cardId: card.id,
        runtime: 'claude',
        cwd: dir,
      });
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'verify' } }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
        }),
      ];
      await Bun.write(run.eventsPath, `${lines.join('\n')}\n`);

      const handleRequest = buildHandler(store, runStore);
      const res = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(res.status).toBe(200);
      const progress = (await res.json()) as CardRunProgress;
      expect(progress.runId).toBe(run.runId);
      expect(progress.steps.map(s => s.kind)).toEqual(['skill', 'command']);
      expect(progress.summary.skills).toEqual(['verify']);
    });
  });

  test('404s when the card has no run or the run store is not wired', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });

      const noRun = await buildHandler(store, runStore)(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(noRun.status).toBe(404);

      const noStore = await buildHandler(store, undefined)(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(noStore.status).toBe(404);

      const noCard = await buildHandler(store, runStore)(
        new Request('http://localhost/api/cards/missing/progress'),
      );
      expect(noCard.status).toBe(404);
    });
  });
});
