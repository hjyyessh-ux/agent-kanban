import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { createRouteHandler } from '../server/routes';
import { RuntimeDispatchError } from '../plugin/runtimes/types';
import { withTempDir } from './setup';

describe('dispatch route', () => {
  test('responds with sessionId, runId, and startedAt', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Dispatch me', description: 'Dispatch me' });
      const { handleRequest } = createRouteHandler(
        store,
        async () => ({
          sessionId: 'ses-dispatch',
          runId: 'run-dispatch',
          startedAt: '2026-05-26T00:00:00.000Z',
        }),
      );

      const response = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/dispatch`, {
          method: 'POST',
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sessionId: 'ses-dispatch',
        runId: 'run-dispatch',
        startedAt: '2026-05-26T00:00:00.000Z',
      });
    });
  });

  test('preserves runtime dispatch status codes such as thread_id timeout 504', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Codex timeout',
        description: 'Codex timeout',
        agentRuntime: 'codex',
      });
      const { handleRequest } = createRouteHandler(
        store,
        async () => {
          throw new RuntimeDispatchError('Codex thread_id timeout after 50ms', 504);
        },
      );

      const response = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/dispatch`, {
          method: 'POST',
        })
      );
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: 'Codex thread_id timeout after 50ms',
      });
    });
  });
});
