import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import {
  createRouteHandler,
  parseInboxQuery,
  type AggregateSessionsFn,
  type NativeSessionInfo,
} from '../server/routes';
import { withTempDir } from './setup';
import type { WorkInboxSession, Work } from '../core/types';

/**
 * `GET /api/works/inbox` **with the native session aggregator wired**, which is
 * the configuration production always runs: `plugin/bootstrap.ts` injects
 * `aggregateSessionsFn` unconditionally.
 *
 * That is the gap this suite exists to close. Every previous route test passed
 * `undefined` for the aggregator, so all of them exercised the card-derived
 * branch — and `relatedSessionIds` (the whole basis of the `🔗 이어진 세션`
 * recommendation) was only ever populated inside that branch. The feature was
 * dead in every real deployment and green in the test suite.
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

/** A native peer listing that reports exactly these session ids. */
function nativeSessions(...sessionIds: string[]): AggregateSessionsFn {
  return async () => sessionIds.map((sessionId): NativeSessionInfo => ({
    sessionId,
    sessionTitle: `native ${sessionId}`,
    updatedAt: '2026-09-03T00:00:00.000Z',
    sourceInstanceId: 'peer-a',
    sourcePort: 24680,
    sourceIsLocal: true,
  }));
}

async function seedCard(
  store: KanbanStore,
  input: {
    title: string;
    sessionId: string;
    parentCardId?: string;
    status?: 'todo' | 'in_progress' | 'complete' | 'done';
    updatedAt?: string;
  },
): Promise<string> {
  const card = await store.createCard({
    title: input.title,
    description: '',
    sessionId: input.sessionId,
    projectDir: '/repo',
    parentCardId: input.parentCardId,
  });
  if (input.status && input.status !== 'todo') {
    await store.updateCard(card.id, { status: input.status });
  }
  if (input.updatedAt) {
    // The Inbox window is measured on `updatedAt`, which the store stamps on
    // every write — backdating it means editing the board directly, after the
    // last write.
    const board = await store.load();
    const target = board.cards.find(c => c.id === card.id);
    if (target) target.updatedAt = input.updatedAt;
    await store.save(board);
  }
  return card.id;
}

async function readInbox(
  handleRequest: (req: Request) => Promise<Response>,
  query = '',
): Promise<WorkInboxSession[]> {
  const res = await handleRequest(new Request(`http://localhost/api/works/inbox${query}`));
  expect(res.status).toBe(200);
  return await res.json() as WorkInboxSession[];
}

describe('GET /api/works/inbox — session lineage on the native path', () => {
  test('populates relatedSessionIds when aggregateSessionsFn is injected', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      // Queue chain across two sessions: lineage, but not a subagent relation.
      const first = await seedCard(store, { title: 'first', sessionId: 'ses-1' });
      const second = await store.createCard({
        title: 'second',
        description: '',
        sessionId: 'ses-2',
        projectDir: '/repo',
      });
      await store.updateCard(second.id, { queuedAfterCardId: first });

      const { handleRequest } = handlerWith(store, workStore, nativeSessions('ses-1', 'ses-2'));
      const inbox = await readInbox(handleRequest);

      const bySession = new Map(inbox.map(s => [s.sessionId, s]));
      expect(bySession.get('ses-1')?.relatedSessionIds).toEqual(['ses-2']);
      expect(bySession.get('ses-2')?.relatedSessionIds).toEqual(['ses-1']);
    });
  });

  test('reports sessionKind and cardStatus for every row', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, {
        title: 'parent',
        sessionId: 'ses-parent',
        status: 'in_progress',
      });
      await seedCard(store, {
        title: 'child',
        sessionId: 'ses-child',
        parentCardId: parent,
        status: 'done',
      });

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-parent', 'ses-child'),
      );
      const bySession = new Map((await readInbox(handleRequest)).map(s => [s.sessionId, s]));

      expect(bySession.get('ses-parent')?.sessionKind).toBe('main');
      expect(bySession.get('ses-parent')?.cardStatus).toBe('in_progress');
      expect(bySession.get('ses-child')?.sessionKind).toBe('subagent');
      expect(bySession.get('ses-child')?.cardStatus).toBe('done');
    });
  });
});

describe('GET /api/works/inbox — what is not triage material', () => {
  test('drops a native session that has no card at all', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'tracked', sessionId: 'ses-tracked' });

      // The peer reports both; only one is backed by a card.
      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-tracked', 'ses-cardless'),
      );
      const inbox = await readInbox(handleRequest);

      expect(inbox.map(s => s.sessionId)).toEqual(['ses-tracked']);
      expect(inbox.some(s => s.cardTitle === '(No linked card)')).toBe(false);
    });
  });

  test('hides a subagent session whose parent is already linked to a Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'ses-parent' });
      await seedCard(store, {
        title: 'child',
        sessionId: 'ses-child',
        parentCardId: parent,
      });
      const aggregate = nativeSessions('ses-parent', 'ses-child');
      const { handleRequest } = handlerWith(store, workStore, aggregate);

      // Both rows show while nothing is assigned: the parent is unassigned too,
      // so the subagent row is the user's only clue that they are related.
      expect((await readInbox(handleRequest)).map(s => s.sessionId).sort())
        .toEqual(['ses-child', 'ses-parent']);

      const work = await workStore.createWork({ title: 'owner' });
      await workStore.addSession(work.id, { sessionId: 'ses-parent' });

      expect(await readInbox(handleRequest)).toEqual([]);
    });
  });

  test('applies the since window, keeping a still-running session regardless', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
      await seedCard(store, { title: 'recent', sessionId: 'ses-recent' });
      await seedCard(store, { title: 'stale', sessionId: 'ses-stale', updatedAt: old });
      await seedCard(store, {
        title: 'stale but running',
        sessionId: 'ses-running',
        status: 'in_progress',
        updatedAt: old,
      });

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-recent', 'ses-stale', 'ses-running'),
      );

      // Default window is 30 days: the stale finished session is out, the stale
      // *running* one is not — an agent working right now is triage material no
      // matter what its clock says.
      expect((await readInbox(handleRequest)).map(s => s.sessionId).sort())
        .toEqual(['ses-recent', 'ses-running']);

      // Opting out brings it back.
      expect((await readInbox(handleRequest, '?since=all')).map(s => s.sessionId).sort())
        .toEqual(['ses-recent', 'ses-running', 'ses-stale']);
      expect((await readInbox(handleRequest, '?since=120')).map(s => s.sessionId).sort())
        .toEqual(['ses-recent', 'ses-running', 'ses-stale']);
    });
  });

  test('caps the row count with limit, newest first', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, {
        title: 'oldest', sessionId: 'ses-old', updatedAt: '2026-09-01T00:00:00.000Z',
      });
      await seedCard(store, {
        title: 'newest', sessionId: 'ses-new', updatedAt: '2026-09-03T00:00:00.000Z',
      });

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-old', 'ses-new'),
      );
      const limited = await readInbox(handleRequest, '?since=all&limit=1');
      expect(limited.map(s => s.sessionId)).toEqual(['ses-new']);
    });
  });

  test('rejects a query it cannot parse', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      expect((await handleRequest(
        new Request('http://localhost/api/works/inbox?since=last-tuesday'),
      )).status).toBe(400);
      expect((await handleRequest(
        new Request('http://localhost/api/works/inbox?limit=0'),
      )).status).toBe(400);
    });
  });
});

describe('parseInboxQuery', () => {
  const now = new Date('2026-09-04T00:00:00.000Z');

  test('defaults to a 30-day window and a bounded row count', () => {
    const query = parseInboxQuery(new URLSearchParams(), now);
    expect(query.sinceIso).toBe('2026-08-05T00:00:00.000Z');
    expect(query.limit).toBe(200);
  });

  test('reads a day count in preference to an ISO parse', () => {
    // `Date.parse('30')` is a year in some engines — a bare number must always
    // mean days, or `since=30` silently becomes a cutoff two millennia ago.
    expect(parseInboxQuery(new URLSearchParams('since=7'), now).sinceIso)
      .toBe('2026-08-28T00:00:00.000Z');
  });

  test('accepts an explicit instant and an opt-out', () => {
    expect(parseInboxQuery(new URLSearchParams('since=2026-01-01T00:00:00.000Z'), now).sinceIso)
      .toBe('2026-01-01T00:00:00.000Z');
    expect(parseInboxQuery(new URLSearchParams('since=all'), now).sinceIso).toBeUndefined();
    expect(parseInboxQuery(new URLSearchParams('since=0'), now).sinceIso).toBeUndefined();
  });

  test('clamps limit and rejects nonsense', () => {
    expect(parseInboxQuery(new URLSearchParams('limit=99999'), now).limit).toBe(1000);
    expect(parseInboxQuery(new URLSearchParams('limit=all'), now).limit)
      .toBe(Number.POSITIVE_INFINITY);
    expect(() => parseInboxQuery(new URLSearchParams('limit=-2'), now)).toThrow();
    expect(() => parseInboxQuery(new URLSearchParams('limit=1.5'), now)).toThrow();
  });
});

describe('POST /api/works/:id/sessions — subagent inheritance', () => {
  test('carries a linked session\'s subagent descendants into the same Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'ses-parent' });
      const mid = await seedCard(store, {
        title: 'sub', sessionId: 'ses-sub', parentCardId: parent,
      });
      await seedCard(store, {
        title: 'nested', sessionId: 'ses-nested', parentCardId: mid,
      });
      // A sibling session with no lineage must be left alone.
      await seedCard(store, { title: 'other', sessionId: 'ses-other' });

      const work = await workStore.createWork({ title: 'owner' });
      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-parent', 'ses-sub', 'ses-nested', 'ses-other'),
      );

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'ses-parent', role: 'dev' }),
        },
      ));
      expect(res.status).toBe(200);
      const body = await res.json() as Work & { cascadedSessionIds: string[] };
      expect(body.cascadedSessionIds).toEqual(['ses-nested', 'ses-sub']);
      expect(body.sessionLinks.map(l => l.sessionId).sort())
        .toEqual(['ses-nested', 'ses-parent', 'ses-sub']);
      // The role the user picked stays on the session they picked.
      expect(body.sessionLinks.find(l => l.sessionId === 'ses-parent')?.role).toBe('dev');

      expect((await readInbox(handleRequest)).map(s => s.sessionId)).toEqual(['ses-other']);
    });
  });

  test('never steals a subagent session that already belongs to another Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'ses-parent' });
      await seedCard(store, { title: 'sub', sessionId: 'ses-sub', parentCardId: parent });

      const owner = await workStore.createWork({ title: 'owner' });
      const other = await workStore.createWork({ title: 'already has the subagent' });
      await workStore.addSession(other.id, { sessionId: 'ses-sub' });

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-parent', 'ses-sub'),
      );
      const res = await handleRequest(new Request(
        `http://localhost/api/works/${owner.id}/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'ses-parent' }),
        },
      ));
      expect(res.status).toBe(200);
      const body = await res.json() as Work & { cascadedSessionIds: string[] };
      expect(body.cascadedSessionIds).toEqual([]);
      expect(body.sessionLinks.map(l => l.sessionId)).toEqual(['ses-parent']);
      // The 1:N invariant is untouched.
      expect((await workStore.getWork(other.id))?.sessionLinks.map(l => l.sessionId))
        .toEqual(['ses-sub']);
    });
  });

  test('reconcile-subagents adopts orphans left by older data, idempotently', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'ses-parent' });
      await seedCard(store, { title: 'sub', sessionId: 'ses-sub', parentCardId: parent });

      // Linked through the store directly — i.e. the way it looked before the
      // route cascaded.
      const work = await workStore.createWork({ title: 'owner' });
      await workStore.addSession(work.id, { sessionId: 'ses-parent' });

      const { handleRequest } = handlerWith(
        store, workStore, nativeSessions('ses-parent', 'ses-sub'),
      );
      const reconcile = () => handleRequest(new Request(
        'http://localhost/api/works/reconcile-subagents',
        { method: 'POST' },
      ));

      const first = await reconcile();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        linked: [{ workId: work.id, sessionIds: ['ses-sub'] }],
        linkedCount: 1,
      });

      const second = await reconcile();
      expect(await second.json()).toEqual({ linked: [], linkedCount: 0 });
      expect((await workStore.getWork(work.id))?.sessionLinks.map(l => l.sessionId).sort())
        .toEqual(['ses-parent', 'ses-sub']);
    });
  });
});
