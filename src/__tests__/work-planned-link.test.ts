import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { createRouteHandler } from '../server/routes';
import { createPlannedWorkLinker } from '../plugin/works/work-planned-link';
import { withTempDir } from './setup';

/** createRouteHandler with only the work store wired (positional arg 22) — same helper as work-store.test.ts. */
function handlerWith(store: KanbanStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

describe('createPlannedWorkLinker', () => {
  test('links the new sessionId to the reserved Work and clears the reservation', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      store.setSessionAssignedHook(createPlannedWorkLinker(store, workStore));

      const work = await workStore.createWork({ title: 'ZEPETOFUL 배포 검증', projectDir: '/repo' });
      const card = await store.createCard({ title: 'T', description: 'D', plannedWorkId: work.id });

      const dispatched = await store.updateCard(card.id, { sessionId: 'sess-1', status: 'in_progress' });
      expect(dispatched.plannedWorkId).toBeUndefined();

      const linked = await workStore.getWork(work.id);
      expect(linked!.sessionLinks.map((link) => link.sessionId)).toEqual(['sess-1']);
    });
  });

  test('drops the reservation without linking when the Work closed first', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      store.setSessionAssignedHook(createPlannedWorkLinker(store, workStore));

      const work = await workStore.createWork({ title: 'SMS Whitelist 관리', projectDir: '/repo' });
      const card = await store.createCard({ title: 'T', description: 'D', plannedWorkId: work.id });
      await workStore.updateWork(work.id, { status: 'done' });

      const dispatched = await store.updateCard(card.id, { sessionId: 'sess-2' });
      expect(dispatched.plannedWorkId).toBeUndefined();

      const closed = await workStore.getWork(work.id);
      expect(closed!.sessionLinks).toEqual([]);
    });
  });

  test('drops the reservation without linking when the Work was deleted first', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      store.setSessionAssignedHook(createPlannedWorkLinker(store, workStore));

      const work = await workStore.createWork({ title: 'temp', projectDir: '/repo' });
      const card = await store.createCard({ title: 'T', description: 'D', plannedWorkId: work.id });
      await workStore.deleteWork(work.id);

      const dispatched = await store.updateCard(card.id, { sessionId: 'sess-3' });
      expect(dispatched.plannedWorkId).toBeUndefined();
    });
  });

  test('a card with no reservation is left untouched', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      store.setSessionAssignedHook(createPlannedWorkLinker(store, workStore));

      const card = await store.createCard({ title: 'T', description: 'D' });
      const dispatched = await store.updateCard(card.id, { sessionId: 'sess-4' });
      expect(dispatched.plannedWorkId).toBeUndefined();
      expect((await workStore.getWorks()).every((w) => w.sessionLinks.length === 0)).toBe(true);
    });
  });
});

describe('plannedWorkId card route validation', () => {
  test('PATCH /api/cards/:id rejects a plannedWorkId for a Work that does not exist', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await store.createCard({ title: 'T', description: 'D' });

      const res = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedWorkId: 'no-such-work' }),
      }));

      expect(res.status).toBe(404);
    });
  });

  test('PATCH /api/cards/:id rejects a plannedWorkId for a closed Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await store.createCard({ title: 'T', description: 'D' });
      const work = await workStore.createWork({ title: 'Closed', projectDir: '/repo' });
      await workStore.updateWork(work.id, { status: 'discarded' });

      const res = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedWorkId: work.id }),
      }));

      expect(res.status).toBe(400);
    });
  });

  test('PATCH /api/cards/:id accepts a plannedWorkId for an active Work, and clears it with null', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await store.createCard({ title: 'T', description: 'D' });
      const work = await workStore.createWork({ title: 'Active', projectDir: '/repo' });

      const res = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedWorkId: work.id }),
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).plannedWorkId).toBe(work.id);

      const cleared = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedWorkId: null }),
      }));
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).plannedWorkId).toBeUndefined();
    });
  });

  test('POST /api/cards rejects a plannedWorkId for a Work that is not active', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'Closed', projectDir: '/repo' });
      await workStore.updateWork(work.id, { status: 'done' });

      const res = await handleRequest(new Request('http://localhost/api/cards', {
        method: 'POST',
        body: JSON.stringify({ title: 'T', description: 'D', plannedWorkId: work.id }),
      }));

      expect(res.status).toBe(400);
    });
  });
});
