import { describe, expect, test } from 'bun:test';
import { formatUtcIsoToKstInput } from '../core/scheduling';
import { KanbanStore } from '../core/store';
import { SchedulerStore } from '../core/scheduler-store';
import { SchedulerEngine } from '../plugin/scheduler-engine';
import { createRouteHandler } from '../server/routes';
import { createServer } from '../server/index';
import { withTempDir } from './setup';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const AUTH_TOKEN = 'local-route-token';

const FUTURE_SCHEDULED_AT_UTC = (() => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
})();
const FUTURE_SCHEDULED_AT_KST_INPUT = formatUtcIsoToKstInput(FUTURE_SCHEDULED_AT_UTC);

describe('card schedule routes', () => {
  test('POST /api/cards stores a scheduled reservation atomically when scheduledDispatch is provided', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = createRouteHandler(store);

      const response = await handleRequest(
        new Request('http://localhost/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Create with schedule',
            description: 'Desc',
            scheduledDispatch: { scheduledAt: FUTURE_SCHEDULED_AT_UTC },
          }),
        }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        title: 'Create with schedule',
        status: 'todo',
        scheduledDispatch: {
          scheduledAt: FUTURE_SCHEDULED_AT_UTC,
          status: 'scheduled',
        },
      });
      expect(await store.getCards()).toHaveLength(1);
    });
  });

  test('POST /api/cards rejects past schedules and queue conflicts without persisting a card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = createRouteHandler(store);

      const past = await handleRequest(
        new Request('http://localhost/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Past create schedule',
            description: 'Desc',
            scheduledDispatch: { scheduledAt: '2026-07-16T23:59:00.000Z' },
          }),
        }),
      );
      expect(past.status).toBe(400);
      expect(await past.json()).toEqual({ error: 'scheduledDispatch.scheduledAt must be a future datetime' });

      const queueConflict = await handleRequest(
        new Request('http://localhost/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Conflicting create schedule',
            description: 'Desc',
            queueSessionMode: 'new_session',
            scheduledDispatch: { scheduledAt: FUTURE_SCHEDULED_AT_UTC },
          }),
        }),
      );
      expect(queueConflict.status).toBe(400);
      expect(await queueConflict.json()).toEqual({ error: 'Queued cards cannot also be scheduled' });

      expect(await store.getCards()).toHaveLength(0);
    });
  });

  test('PUT /api/cards/:id/schedule stores a future KST reservation and DELETE clears it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Schedule me', description: 'Desc' });
      const { handleRequest } = createRouteHandler(store);

      const putResponse = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: FUTURE_SCHEDULED_AT_KST_INPUT }),
        }),
      );

      expect(putResponse.status).toBe(200);
      expect(await putResponse.json()).toMatchObject({
        id: card.id,
        scheduledDispatch: {
          scheduledAt: FUTURE_SCHEDULED_AT_UTC,
          status: 'scheduled',
        },
      });

      const deleteResponse = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/schedule`, {
          method: 'DELETE',
        }),
      );

      expect(deleteResponse.status).toBe(200);
      const cleared = await deleteResponse.json() as { scheduledDispatch?: unknown };
      expect(cleared.scheduledDispatch).toBeUndefined();
    });
  });

  test('PUT /api/cards/:id/schedule rejects invalid and past KST times with { error }', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Bad schedule', description: 'Desc' });
      const { handleRequest } = createRouteHandler(store);

      const invalid = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: 'not-a-date' }),
        }),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Invalid KST datetime input: not-a-date' });

      const past = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: '2026-07-16T23:59' }),
        }),
      );
      expect(past.status).toBe(400);
      expect(await past.json()).toEqual({ error: 'scheduledAt must be a future KST datetime' });
    });
  });

  test('PUT /api/cards/:id/schedule rejects non-todo, child, and queued cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'Desc' });
      const inProgress = await store.createCard({ title: 'Busy', description: 'Desc' });
      const child = await store.createCard({ title: 'Child', description: 'Desc', parentCardId: parent.id });
      const queued = await store.createCard({ title: 'Queued', description: 'Desc' });
      await store.updateCard(inProgress.id, { status: 'in_progress' });
      await store.updateCard(queued.id, {
        queuedAfterCardId: parent.id,
        queuePosition: 1,
        queueSessionMode: 'new_session',
      });

      const { handleRequest } = createRouteHandler(store);
      const requestFor = (cardId: string) => handleRequest(
        new Request(`http://localhost/api/cards/${cardId}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: FUTURE_SCHEDULED_AT_KST_INPUT }),
        }),
      );

      const [inProgressResponse, childResponse, queuedResponse] = await Promise.all([
        requestFor(inProgress.id),
        requestFor(child.id),
        requestFor(queued.id),
      ]);

      expect(inProgressResponse.status).toBe(400);
      expect(await inProgressResponse.json()).toEqual({ error: `Only top-level todo cards can be scheduled: ${inProgress.id}` });
      expect(childResponse.status).toBe(400);
      expect(await childResponse.json()).toEqual({ error: `Only top-level todo cards can be scheduled: ${child.id}` });
      expect(queuedResponse.status).toBe(400);
      expect(await queuedResponse.json()).toEqual({ error: `Queued cards cannot also be scheduled: ${queued.id}` });
    });
  });

  test('POST /api/cards/:id/dispatch atomically consumes the reservation and rejects the race loser', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Race', description: 'Desc' });
      await store.scheduleCardDispatch(card.id, FUTURE_SCHEDULED_AT_UTC);
      const gate = createDeferred<void>();
      const dispatchStarted = createDeferred<void>();
      let attempts = 0;
      const { handleRequest } = createRouteHandler(
        store,
        async () => {
          attempts += 1;
          dispatchStarted.resolve();
          await gate.promise;
          return {
            sessionId: 'session-race',
            runId: 'run-race',
            startedAt: '2026-07-18T00:30:05.000Z',
          };
        },
      );

      const first = handleRequest(new Request(`http://localhost/api/cards/${card.id}/dispatch`, {
        method: 'POST',
      }));
      await dispatchStarted.promise;
      const second = await handleRequest(new Request(`http://localhost/api/cards/${card.id}/dispatch`, {
        method: 'POST',
      }));

      expect(second.status).toBe(409);
      const secondBody = await second.json() as { error: string };
      expect(secondBody.error).toBeTruthy();

      gate.resolve();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toEqual({
        sessionId: 'session-race',
        runId: 'run-race',
        startedAt: '2026-07-18T00:30:05.000Z',
      });
      expect(attempts).toBe(1);
      expect((await store.getCard(card.id))?.scheduledDispatch).toMatchObject({
        status: 'dispatched',
        dispatchedAt: '2026-07-18T00:30:05.000Z',
      });
    });
  });

  test('new schedule route keeps auth classification and same-origin protection', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Protected', description: 'Desc' });
      const { stop, port } = createServer(
        store,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => AUTH_TOKEN,
      );

      try {
        const baseUrl = `http://localhost:${port}`;
        const unauthorized = await fetch(`${baseUrl}/api/cards/${card.id}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: FUTURE_SCHEDULED_AT_KST_INPUT }),
        });
        expect(unauthorized.status).toBe(401);

        const crossOrigin = await fetch(`${baseUrl}/api/cards/${card.id}/schedule`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${AUTH_TOKEN}`,
            Origin: 'http://evil.example.com',
          },
          body: JSON.stringify({ scheduledAt: FUTURE_SCHEDULED_AT_KST_INPUT }),
        });
        expect(crossOrigin.status).toBe(403);
        expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin request rejected' });
      } finally {
        stop();
      }
    });
  });
});

describe('scheduler routes', () => {
  test('POST/PATCH /api/schedulers validate KST timezone and discriminated actions', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const schedulerStore = new SchedulerStore(dir);
      const schedulerEngine = new SchedulerEngine(schedulerStore);
      const { handleRequest } = createRouteHandler(store, undefined, schedulerStore, schedulerEngine);

      const invalidTimezone = await handleRequest(
        new Request('http://localhost/api/schedulers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad timezone',
            scheduleInput: { mode: 'cron', expression: '0 9 * * *' },
            timezone: 'UTC',
            action: { type: 'bash', command: 'echo hello' },
          }),
        }),
      );
      expect(invalidTimezone.status).toBe(400);
      expect(await invalidTimezone.json()).toEqual({ error: 'timezone must be Asia/Seoul' });

      const invalidPrompt = await handleRequest(
        new Request('http://localhost/api/schedulers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad prompt',
            scheduleInput: { mode: 'cron', expression: '0 9 * * *' },
            action: {
              type: 'prompt',
              prompt: 'Run this',
              projectDir: '   ',
              agentRuntime: 'invalid',
            },
          }),
        }),
      );
      expect(invalidPrompt.status).toBe(400);
      expect(await invalidPrompt.json()).toEqual({ error: 'prompt action has invalid agentRuntime' });

      const created = await handleRequest(
        new Request('http://localhost/api/schedulers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Valid scheduler',
            scheduleInput: { mode: 'cron', expression: '0 9 * * 1-5' },
            action: { type: 'bash', command: 'echo ok' },
          }),
        }),
      );
      expect(created.status).toBe(201);
      const createdEntry = await created.json() as { id: string; cron: string; scheduleInput: unknown };
      expect(createdEntry.cron).toBe('0 9 * * 1-5');
      expect(createdEntry.scheduleInput).toEqual({ mode: 'cron', expression: '0 9 * * 1-5' });

      const invalidPatch = await handleRequest(
        new Request(`http://localhost/api/schedulers/${createdEntry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: { type: 'bash', command: '   ' },
          }),
        }),
      );
      expect(invalidPatch.status).toBe(400);
      expect(await invalidPatch.json()).toEqual({ error: 'bash action requires a non-empty command' });

      const invalidRule = await handleRequest(
        new Request(`http://localhost/api/schedulers/${createdEntry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleInput: { mode: 'rule', text: '평일' },
          }),
        }),
      );
      expect(invalidRule.status).toBe(400);
      expect(await invalidRule.json()).toEqual({ error: 'scheduleInput shape is invalid' });

      const patched = await handleRequest(
        new Request(`http://localhost/api/schedulers/${createdEntry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleInput: {
              mode: 'simple',
              simple: { repeat: 'daily', hour: 9, minute: 30 },
            },
          }),
        }),
      );
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        cron: '30 9 * * *',
        cronDescription: '매일 09:30',
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'daily', hour: 9, minute: 30 },
        },
      });
    });
  });

  test('POST /api/schedulers/:id/run returns prompt card linkage and persists dispatched state in history', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const schedulerStore = new SchedulerStore(dir);
      const schedulerEngine = new SchedulerEngine(schedulerStore, {
        cardStore: store,
        dispatchFn: async () => ({
          sessionId: 'thread-123',
          runId: 'runtime-run-123',
          startedAt: '2026-07-18T00:31:00.000Z',
        }),
        generateId: () => 'scheduler-run-123',
      });
      const entry = await schedulerStore.createEntry({
        name: 'Prompt run',
        description: 'Desc',
        cron: '0 9 * * *',
        action: {
          type: 'prompt',
          prompt: 'Open the daily board',
          projectDir: dir,
          agentRuntime: 'codex',
          model: 'gpt-5',
        },
      });
      const { handleRequest } = createRouteHandler(store, undefined, schedulerStore, schedulerEngine);

      const response = await handleRequest(
        new Request(`http://localhost/api/schedulers/${entry.id}/run`, {
          method: 'POST',
        }),
      );

      expect(response.status).toBe(200);
      const run = await response.json() as {
        id: string;
        cardId?: string;
        dispatched?: boolean;
        dispatchAcceptedAt?: string;
      };
      expect(run).toMatchObject({
        id: 'scheduler-run-123',
        dispatched: true,
        dispatchAcceptedAt: '2026-07-18T00:31:00.000Z',
      });
      expect(run.cardId).toBeTruthy();

      const history = await schedulerStore.getHistory(entry.id);
      expect(history[0]).toMatchObject({
        id: 'scheduler-run-123',
        cardId: run.cardId,
        dispatched: true,
        dispatchAcceptedAt: '2026-07-18T00:31:00.000Z',
      });
    });
  });

  test('scheduler mutations keep auth classification', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const schedulerStore = new SchedulerStore(dir);
      const schedulerEngine = new SchedulerEngine(schedulerStore);
      const { stop, port } = createServer(
        store,
        0,
        undefined,
        undefined,
        schedulerStore,
        schedulerEngine,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => AUTH_TOKEN,
      );

      try {
        const baseUrl = `http://localhost:${port}`;
        const unauthorized = await fetch(`${baseUrl}/api/schedulers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Protected scheduler',
            cron: '0 9 * * *',
            action: { type: 'bash', command: 'echo hi' },
          }),
        });
        expect(unauthorized.status).toBe(401);
      } finally {
        stop();
      }
    });
  });
});
