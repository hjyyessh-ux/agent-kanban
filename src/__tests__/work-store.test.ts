import { describe, test, expect } from 'bun:test';
import { WorkStore } from '../core/work-store';
import { KanbanStore } from '../core/store';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';
import type { Work, WorkInboxSession } from '../core/types';

describe('WorkStore', () => {
  test('creates works.json on first write and round-trips through a new instance', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'ArgoCD ACL 개선', projectDir: '/repo' });
      expect(work.id).toBeTruthy();
      expect(work.status).toBe('active');
      expect(work.sessionLinks).toEqual([]);

      const reopened = new WorkStore(dir);
      const works = await reopened.getWorks();
      expect(works).toHaveLength(1);
      expect(works[0]?.title).toBe('ArgoCD ACL 개선');
    });
  });

  test('rejects a blank title', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      await expect(store.createWork({ title: '   ' })).rejects.toThrow('title is required');
    });
  });

  test('filters works by status', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const active = await store.createWork({ title: 'active work' });
      const done = await store.createWork({ title: 'done work' });
      await store.updateWork(done.id, { status: 'done' });

      const activeWorks = await store.getWorks('active');
      expect(activeWorks.map(w => w.id)).toEqual([active.id]);
      const doneWorks = await store.getWorks('done');
      expect(doneWorks.map(w => w.id)).toEqual([done.id]);
    });
  });

  test('stamps resolvedAt when moving to a terminal status', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'finish me' });
      expect(work.resolvedAt).toBeUndefined();

      const done = await store.updateWork(work.id, { status: 'done', resolution: 'completed' });
      expect(done.status).toBe('done');
      expect(done.resolution).toBe('completed');
      expect(done.resolvedAt).toBeTruthy();
    });
  });

  test('re-dating a Work moves the Timeline bar without touching status', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'redate me', startedAt: '2026-08-31T09:00:00.000Z' });
      const moved = await store.updateWork(work.id, {
        startedAt: '2026-08-26T09:00:00.000Z',
        resolvedAt: '2026-09-02T18:00:00.000Z',
      });
      expect(moved.startedAt).toBe('2026-08-26T09:00:00.000Z');
      expect(moved.resolvedAt).toBe('2026-09-02T18:00:00.000Z');
      // A date-only patch must not imply a terminal transition.
      expect(moved.status).toBe('active');
      expect(moved.resolution).toBeUndefined();
    });
  });

  test('a planned end set while active survives the later completion', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'plan then finish', startedAt: '2026-09-01T09:00:00.000Z' });

      // The user drags the open bar's right edge (or types a date) first…
      const planned = await store.updateWork(work.id, { resolvedAt: '2026-09-04T18:00:00.000Z' });
      expect(planned.status).toBe('active');
      expect(planned.resolvedAt).toBe('2026-09-04T18:00:00.000Z');

      // …and completes afterwards: the auto-stamp must not overwrite the plan.
      const done = await store.updateWork(work.id, { status: 'done' });
      expect(done.resolvedAt).toBe('2026-09-04T18:00:00.000Z');
      expect(done.resolution).toBe('completed');
    });
  });

  test('clearing a planned end puts the bar back on today', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'unplan', startedAt: '2026-09-01T09:00:00.000Z' });
      await store.updateWork(work.id, { resolvedAt: '2026-09-04T18:00:00.000Z' });
      const cleared = await store.updateWork(work.id, { resolvedAt: null });
      expect(cleared.resolvedAt).toBeUndefined();
      expect(cleared.status).toBe('active');
    });
  });

  test('rejects a date edit that would invert the bar', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'inverted', startedAt: '2026-09-01T09:00:00.000Z' });
      await store.updateWork(work.id, { status: 'done' });

      await expect(store.updateWork(work.id, { resolvedAt: '2026-08-20T09:00:00.000Z' }))
        .rejects.toThrow('must not precede');
      await expect(store.updateWork(work.id, { startedAt: '2027-01-01T09:00:00.000Z' }))
        .rejects.toThrow('must not precede');

      // The rejected writes left nothing behind.
      const after = await store.getWork(work.id);
      expect(after?.startedAt).toBe('2026-09-01T09:00:00.000Z');
    });
  });

  test('honours the null-clear convention on optional fields', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'clearable', projectDir: '/repo' });
      const withDir = await store.updateWork(work.id, { projectDir: '/other' });
      expect(withDir.projectDir).toBe('/other');
      const cleared = await store.updateWork(work.id, { projectDir: null });
      expect(cleared.projectDir).toBeUndefined();
    });
  });

  test('enforces the 1:N invariant across works', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const a = await store.createWork({ title: 'work a' });
      const b = await store.createWork({ title: 'work b' });

      const linked = await store.addSession(a.id, { sessionId: 'ses-1', role: 'dev' });
      expect(linked.sessionLinks).toHaveLength(1);
      expect(linked.sessionLinks[0]?.role).toBe('dev');

      await expect(store.addSession(b.id, { sessionId: 'ses-1' })).rejects.toThrow('already linked');
    });
  });

  test('re-linking the same session to the same work is idempotent and updates role', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'idem' });
      await store.addSession(work.id, { sessionId: 'ses-1', role: 'dev' });
      const updated = await store.addSession(work.id, { sessionId: 'ses-1', role: 'review' });
      expect(updated.sessionLinks).toHaveLength(1);
      expect(updated.sessionLinks[0]?.role).toBe('review');
    });
  });

  test('removes a session link and frees it for another work', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const a = await store.createWork({ title: 'work a' });
      const b = await store.createWork({ title: 'work b' });
      await store.addSession(a.id, { sessionId: 'ses-1' });
      const afterRemove = await store.removeSession(a.id, 'ses-1');
      expect(afterRemove.sessionLinks).toHaveLength(0);
      const relinked = await store.addSession(b.id, { sessionId: 'ses-1' });
      expect(relinked.sessionLinks).toHaveLength(1);
    });
  });

  test('persists ignored session ids idempotently', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      await store.ignoreSession('ses-x');
      await store.ignoreSession('ses-x');
      await store.ignoreSession('ses-y');
      const ignored = await new WorkStore(dir).getIgnoredSessionIds();
      expect(ignored.sort()).toEqual(['ses-x', 'ses-y']);
    });
  });

  test('deleteWork removes the entry and errors on unknown id', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'temp' });
      await store.deleteWork(work.id);
      expect(await store.getWork(work.id)).toBeNull();
      await expect(store.deleteWork('missing')).rejects.toThrow('not found');
    });
  });
});

describe('Works routes', () => {
  test('503 when the work store is not wired', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = createRouteHandler(store);
      const res = await handleRequest(new Request('http://localhost/api/works'));
      expect(res.status).toBe(503);
    });
  });

  test('full CRUD + session lifecycle over HTTP', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );

      const created = await handleRequest(new Request('http://localhost/api/works', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'HTTP work', projectDir: '/repo' }),
      }));
      expect(created.status).toBe(201);
      const work = await created.json() as Work;
      expect(work.title).toBe('HTTP work');

      const listed = await handleRequest(new Request('http://localhost/api/works'));
      expect((await listed.json() as Work[])).toHaveLength(1);

      const addSession = await handleRequest(new Request(`http://localhost/api/works/${work.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-1', role: 'dev' }),
      }));
      expect(addSession.status).toBe(200);
      expect((await addSession.json() as Work).sessionLinks).toHaveLength(1);

      const patched = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', resolution: 'completed' }),
      }));
      expect((await patched.json() as Work).resolvedAt).toBeTruthy();

      const removed = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions/ses-1`,
        { method: 'DELETE' },
      ));
      expect((await removed.json() as Work).sessionLinks).toHaveLength(0);

      const del = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, { method: 'DELETE' }));
      expect(del.status).toBe(204);
    });
  });

  test('PATCH re-dates a Work and rejects unusable dates', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const work = await workStore.createWork({
        title: 'draggable',
        startedAt: '2026-09-01T09:00:00.000Z',
      });
      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );
      const patch = (body: unknown) => handleRequest(new Request(
        `http://localhost/api/works/${work.id}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ));

      // A bar-edge drag: startedAt only, no status change and no card sweep.
      const moved = await patch({ startedAt: '2026-08-28T09:00:00.000Z' });
      expect(moved.status).toBe(200);
      const updated = await moved.json() as Work;
      expect(updated.startedAt).toBe('2026-08-28T09:00:00.000Z');
      expect(updated.status).toBe('active');
      expect(updated.archivedAt).toBeUndefined();

      const garbage = await patch({ startedAt: 'yesterday-ish' });
      expect(garbage.status).toBe(400);
      expect((await garbage.json() as { error: string }).error).toBe('Invalid startedAt');

      const badEnd = await patch({ resolvedAt: 'soon' });
      expect(badEnd.status).toBe(400);

      const inverted = await patch({ resolvedAt: '2026-08-01T09:00:00.000Z' });
      expect(inverted.status).toBe(400);
    });
  });

  test('adding an already-linked session returns 409', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const a = await workStore.createWork({ title: 'a' });
      const b = await workStore.createWork({ title: 'b' });
      await workStore.addSession(a.id, { sessionId: 'ses-1' });
      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );
      const res = await handleRequest(new Request(`http://localhost/api/works/${b.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-1' }),
      }));
      expect(res.status).toBe(409);
    });
  });

  test('inbox excludes linked and ignored sessions', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      // Seed three sessions via cards.
      await store.createCard({ title: 'c1', description: '', sessionId: 'ses-1', projectDir: '/repo' });
      await store.createCard({ title: 'c2', description: '', sessionId: 'ses-2', projectDir: '/repo' });
      await store.createCard({ title: 'c3', description: '', sessionId: 'ses-3', projectDir: '/repo' });

      const work = await workStore.createWork({ title: 'owner' });
      await workStore.addSession(work.id, { sessionId: 'ses-1' });
      await workStore.ignoreSession('ses-2');

      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );
      const res = await handleRequest(new Request('http://localhost/api/works/inbox'));
      expect(res.status).toBe(200);
      const inbox = await res.json() as WorkInboxSession[];
      expect(inbox.map(s => s.sessionId)).toEqual(['ses-3']);
      expect(inbox[0]?.projectDir).toBe('/repo');
    });
  });

  test('ignore-session route persists the id', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );
      const res = await handleRequest(new Request('http://localhost/api/works/ignore-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-9' }),
      }));
      expect(res.status).toBe(200);
      expect(await workStore.getIgnoredSessionIds()).toEqual(['ses-9']);
    });
  });
});
