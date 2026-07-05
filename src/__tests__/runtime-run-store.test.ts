import { describe, expect, test } from 'bun:test';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';

describe('RuntimeRunStore', () => {
  test('creates run directories and reconciles stale active runs', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do work',
        agentRuntime: 'codex',
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'thread-old' });

      const run = await runStore.createRun({
        cardId: card.id,
        runtime: 'codex',
        model: 'gpt-5.3-codex',
        cwd: dir,
      });
      await runStore.updateRun(run.runId, {
        status: 'running',
        pid: 12345,
        sessionId: 'thread-old',
      });

      const reconciled = await runStore.reconcileStale(store);
      expect(reconciled).toHaveLength(1);

      const updatedRun = await runStore.getRun(run.runId);
      expect(updatedRun?.status).toBe('failed');
      expect(updatedRun?.finishedAt).toBeTruthy();

      const updatedCard = await store.getCard(card.id);
      expect(updatedCard?.status).toBe('todo');
      expect(updatedCard?.progressSummary).toStartWith('[reconciled]');
    });
  });
});
