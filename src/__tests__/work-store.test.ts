import { describe, test, expect } from 'bun:test';
import { WorkStore } from '../core/work-store';
import { KanbanStore } from '../core/store';
import { createRouteHandler } from '../server/routes';
import { WorkSessionNotIgnoredError } from '../core/work-errors';
import { createWorkStartedAtResolver } from '../plugin/works/work-lifecycle';
import { withTempDir } from './setup';
import type { MoveWorkSessionResponse, Work, WorkInboxSession } from '../core/types';

/** createRouteHandler with only the work store (positional arg 22) wired. */
function handlerWith(store: KanbanStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

/** A card whose session start is pinned, so `startedAt` recalculation is exact. */
async function seedSessionCard(
  store: KanbanStore,
  sessionId: string,
  startedAt: string,
): Promise<void> {
  const card = await store.createCard({ title: sessionId, description: 'seed', sessionId });
  await store.updateCard(card.id, { startedAt });
}

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

      const activeWorks = await store.getWorks({ status: 'active' });
      expect(activeWorks.map(w => w.id)).toEqual([active.id]);
      const doneWorks = await store.getWorks({ status: 'done' });
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

  test('moveSession re-parents a link and re-dates both sides', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const a = await store.createWork({ title: 'source', startedAt: '2026-08-01T00:00:00.000Z' });
      const b = await store.createWork({ title: 'target', startedAt: '2026-09-01T00:00:00.000Z' });
      await store.addSession(a.id, { sessionId: 'ses-1', role: 'dev' });
      await store.addSession(a.id, { sessionId: 'ses-2' });

      // Stand-in for the card-derived min(): the moved session is the oldest, so
      // it pulls the target's bar left and pushes the source's right.
      const dates: Record<string, string> = {
        [a.id]: '2026-08-05T00:00:00.000Z',
        [b.id]: '2026-08-01T00:00:00.000Z',
      };
      const moved = await store.moveSession(
        { sessionId: 'ses-1', toWorkId: b.id },
        work => dates[work.id],
      );

      expect(moved.from?.id).toBe(a.id);
      expect(moved.from?.sessionLinks.map(l => l.sessionId)).toEqual(['ses-2']);
      expect(moved.from?.startedAt).toBe('2026-08-05T00:00:00.000Z');
      expect(moved.to.id).toBe(b.id);
      expect(moved.to.startedAt).toBe('2026-08-01T00:00:00.000Z');
      // The link travels intact — role included, and the 1:N invariant holds.
      expect(moved.to.sessionLinks[0]?.role).toBe('dev');

      const reopened = new WorkStore(dir);
      expect((await reopened.getWork(a.id))?.sessionLinks).toHaveLength(1);
      expect((await reopened.getWork(b.id))?.sessionLinks.map(l => l.sessionId)).toEqual(['ses-1']);
    });
  });

  test('moveSession deletes a source Work left with no sessions', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const a = await store.createWork({ title: 'absorbed' });
      const b = await store.createWork({ title: 'absorber' });
      await store.addSession(a.id, { sessionId: 'ses-1' });

      const moved = await store.moveSession({ sessionId: 'ses-1', toWorkId: b.id });
      // Emptying the source by moving its last session is a merge.
      expect(moved.from).toBeNull();
      expect(await store.getWork(a.id)).toBeNull();
      expect(moved.to.sessionLinks.map(l => l.sessionId)).toEqual(['ses-1']);
    });
  });

  test('moveSession accepts a discarded source and only blocks archived works', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const discarded = await store.createWork({ title: 'discarded' });
      const active = await store.createWork({ title: 'active' });
      await store.addSession(discarded.id, { sessionId: 'ses-1' });
      await store.addSession(discarded.id, { sessionId: 'ses-2' });
      await store.updateWork(discarded.id, { status: 'discarded' });

      // discarded → active: its cards never entered the wiki pipeline.
      const moved = await store.moveSession({ sessionId: 'ses-1', toWorkId: active.id });
      expect(moved.to.sessionLinks).toHaveLength(1);
      expect(moved.from?.status).toBe('discarded');

      // Archived on either end is refused.
      const archived = await store.createWork({ title: 'shipped' });
      await store.updateWork(archived.id, {
        status: 'done', archivedAt: '2026-09-02T00:00:00.000Z',
      });
      await expect(store.moveSession({ sessionId: 'ses-2', toWorkId: archived.id }))
        .rejects.toThrow('archived work');

      await store.updateWork(discarded.id, { archivedAt: '2026-09-02T00:00:00.000Z' });
      await expect(store.moveSession({ sessionId: 'ses-2', toWorkId: active.id }))
        .rejects.toThrow('archived work');
    });
  });

  test('moveSession errors on an unknown session or target work', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'only' });
      await store.addSession(work.id, { sessionId: 'ses-1' });

      await expect(store.moveSession({ sessionId: 'ses-1', toWorkId: 'nope' }))
        .rejects.toThrow('Work not found');
      // An Inbox session belongs to no Work, so there is nothing to move.
      await expect(store.moveSession({ sessionId: 'ses-unassigned', toWorkId: work.id }))
        .rejects.toThrow('not linked to any work');
    });
  });

  test('moving a session onto the Work it already belongs to just refreshes the role', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      const work = await store.createWork({ title: 'same' });
      await store.addSession(work.id, { sessionId: 'ses-1', role: 'dev' });

      const moved = await store.moveSession({ sessionId: 'ses-1', toWorkId: work.id, role: 'review' });
      expect(moved.from?.id).toBe(work.id);
      expect(moved.to.sessionLinks).toHaveLength(1);
      expect(moved.to.sessionLinks[0]?.role).toBe('review');
      expect(await store.getWork(work.id)).not.toBeNull();
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

  // The list was append-only, which made 폐기 the one action here with no way
  // back — a mistyped shortcut lost a session for good.
  test('unignoreSession takes an id back off the list and persists it', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      await store.ignoreSession('ses-x');
      await store.ignoreSession('ses-y');

      expect(await store.unignoreSession('ses-x')).toEqual(['ses-y']);
      expect(await new WorkStore(dir).getIgnoredSessionIds()).toEqual(['ses-y']);
    });
  });

  test('unignoreSession throws for an id that was never ignored', async () => {
    await withTempDir(async (dir) => {
      const store = new WorkStore(dir);
      await store.ignoreSession('ses-x');

      await expect(store.unignoreSession('ses-other')).rejects.toThrow(
        WorkSessionNotIgnoredError,
      );
      expect(await store.getIgnoredSessionIds()).toEqual(['ses-x']);
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

  test('PATCH /api/works/sessions/:sessionId moves a link and re-dates both works', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedSessionCard(store, 'ses-old', '2026-08-01T09:00:00.000Z');
      await seedSessionCard(store, 'ses-mid', '2026-08-05T09:00:00.000Z');
      await seedSessionCard(store, 'ses-new', '2026-09-01T09:00:00.000Z');

      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      const a = await workStore.createWork({ title: 'A' });
      await workStore.addSession(a.id, { sessionId: 'ses-old' }, resolve);
      await workStore.addSession(a.id, { sessionId: 'ses-mid' }, resolve);
      const b = await workStore.createWork({ title: 'B' });
      await workStore.addSession(b.id, { sessionId: 'ses-new' }, resolve);

      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request('http://localhost/api/works/sessions/ses-old', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toWorkId: b.id, role: 'review' }),
      }));
      expect(res.status).toBe(200);
      const moved = await res.json() as MoveWorkSessionResponse;

      // Both bars follow min() over their new link sets.
      expect(moved.from?.id).toBe(a.id);
      expect(moved.from?.startedAt).toBe('2026-08-05T09:00:00.000Z');
      expect(moved.to.id).toBe(b.id);
      expect(moved.to.startedAt).toBe('2026-08-01T09:00:00.000Z');
      expect(moved.to.sessionLinks.find(l => l.sessionId === 'ses-old')?.role).toBe('review');

      // The move did not loosen the re-link 409 on the plain link endpoint.
      const relink = await handleRequest(new Request(`http://localhost/api/works/${a.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-old' }),
      }));
      expect(relink.status).toBe(409);
    });
  });

  test('PATCH /api/works/sessions/:sessionId deletes an emptied source and reports from: null', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const a = await workStore.createWork({ title: 'merged away' });
      await workStore.addSession(a.id, { sessionId: 'ses-1' });
      const b = await workStore.createWork({ title: 'survivor' });
      const { handleRequest } = handlerWith(store, workStore);

      const res = await handleRequest(new Request('http://localhost/api/works/sessions/ses-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toWorkId: b.id }),
      }));
      expect(res.status).toBe(200);
      expect((await res.json() as MoveWorkSessionResponse).from).toBeNull();

      const gone = await handleRequest(new Request(`http://localhost/api/works/${a.id}`));
      expect(gone.status).toBe(404);
    });
  });

  test('moving a session in or out of an archived Work is a 409', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const active = await workStore.createWork({ title: 'active' });
      await workStore.addSession(active.id, { sessionId: 'ses-1' });
      const shipped = await workStore.createWork({ title: 'shipped' });
      await workStore.addSession(shipped.id, { sessionId: 'ses-2' });
      await workStore.updateWork(shipped.id, {
        status: 'done', archivedAt: '2026-09-02T00:00:00.000Z',
      });
      const { handleRequest } = handlerWith(store, workStore);
      const move = (sessionId: string, toWorkId: string) => handleRequest(new Request(
        `http://localhost/api/works/sessions/${sessionId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toWorkId }),
        },
      ));

      const into = await move('ses-1', shipped.id);
      expect(into.status).toBe(409);
      expect((await into.json() as { error: string }).error).toContain('shipped');

      const outOf = await move('ses-2', active.id);
      expect(outOf.status).toBe(409);

      // Both works kept their links.
      expect((await workStore.getWork(active.id))?.sessionLinks).toHaveLength(1);
      expect((await workStore.getWork(shipped.id))?.sessionLinks).toHaveLength(1);
    });
  });

  test('moving an unknown session or into an unknown Work is a 404', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const work = await workStore.createWork({ title: 'W' });
      await workStore.addSession(work.id, { sessionId: 'ses-1' });
      const { handleRequest } = handlerWith(store, workStore);
      const move = (sessionId: string, body: unknown) => handleRequest(new Request(
        `http://localhost/api/works/sessions/${sessionId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ));

      expect((await move('ses-missing', { toWorkId: work.id })).status).toBe(404);
      expect((await move('ses-1', { toWorkId: 'no-such-work' })).status).toBe(404);
      expect((await move('ses-1', {})).status).toBe(400);
      expect((await move('ses-1', { toWorkId: work.id, role: 'architect' })).status).toBe(400);
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

/**
 * The link-set writers must resolve `min()` **inside** the store's lock. Every
 * test here fails against the previous design, where the route computed the
 * date first and handed the store a value.
 */
describe('WorkStore link-set concurrency and date normalization', () => {
  test('two concurrent POST .../sessions leave startedAt at min() of both', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedSessionCard(store, 'ses-early', '2026-08-01T00:00:00.000Z');
      await seedSessionCard(store, 'ses-late', '2026-08-20T00:00:00.000Z');
      const { handleRequest } = handlerWith(store, workStore);

      // Run the race in **both** orders. Whichever request commits last used to
      // decide the date on its own, having resolved min() over the link set it
      // read before the lock — a set that never contained the other session. One
      // of the two orders therefore lost the earlier start; which one depended
      // on scheduling, so a single ordering here would pass by luck.
      for (const order of [['ses-late', 'ses-early'], ['ses-early', 'ses-late']]) {
        const work = await workStore.createWork({
          title: `race ${order[0]}`, startedAt: '2026-09-01T00:00:00.000Z',
        });
        const link = (sessionId: string) => handleRequest(new Request(
          `http://localhost/api/works/${work.id}/sessions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          },
        ));
        const responses = await Promise.all(order.map(link));
        expect(responses.map(r => r.status)).toEqual([200, 200]);

        const settled = (await workStore.getWork(work.id))!;
        expect(settled.sessionLinks.map(l => l.sessionId).sort())
          .toEqual(['ses-early', 'ses-late']);
        expect(settled.startedAt).toBe('2026-08-01T00:00:00.000Z');

        // Cleanup so the next order starts from an unlinked pair (1:N).
        await workStore.deleteWork(work.id);
      }
    });
  });

  test('PATCH normalizes an offset ISO date to UTC and clamps against it correctly', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'offset' });

      // 2026-09-01T09:00+09:00 === 2026-09-01T00:00:00.000Z. Stored verbatim it
      // sorts *after* the Z form as text while being the same instant.
      const res = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startedAt: '2026-08-01T09:00:00+09:00',
          resolvedAt: '2026-09-01T09:00:00+09:00',
        }),
      }));
      expect(res.status).toBe(200);
      const patched = await res.json() as Work;
      expect(patched.startedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(patched.resolvedAt).toBe('2026-09-01T00:00:00.000Z');

      // A recalculated start after `resolvedAt` collapses the bar; one before it
      // is written through. Both verdicts are instant comparisons, not string
      // ones — the second case is what a lexical `>` got wrong.
      await seedSessionCard(store, 'ses-after', '2026-10-01T00:00:00.000Z');
      const resolveLate = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      const clamped = await workStore.addSession(work.id, { sessionId: 'ses-after' }, resolveLate);
      expect(clamped.startedAt).toBe('2026-09-01T00:00:00.000Z');

      await seedSessionCard(store, 'ses-before', '2026-07-01T00:00:00.000Z');
      const resolveEarly = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      const pulled = await workStore.addSession(work.id, { sessionId: 'ses-before' }, resolveEarly);
      expect(pulled.startedAt).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  test('DELETE .../sessions/:id for an unlinked session changes nothing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedSessionCard(store, 'ses-1', '2026-08-01T00:00:00.000Z');
      const created = await workStore.createWork({ title: 'manual' });
      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      await workStore.addSession(created.id, { sessionId: 'ses-1' }, resolve);
      // A hand-picked start the user dragged the bar to — later than min().
      const dated = await workStore.updateWork(created.id, {
        startedAt: '2026-08-15T00:00:00.000Z',
      });
      expect(dated.startedAt).toBe('2026-08-15T00:00:00.000Z');

      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request(
        `http://localhost/api/works/${created.id}/sessions/ses-never-linked`,
        { method: 'DELETE' },
      ));
      expect(res.status).toBe(200);

      // The no-op used to recalculate anyway and overwrite the manual date.
      const after = (await workStore.getWork(created.id))!;
      expect(after.startedAt).toBe('2026-08-15T00:00:00.000Z');
      expect(after.updatedAt).toBe(dated.updatedAt);
    });
  });

  test('DELETE .../sessions/:id reports the store reason instead of a generic 500', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request(
        'http://localhost/api/works/no-such-work/sessions/ses-1',
        { method: 'DELETE' },
      ));
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('Work not found');
    });
  });
});

/**
 * `PATCH /api/works/:id` input validation. Each case used to reach the store
 * unchecked; two of them were unrecoverable once written.
 */
describe('PATCH /api/works/:id validation', () => {
  const patch = async (dir: string, body: unknown) => {
    const store = new KanbanStore(dir);
    const workStore = new WorkStore(dir);
    const work = await workStore.createWork({ title: 'validate me' });
    const { handleRequest } = handlerWith(store, workStore);
    const res = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { res, work, workStore };
  };

  test('rejects a client-supplied archivedAt', async () => {
    await withTempDir(async (dir) => {
      // `archivedAt` gates the sweep's idempotence *and* the session-move rule,
      // so an arbitrary string parked there froze both with no UI to undo it.
      const { res, work, workStore } = await patch(dir, { archivedAt: 'whenever' });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('archivedAt');
      expect((await workStore.getWork(work.id))?.archivedAt).toBeUndefined();
    });
  });

  test('rejects a client-supplied wikiDocPath', async () => {
    await withTempDir(async (dir) => {
      const { res } = await patch(dir, { wikiDocPath: 'anywhere.md' });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('wikiDocPath');
    });
  });

  test('rejects a non-string title with a message about the field, not a stack detail', async () => {
    await withTempDir(async (dir) => {
      const { res } = await patch(dir, { title: 7 });
      expect(res.status).toBe(400);
      const { error } = await res.json() as { error: string };
      expect(error).toBe('title must be a string');
      expect(error).not.toContain('trim');
    });
  });

  test('rejects a non-string projectDir and a malformed summary', async () => {
    await withTempDir(async (dir) => {
      expect((await patch(dir, { projectDir: 3 })).res.status).toBe(400);
      expect((await patch(dir, { summary: 'just a string' })).res.status).toBe(400);
      expect((await patch(dir, { summary: { lines: [1, 2] } })).res.status).toBe(400);
    });
  });

  test('accepts a well-formed summary and a null clear', async () => {
    await withTempDir(async (dir) => {
      const summary = {
        lines: ['한 줄', '두 줄'],
        generatedAt: '2026-09-01T00:00:00.000Z',
        model: 'claude-sonnet-5',
      };
      const { res, work, workStore } = await patch(dir, { summary });
      expect(res.status).toBe(200);
      expect((await workStore.getWork(work.id))?.summary?.lines).toEqual(['한 줄', '두 줄']);

      const { handleRequest } = handlerWith(new KanbanStore(dir), workStore);
      const cleared = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: null }),
      }));
      expect(cleared.status).toBe(200);
      expect((await workStore.getWork(work.id))?.summary).toBeUndefined();
    });
  });

  test('rejects the resolution only the server may stamp', async () => {
    await withTempDir(async (dir) => {
      // `superseded` is back in `WorkResolution` — but only the merge route
      // stamps it, together with the `supersededByWorkId` that says *where*
      // the sessions went. A client-writable `superseded` would be a 병합됨
      // Work pointing nowhere.
      expect((await patch(dir, { resolution: 'superseded' })).res.status).toBe(400);
      expect((await patch(dir, { resolution: 'completed' })).res.status).toBe(200);
    });
  });
});
