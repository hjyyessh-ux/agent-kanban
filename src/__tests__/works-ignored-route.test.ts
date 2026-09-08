import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import {
  createRouteHandler,
  type AggregateSessionsFn,
  type NativeSessionInfo,
} from '../server/routes';
import { withTempDir } from './setup';
import type { Work, WorkIgnoredSession, WorkInboxSession } from '../core/types';

/**
 * The read/undo side of the Inbox ignore list, plus the `active`-only gate on
 * new session links.
 *
 * `POST /api/works/ignore-session` used to have no counterpart at all: the list
 * was append-only and unreadable over HTTP, so a mistyped `x` in the assign
 * modal removed a session from every screen with `works.json` as the only way
 * back. These tests fix the two routes that close that loop and the `409` that
 * stops a vanished recommendation from attaching a session to a finished Work.
 *
 * The native aggregator is wired throughout, because that is the only path
 * production takes (`plugin/bootstrap.ts` always injects it).
 */
function handlerWith(
  store: KanbanStore,
  workStore: WorkStore,
  aggregateSessionsFn?: AggregateSessionsFn,
) {
  return createRouteHandler(
    store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, aggregateSessionsFn, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, workStore,
  );
}

function nativeSessions(...sessionIds: string[]): AggregateSessionsFn {
  return async () => sessionIds.map((sessionId): NativeSessionInfo => ({
    sessionId,
    sessionTitle: `native ${sessionId}`,
    updatedAt: new Date().toISOString(),
    sourceInstanceId: 'peer-a',
    sourcePort: 24680,
    sourceIsLocal: true,
  }));
}

async function seedCard(
  store: KanbanStore,
  input: { title: string; sessionId: string; parentCardId?: string },
): Promise<string> {
  const card = await store.createCard({
    title: input.title,
    description: '',
    sessionId: input.sessionId,
    projectDir: '/repo',
    parentCardId: input.parentCardId,
  });
  return card.id;
}

type Handle = (req: Request) => Promise<Response>;

async function readIgnored(handleRequest: Handle): Promise<WorkIgnoredSession[]> {
  const res = await handleRequest(new Request('http://localhost/api/works/ignored-sessions'));
  expect(res.status).toBe(200);
  return await res.json() as WorkIgnoredSession[];
}

async function readInbox(handleRequest: Handle): Promise<WorkInboxSession[]> {
  const res = await handleRequest(new Request('http://localhost/api/works/inbox'));
  expect(res.status).toBe(200);
  return await res.json() as WorkInboxSession[];
}

function restore(handleRequest: Handle, sessionId: string): Promise<Response> {
  return handleRequest(new Request(
    `http://localhost/api/works/ignore-session/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  ));
}

function linkSession(
  handleRequest: Handle,
  workId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handleRequest(new Request(`http://localhost/api/works/${workId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('GET /api/works/ignored-sessions', () => {
  test('returns the discarded sessions with their Inbox summary', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'discarded work', sessionId: 'ses-x' });
      await seedCard(store, { title: 'still triaging', sessionId: 'ses-keep' });
      await workStore.ignoreSession('ses-x');

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-x', 'ses-keep'),
      );
      const ignored = await readIgnored(handleRequest);

      expect(ignored).toHaveLength(1);
      expect(ignored[0].sessionId).toBe('ses-x');
      // Identifiable by its first prompt, not by an opaque session id.
      expect(ignored[0].session?.cardTitle).toBe('discarded work');
      expect(ignored[0].returnsToInbox).toBe(true);
      // …and it is gone from the Inbox, which is why the list has to exist.
      expect((await readInbox(handleRequest)).map(s => s.sessionId)).toEqual(['ses-keep']);
    });
  });

  test('keeps a row whose cards are gone, and says it will not come back', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await workStore.ignoreSession('ses-gone');

      const { handleRequest } = handlerWith(store, workStore, nativeSessions());
      const ignored = await readIgnored(handleRequest);

      expect(ignored.map(entry => entry.sessionId)).toEqual(['ses-gone']);
      expect(ignored[0].session).toBeUndefined();
      expect(ignored[0].returnsToInbox).toBe(false);
    });
  });

  test('reports returnsToInbox=false for a session that has since been linked', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'linked anyway', sessionId: 'ses-linked' });
      await workStore.ignoreSession('ses-linked');
      const work = await workStore.createWork({ title: 'owner' });
      await workStore.addSession(work.id, { sessionId: 'ses-linked' });

      const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-linked'));
      const ignored = await readIgnored(handleRequest);

      expect(ignored[0].returnsToInbox).toBe(false);
    });
  });
});

describe('DELETE /api/works/ignore-session/:sessionId', () => {
  test('restores the session to the Inbox', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'oops discarded', sessionId: 'ses-oops' });
      await workStore.ignoreSession('ses-oops');

      const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-oops'));
      expect(await readInbox(handleRequest)).toEqual([]);

      const res = await restore(handleRequest, 'ses-oops');
      expect(res.status).toBe(200);
      expect(await res.json() as { ignoredSessionIds: string[] })
        .toEqual({ ignoredSessionIds: [] });

      expect((await readInbox(handleRequest)).map(s => s.sessionId)).toEqual(['ses-oops']);
      expect(await readIgnored(handleRequest)).toEqual([]);
    });
  });

  test('404s a session that was never ignored, leaving the list untouched', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await workStore.ignoreSession('ses-a');

      const { handleRequest } = handlerWith(store, workStore, nativeSessions());
      const res = await restore(handleRequest, 'ses-never');

      expect(res.status).toBe(404);
      expect(await workStore.getIgnoredSessionIds()).toEqual(['ses-a']);
    });
  });
});

describe('POST /api/works/:id/sessions — only an active Work takes new sessions', () => {
  async function resolvedWork(
    workStore: WorkStore,
    status: 'done' | 'discarded',
  ): Promise<Work> {
    const work = await workStore.createWork({ title: `${status} work` });
    return workStore.updateWork(work.id, { status });
  }

  for (const status of ['done', 'discarded'] as const) {
    test(`409s a new link onto a ${status} Work`, async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const workStore = new WorkStore(dir);
        await seedCard(store, { title: 'late session', sessionId: 'ses-late' });
        const work = await resolvedWork(workStore, status);

        const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-late'));
        const res = await linkSession(handleRequest, work.id, { sessionId: 'ses-late' });

        expect(res.status).toBe(409);
        expect((await res.json() as { error: string }).error).toContain(status);
        expect((await workStore.getWork(work.id))!.sessionLinks).toEqual([]);
      });
    });
  }

  test('still allows a same-Work re-link, which is how a role is changed', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'held session', sessionId: 'ses-held' });
      const work = await workStore.createWork({ title: 'finished work' });
      await workStore.addSession(work.id, { sessionId: 'ses-held', role: 'dev' });
      await workStore.updateWork(work.id, { status: 'done' });

      const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-held'));
      const res = await linkSession(handleRequest, work.id, {
        sessionId: 'ses-held',
        role: 'review',
      });

      expect(res.status).toBe(200);
      expect((await workStore.getWork(work.id))!.sessionLinks[0].role).toBe('review');
    });
  });

  test('links onto an active Work as before', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'fresh session', sessionId: 'ses-fresh' });
      const work = await workStore.createWork({ title: 'active work' });

      const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-fresh'));
      const res = await linkSession(handleRequest, work.id, { sessionId: 'ses-fresh' });

      expect(res.status).toBe(200);
      expect((await workStore.getWork(work.id))!.sessionLinks.map(l => l.sessionId))
        .toEqual(['ses-fresh']);
    });
  });
});
