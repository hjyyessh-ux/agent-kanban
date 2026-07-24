import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { createKanbanApp } from '../plugin/bootstrap';
import {
  dispatchCardWithScheduledReservation,
  ScheduledDispatchService,
} from '../plugin/scheduled-dispatch-service';
import { withTempDir } from './setup';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createManualTimer() {
  const callbacks = new Set<() => void>();
  const handles = new Map<object, () => void>();
  return {
    timer: {
      setInterval(fn: () => void) {
        callbacks.add(fn);
        const handle = { unref() {} };
        handles.set(handle, fn);
        return handle;
      },
      clearInterval(handle: object) {
        const fn = handles.get(handle);
        if (!fn) return;
        callbacks.delete(fn);
        handles.delete(handle);
      },
    },
    fireAll() {
      for (const callback of [...callbacks]) {
        callback();
      }
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function shutdownApp(app: Awaited<ReturnType<typeof createKanbanApp>>): Promise<void> {
  app.peerSessionCoordinator.markDraining();
  app.unsubscribeRuntimeLock();
  app.stopSingleton();
  app.questionMonitor?.stop();
  app.runtimeLock.release();
  app.monitor.stop();
  app.peerSessionCoordinator.unregister();
}

describe('ScheduledDispatchService', () => {
  test('dispatches due cards immediately but leaves future cards scheduled', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const due = await store.createCard({ title: 'Due', description: 'Dispatch now' });
      const future = await store.createCard({ title: 'Future', description: 'Not yet' });
      await store.scheduleCardDispatch(due.id, '2026-07-17T00:00:00.000Z');
      await store.scheduleCardDispatch(future.id, '2026-07-17T01:00:00.000Z');

      const timer = createManualTimer();
      const dispatched: string[] = [];
      const service = new ScheduledDispatchService({
        store,
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          return { sessionId: `session-${cardId}`, runId: `run-${cardId}`, startedAt: '2026-07-17T00:00:10.000Z' };
        },
        now: () => new Date('2026-07-17T00:00:05.000Z'),
        timer: timer.timer,
      });

      await service.start();

      expect(dispatched).toEqual([due.id]);
      expect((await store.getCard(due.id))?.scheduledDispatch?.status).toBe('dispatched');
      expect((await store.getCard(future.id))?.scheduledDispatch?.status).toBe('scheduled');

      service.stop();
    });
  });

  test('recovers stale dispatching claims on restart and dispatches overdue cards once', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Recover me', description: 'Dispatch after restart' });
      await store.scheduleCardDispatch(card.id, '2026-07-17T00:00:00.000Z');
      await store.claimScheduledDispatch(card.id, '2026-07-17T00:00:01.000Z');

      const dispatched: string[] = [];
      const service = new ScheduledDispatchService({
        store,
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          return { sessionId: 'session-1', runId: 'run-1', startedAt: '2026-07-17T00:01:00.000Z' };
        },
        now: () => new Date('2026-07-17T00:01:00.000Z'),
        staleClaimMs: 30_000,
        timer: createManualTimer().timer,
      });

      await service.start();

      expect(dispatched).toEqual([card.id]);
      const updated = await store.getCard(card.id);
      expect(updated?.scheduledDispatch).toMatchObject({
        status: 'dispatched',
        dispatchedAt: '2026-07-17T00:01:00.000Z',
      });

      service.stop();
    });
  });

  test('race between timer scan and manual dispatch still dispatches only once', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Race', description: 'Only once' });
      await store.scheduleCardDispatch(card.id, '2026-07-17T00:00:00.000Z');

      const timer = createManualTimer();
      const dispatchGate = createDeferred<void>();
      const dispatched: string[] = [];
      const service = new ScheduledDispatchService({
        store,
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          await dispatchGate.promise;
          return { sessionId: 'session-race', runId: 'run-race', startedAt: '2026-07-17T00:00:02.000Z' };
        },
        now: () => new Date('2026-07-17T00:00:01.000Z'),
        timer: timer.timer,
      });

      const startPromise = service.start();
      await drainMicrotasks();

      await expect(dispatchCardWithScheduledReservation({
        store,
        dispatchFn: async () => ({ sessionId: 'manual', runId: 'manual', startedAt: '2026-07-17T00:00:03.000Z' }),
        cardId: card.id,
        now: () => new Date('2026-07-17T00:00:01.500Z'),
      })).rejects.toMatchObject({ statusCode: 409 });

      dispatchGate.resolve();
      await startPromise;

      expect(dispatched).toEqual([card.id]);
      expect((await store.getCard(card.id))?.scheduledDispatch?.status).toBe('dispatched');

      service.stop();
    });
  });

  test('marks failed dispatches once without automatic retries', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Fail once', description: 'Do not retry' });
      await store.scheduleCardDispatch(card.id, '2026-07-17T00:00:00.000Z');

      const timer = createManualTimer();
      let attempts = 0;
      const service = new ScheduledDispatchService({
        store,
        dispatchFn: async () => {
          attempts += 1;
          throw new Error('dispatch rejected');
        },
        now: () => new Date('2026-07-17T00:00:05.000Z'),
        timer: timer.timer,
      });

      await service.start();
      timer.fireAll();
      await drainMicrotasks();

      const updated = await store.getCard(card.id);
      expect(attempts).toBe(1);
      expect(updated?.status).toBe('todo');
      expect(updated?.progressSummary).toBe('[failed] dispatch rejected');
      expect(updated?.scheduledDispatch).toMatchObject({
        status: 'failed',
        error: 'dispatch rejected',
      });

      service.stop();
    });
  });
});

describe('scheduled dispatch bootstrap lifecycle', () => {
  test('owner startup scans immediately and stop/start keeps dispatch service symmetric', async () => {
    await withTempDir(async (dir) => {
      const preStore = new KanbanStore(dir);
      const first = await preStore.createCard({ title: 'Boot due', description: 'First boot scan' });
      await preStore.scheduleCardDispatch(first.id, '2026-07-16T23:59:00.000Z');

      const dispatches: string[] = [];
      const app = await createKanbanApp({
        dataDir: dir,
        opencodeInput: null,
        debugLabel: 'test.bootstrap',
        createDispatch: async () => ({
          dispatchCard: async (cardId: string) => {
            dispatches.push(cardId);
            return { sessionId: `session-${cardId}`, runId: `run-${cardId}`, startedAt: '2026-07-17T00:00:00.000Z' };
          },
          singletonServices: [{
            start() {},
            stop() {},
          }],
        }),
      });

      expect(dispatches).toEqual([first.id]);
      expect((await app.store.getCard(first.id))?.scheduledDispatch?.status).toBe('dispatched');

      app.stopSingleton();

      const second = await app.store.createCard({ title: 'Restart due', description: 'Second scan' });
      await app.store.scheduleCardDispatch(second.id, '2026-07-16T23:58:00.000Z');
      await drainMicrotasks();
      expect(dispatches).toEqual([first.id]);

      await app.startSingleton();
      expect(dispatches).toEqual([first.id, second.id]);
      expect((await app.store.getCard(second.id))?.scheduledDispatch?.status).toBe('dispatched');

      await shutdownApp(app);
    });
  });
});
