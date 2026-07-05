import { describe, expect, mock, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { dispatchNextQueuedTodoCard } from '../plugin/hooks/event-handler';
import { withTempDir } from './setup';

describe('dispatchNextQueuedTodoCard', () => {
  test('skips failed todo cards and dispatches the next healthy queued card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const completed = await store.createCard({ title: 'Done', description: 'Done' });
      const failed = await store.createCard({ title: 'Failed', description: 'Failed' });
      const healthy = await store.createCard({ title: 'Healthy', description: 'Healthy' });

      await store.updateCard(failed.id, {
        queuedAfterCardId: completed.id,
        queuePosition: 1,
        progressSummary: '[failed] previous runtime failure',
      });
      await store.updateCard(healthy.id, {
        queuedAfterCardId: completed.id,
        queuePosition: 2,
      });

      const dispatchFn = mock(async (cardId: string) => ({
        sessionId: `ses-${cardId}`,
        runId: `run-${cardId}`,
        startedAt: new Date().toISOString(),
      }));

      await dispatchNextQueuedTodoCard(store, completed.id, dispatchFn);

      expect(dispatchFn).toHaveBeenCalledTimes(1);
      expect(dispatchFn).toHaveBeenCalledWith(healthy.id);
    });
  });
});
