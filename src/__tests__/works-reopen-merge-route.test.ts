import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';
import { WORK_NOTES_MAX_LENGTH } from '../core/types';
import type {
  KanbanCard,
  MergeWorkResponse,
  Work,
  WorkReopenResponse,
} from '../core/types';

/**
 * The three escapes a Work had no route to, plus the field it had no room for.
 *
 * - **Reopen.** Completing a Work was a one-way door: `PATCH` took
 *   `status: 'active'` but no UI sent it, the bulk-archived cards stayed in the
 *   monthly files, and `archivedAt` stayed stamped — so the sweep could never run
 *   again either. `DELETE` was the only way out, and it threw the record away.
 * - **Merge.** "These two Works are the same thing" could only be expressed by
 *   moving sessions out one at a time until the source emptied, which *deletes*
 *   the source along with its Summary and its Timeline history.
 * - **Notes.** The only text field on a Work was `summary`, which the Summary LLM
 *   overwrites wholesale — anything a person typed there was destroyed by the
 *   next regeneration.
 * - **List query.** `GET /api/works` filtered on `status` and nothing else, in
 *   one fixed order.
 */
function handlerWith(store: KanbanStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, workStore,
  );
}

type Handle = (req: Request) => Promise<Response>;

function post(handleRequest: Handle, path: string, body?: unknown): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function patch(handleRequest: Handle, path: string, body: unknown): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function get<T>(handleRequest: Handle, path: string): Promise<T> {
  const res = await handleRequest(new Request(`http://localhost${path}`));
  expect(res.status).toBe(200);
  return await res.json() as T;
}

async function seedCard(
  store: KanbanStore,
  input: { title: string; sessionId: string; parentCardId?: string; projectDir?: string },
): Promise<KanbanCard> {
  return store.createCard({
    title: input.title,
    description: '',
    sessionId: input.sessionId,
    projectDir: input.projectDir ?? '/repo',
    parentCardId: input.parentCardId,
  });
}

/** A completed Work: one session, its cards flipped `done` and swept to archive. */
async function completedWork(
  workStore: WorkStore,
  handleRequest: Handle,
  opts: { title: string; sessionId: string },
): Promise<Work> {
  const work = await workStore.createWork({ title: opts.title, projectDir: '/repo' });
  await workStore.addSession(work.id, { sessionId: opts.sessionId, projectDir: '/repo' });
  const res = await patch(handleRequest, `/api/works/${work.id}`, {
    status: 'done',
    confirmArchive: true,
  });
  expect(res.status).toBe(200);
  return await workStore.getWork(work.id) as Work;
}

describe('POST /api/works/:id/reopen', () => {
  test('restores the archived cards, clears archivedAt, and goes back to active', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const first = await seedCard(store, { title: 'swept one', sessionId: 'ses-r' });
      const second = await seedCard(store, { title: 'swept two', sessionId: 'ses-r' });

      const done = await completedWork(workStore, handleRequest, {
        title: 'finished work', sessionId: 'ses-r',
      });
      expect(done.status).toBe('done');
      expect(done.archivedAt).toBeTruthy();
      expect((await store.getCards({})).map(c => c.id)).toEqual([]);

      const res = await post(handleRequest, `/api/works/${done.id}/reopen`);
      expect(res.status).toBe(200);
      const body = await res.json() as WorkReopenResponse;

      expect(body.restoredCardIds.sort()).toEqual([first.id, second.id].sort());
      expect(body.work.status).toBe('active');
      // Every terminal stamp is gone: an `active` bar must not carry an end
      // date, and a leftover `archivedAt` would keep both the sweep and the
      // session-move gate closed for good.
      expect(body.work.resolvedAt).toBeUndefined();
      expect(body.work.resolution).toBeUndefined();
      expect(body.work.archivedAt).toBeUndefined();

      // The cards are back on the board, and out of the archive.
      const board = await store.getCards({});
      expect(board.map(c => c.id).sort()).toEqual([first.id, second.id].sort());
      const months = store.listArchiveMonths();
      for (const month of months) {
        const archive = await store.loadArchiveMonth(month);
        expect(archive?.cards.map(c => c.id) ?? []).toEqual([]);
      }
    });
  });

  test('cards come back `done` — the sweep’s status change is not recoverable', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await seedCard(store, { title: 'was todo', sessionId: 'ses-s' });
      expect(card.status).toBe('todo');

      const done = await completedWork(workStore, handleRequest, {
        title: 'flip work', sessionId: 'ses-s',
      });
      await post(handleRequest, `/api/works/${done.id}/reopen`);

      expect((await store.getCard(card.id))?.status).toBe('done');
    });
  });

  test('a reopened Work can be completed again — the claim is retryable', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await seedCard(store, { title: 'twice swept', sessionId: 'ses-t' });

      const done = await completedWork(workStore, handleRequest, {
        title: 'redo work', sessionId: 'ses-t',
      });
      await post(handleRequest, `/api/works/${done.id}/reopen`);

      const again = await patch(handleRequest, `/api/works/${done.id}`, {
        status: 'done',
        confirmArchive: true,
      });
      expect(again.status).toBe(200);
      expect((await workStore.getWork(done.id))!.archivedAt).toBeTruthy();
      expect((await store.getCards({})).map(c => c.id)).not.toContain(card.id);
    });
  });

  test('a subagent child archived by the cascade comes back with its parent', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'ses-u' });
      // The child's own session is *not* linked to the Work; it reached the
      // archive only because `archiveCards` cascades the subtree. Leaving it
      // behind would strand a child in the archive under a board parent.
      const child = await seedCard(store, {
        title: 'child', sessionId: 'ses-u-child', parentCardId: parent.id,
      });

      const done = await completedWork(workStore, handleRequest, {
        title: 'cascade work', sessionId: 'ses-u',
      });
      const res = await post(handleRequest, `/api/works/${done.id}/reopen`);
      const body = await res.json() as WorkReopenResponse;

      expect(body.restoredCardIds.sort()).toEqual([parent.id, child.id].sort());
      expect((await store.getCards({})).map(c => c.id).sort())
        .toEqual([parent.id, child.id].sort());
    });
  });

  test('409s a Work that is already active, touching nothing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await seedCard(store, { title: 'on the board', sessionId: 'ses-v' });
      const work = await workStore.createWork({ title: 'still going' });
      await workStore.addSession(work.id, { sessionId: 'ses-v' });

      const res = await post(handleRequest, `/api/works/${work.id}/reopen`);
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('already active');
      expect((await store.getCards({})).map(c => c.id)).toEqual([card.id]);
    });
  });

  test('404s an unknown Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const res = await post(handleRequest, '/api/works/nope/reopen');
      expect(res.status).toBe(404);
    });
  });

  test('reopens a discarded Work even though it archived nothing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const card = await seedCard(store, { title: 'kept on board', sessionId: 'ses-w' });
      const work = await workStore.createWork({ title: 'abandoned work' });
      await workStore.addSession(work.id, { sessionId: 'ses-w' });
      await patch(handleRequest, `/api/works/${work.id}`, { status: 'discarded' });

      const res = await post(handleRequest, `/api/works/${work.id}/reopen`);
      expect(res.status).toBe(200);
      const body = await res.json() as WorkReopenResponse;
      expect(body.work.status).toBe('active');
      expect(body.restoredCardIds).toEqual([]);
      expect((await store.getCards({})).map(c => c.id)).toEqual([card.id]);
    });
  });
});

describe('KanbanStore.unarchiveCards — wiki state', () => {
  test('clears a pending stamp, so re-archiving queues the card afresh', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'queued for wiki', description: '', sessionId: 'ses-wiki', projectDir: '/repo',
      });
      await store.updateCard(card.id, { status: 'done' });
      await store.archiveCards([card.id]);
      expect((await store.getCard(card.id, { includeArchived: true }))?.wiki?.status)
        .toBe('pending');

      await store.unarchiveCards([card.id]);

      // `WikiWorker` only ever looks at archived cards, so a `pending` stamp on
      // a board card is a claim nothing can honour — and it would *block*
      // re-queueing, because `archiveCards` only stamps a card with no wiki
      // state at all.
      const restored = await store.getCard(card.id);
      expect(restored?.wiki).toBeUndefined();

      await store.archiveCards([card.id]);
      expect((await store.getCard(card.id, { includeArchived: true }))?.wiki?.status)
        .toBe('pending');
    });
  });

  test('keeps a decided wiki record, so the document is not written twice', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'already documented', description: '', sessionId: 'ses-kept', projectDir: '/repo',
      });
      await store.updateCard(card.id, { status: 'done' });
      await store.archiveCards([card.id]);
      await store.updateArchivedCardsWiki({
        [card.id]: {
          status: 'processed',
          decision: 'kept',
          docPath: 'troubleshooting/x.md',
          queuedAt: new Date().toISOString(),
        },
      });

      await store.unarchiveCards([card.id]);

      const restored = await store.getCard(card.id);
      expect(restored?.wiki?.decision).toBe('kept');
      expect(restored?.wiki?.docPath).toBe('troubleshooting/x.md');
    });
  });

  test('an id that is not in the archive is a no-op, not a duplicate row', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'never archived', description: '', sessionId: 'ses-live', projectDir: '/repo',
      });
      const result = await store.unarchiveCards([card.id, 'ghost']);
      expect(result.restoredCardIds).toEqual([]);
      expect((await store.getCards({})).map(c => c.id)).toEqual([card.id]);
    });
  });

  test('months bounds which archive files are parsed', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'out of window', description: '', sessionId: 'ses-window', projectDir: '/repo',
      });
      await store.updateCard(card.id, { status: 'done' });
      const { archiveMonth } = await store.archiveCards([card.id]);

      const other = await store.unarchiveCards([card.id], { months: ['1999-01'] });
      expect(other.restoredCardIds).toEqual([]);
      expect((await store.getCards({})).map(c => c.id)).toEqual([]);

      const hit = await store.unarchiveCards([card.id], { months: [archiveMonth] });
      expect(hit.restoredCardIds).toEqual([card.id]);
    });
  });
});

describe('PATCH /api/works/:id — notes', () => {
  test('stores, updates and clears the note', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'noted work' });

      let res = await patch(handleRequest, `/api/works/${work.id}`, { notes: '락 순서부터' });
      expect(res.status).toBe(200);
      expect((await res.json() as Work).notes).toBe('락 순서부터');

      res = await patch(handleRequest, `/api/works/${work.id}`, { notes: '다시 정리' });
      expect((await res.json() as Work).notes).toBe('다시 정리');

      res = await patch(handleRequest, `/api/works/${work.id}`, { notes: null });
      expect((await res.json() as Work).notes).toBeUndefined();
    });
  });

  test('an emptied note is no note, not a stored empty string', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'emptied work' });
      await patch(handleRequest, `/api/works/${work.id}`, { notes: 'something' });

      const res = await patch(handleRequest, `/api/works/${work.id}`, { notes: '' });
      expect(res.status).toBe(200);
      expect((await res.json() as Work).notes).toBeUndefined();
    });
  });

  test('a note survives a Summary regeneration — they are different fields', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'both fields' });
      await patch(handleRequest, `/api/works/${work.id}`, { notes: '사람이 쓴 메모' });

      const res = await patch(handleRequest, `/api/works/${work.id}`, {
        summary: { lines: ['LLM이 쓴 줄'], generatedAt: '2026-09-05T00:00:00.000Z', model: 'm' },
      });
      const updated = await res.json() as Work;
      expect(updated.notes).toBe('사람이 쓴 메모');
      expect(updated.summary?.lines).toEqual(['LLM이 쓴 줄']);
    });
  });

  test('400s a non-string note without an internal stack fragment as the message', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'typed work' });

      const res = await patch(handleRequest, `/api/works/${work.id}`, { notes: 7 });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('notes must be a string or null');
    });
  });

  test('400s a note past the documented cap, storing nothing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'long work' });

      const res = await patch(handleRequest, `/api/works/${work.id}`, {
        notes: 'x'.repeat(WORK_NOTES_MAX_LENGTH + 1),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error)
        .toBe(`notes must be at most ${WORK_NOTES_MAX_LENGTH} characters`);
      expect((await workStore.getWork(work.id))!.notes).toBeUndefined();

      const ok = await patch(handleRequest, `/api/works/${work.id}`, {
        notes: 'x'.repeat(WORK_NOTES_MAX_LENGTH),
      });
      expect(ok.status).toBe(200);
    });
  });

  test('rejects a client-set supersededByWorkId — only a merge stamps it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'not merged' });

      const res = await patch(handleRequest, `/api/works/${work.id}`, {
        supersededByWorkId: 'somewhere-else',
      });
      expect(res.status).toBe(400);
      expect((await workStore.getWork(work.id))!.supersededByWorkId).toBeUndefined();
    });
  });
});

describe('GET /api/works — filter and sort', () => {
  async function seedList(workStore: WorkStore): Promise<Record<string, Work>> {
    const alpha = await workStore.createWork({ title: 'wiki 파이프라인', projectDir: '/repo' });
    const beta = await workStore.createWork({ title: 'Timeline 드래그', projectDir: '/other' });
    const gamma = await workStore.createWork({ title: 'wiki 재색인', projectDir: '/repo' });
    // Explicit timestamps: `createWork` stamps `now` and the three land inside
    // the same millisecond often enough to make ordering assertions flaky.
    const state = await workStore.load();
    const at: Record<string, string> = {
      [alpha.id]: '2026-09-01T00:00:00.000Z',
      [beta.id]: '2026-09-05T00:00:00.000Z',
      [gamma.id]: '2026-09-03T00:00:00.000Z',
    };
    for (const work of state.works) work.updatedAt = at[work.id];
    await workStore.save(state);
    return { alpha, beta, gamma };
  }

  test('q filters and sort=stale puts the longest-untouched Work first', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const { alpha, beta, gamma } = await seedList(workStore);

      expect((await get<Work[]>(handleRequest, '/api/works')).map(w => w.id))
        .toEqual([beta.id, gamma.id, alpha.id]);
      expect((await get<Work[]>(handleRequest, '/api/works?sort=stale')).map(w => w.id))
        .toEqual([alpha.id, gamma.id, beta.id]);
      expect((await get<Work[]>(handleRequest, '/api/works?q=wiki')).map(w => w.id))
        .toEqual([gamma.id, alpha.id]);
      expect((await get<Work[]>(handleRequest, '/api/works?projectDir=%2Fother')).map(w => w.id))
        .toEqual([beta.id]);
      expect((await get<Work[]>(handleRequest, '/api/works?q=wiki&sort=stale')).map(w => w.id))
        .toEqual([alpha.id, gamma.id]);
    });
  });

  test('sort=planned orders by the planned end, undated last', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const soon = await workStore.createWork({ title: 'due soon' });
      const later = await workStore.createWork({ title: 'due later' });
      const undated = await workStore.createWork({ title: 'no plan' });
      await patch(handleRequest, `/api/works/${soon.id}`, { resolvedAt: '2026-09-11T00:00:00.000Z' });
      await patch(handleRequest, `/api/works/${later.id}`, { resolvedAt: '2026-09-20T00:00:00.000Z' });

      expect((await get<Work[]>(handleRequest, '/api/works?sort=planned')).map(w => w.id))
        .toEqual([soon.id, later.id, undated.id]);
    });
  });

  test('400s an unknown sort instead of quietly returning the default order', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request('http://localhost/api/works?sort=recent'));
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('Invalid sort');
    });
  });
});

describe('POST /api/works/:id/merge', () => {
  async function twoWorks(store: KanbanStore, workStore: WorkStore) {
    // The source's session ran first, so the merge must pull the target's bar
    // left — that recalculation is the whole reason `startedAt` is derived.
    const early = await store.createCard({
      title: 'early card', description: '', sessionId: 'ses-a', projectDir: '/repo',
    });
    await store.updateCard(early.id, { startedAt: '2026-08-26T03:00:00.000Z' });
    const late = await store.createCard({
      title: 'late card', description: '', sessionId: 'ses-b', projectDir: '/repo',
    });
    await store.updateCard(late.id, { startedAt: '2026-09-02T03:00:00.000Z' });

    const source = await workStore.createWork({
      title: 'duplicate work', projectDir: '/repo', startedAt: '2026-08-26T03:00:00.000Z',
    });
    await workStore.addSession(source.id, { sessionId: 'ses-a', role: 'dev' });
    const target = await workStore.createWork({
      title: 'real work', projectDir: '/repo', startedAt: '2026-09-02T03:00:00.000Z',
    });
    await workStore.addSession(target.id, { sessionId: 'ses-b', role: 'review' });
    return { source, target };
  }

  test('moves the links, keeps the role, and pulls the target’s startedAt left', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const { source, target } = await twoWorks(store, workStore);

      const res = await post(handleRequest, `/api/works/${source.id}/merge`, {
        intoWorkId: target.id,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as MergeWorkResponse;

      expect(body.movedSessionIds).toEqual(['ses-a']);
      expect(body.skippedSessionIds).toEqual([]);
      expect(body.to.sessionLinks.map(l => l.sessionId).sort()).toEqual(['ses-a', 'ses-b']);
      // The travelling link keeps the role it carried.
      expect(body.to.sessionLinks.find(l => l.sessionId === 'ses-a')?.role).toBe('dev');
      expect(body.to.startedAt).toBe('2026-08-26T03:00:00.000Z');

      // The source is closed, not deleted: its title, Summary and Timeline
      // history are the record of real work, and it now says where it went.
      expect(body.from.status).toBe('discarded');
      expect(body.from.resolution).toBe('superseded');
      expect(body.from.supersededByWorkId).toBe(target.id);
      expect(body.from.resolvedAt).toBeTruthy();
      expect(body.from.sessionLinks).toEqual([]);
      expect(await workStore.getWork(source.id)).not.toBeNull();
    });
  });

  test('the 1:N invariant holds — a moved session is in exactly one Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const { source, target } = await twoWorks(store, workStore);
      await post(handleRequest, `/api/works/${source.id}/merge`, { intoWorkId: target.id });

      const owners = (await workStore.load()).works
        .filter(w => w.sessionLinks.some(l => l.sessionId === 'ses-a'));
      expect(owners.map(w => w.id)).toEqual([target.id]);
    });
  });

  test('a session the target already holds is skipped, target’s link wins', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      // The same session cannot be in two Works (the store forbids it), so the
      // duplicate is constructed directly in the file — which is also the only
      // way it happens in the wild.
      const source = await workStore.createWork({ title: 'dup source' });
      const target = await workStore.createWork({ title: 'dup target' });
      const state = await workStore.load();
      const linkedAt = '2026-09-01T00:00:00.000Z';
      state.works.find(w => w.id === source.id)!.sessionLinks = [
        { sessionId: 'ses-dup', linkedAt, role: 'dev' },
        { sessionId: 'ses-only', linkedAt, role: 'debug' },
      ];
      state.works.find(w => w.id === target.id)!.sessionLinks = [
        { sessionId: 'ses-dup', linkedAt, role: 'review' },
      ];
      await workStore.save(state);

      const res = await post(handleRequest, `/api/works/${source.id}/merge`, {
        intoWorkId: target.id,
      });
      const body = await res.json() as MergeWorkResponse;

      expect(body.movedSessionIds).toEqual(['ses-only']);
      expect(body.skippedSessionIds).toEqual(['ses-dup']);
      expect(body.to.sessionLinks).toHaveLength(2);
      // The surviving record's own link is untouched — re-parenting the
      // source's copy over it would silently rewrite the role being kept.
      expect(body.to.sessionLinks.find(l => l.sessionId === 'ses-dup')?.role).toBe('review');
    });
  });

  test('400s a merge into itself', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'lonely' });

      const res = await post(handleRequest, `/api/works/${work.id}/merge`, {
        intoWorkId: work.id,
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('into itself');
      expect((await workStore.getWork(work.id))!.status).toBe('active');
    });
  });

  test('400s a missing intoWorkId, 404s an unknown one', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const work = await workStore.createWork({ title: 'source' });

      expect((await post(handleRequest, `/api/works/${work.id}/merge`, {})).status).toBe(400);
      expect((await post(handleRequest, `/api/works/${work.id}/merge`, {
        intoWorkId: '  ',
      })).status).toBe(400);
      expect((await post(handleRequest, `/api/works/${work.id}/merge`, {
        intoWorkId: 'ghost',
      })).status).toBe(404);
      expect((await workStore.getWork(work.id))!.status).toBe('active');
    });
  });

  test('409s when either side has already been bulk-archived', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      await seedCard(store, { title: 'swept', sessionId: 'ses-done' });
      const archived = await completedWork(workStore, handleRequest, {
        title: 'archived work', sessionId: 'ses-done',
      });
      const active = await workStore.createWork({ title: 'active work' });

      // Into an archived Work: its cards are already in the wiki pipeline, so
      // regrouping them now rewrites a document that has shipped.
      let res = await post(handleRequest, `/api/works/${active.id}/merge`, {
        intoWorkId: archived.id,
      });
      expect(res.status).toBe(409);
      // …and out of one, for the same reason.
      res = await post(handleRequest, `/api/works/${archived.id}/merge`, {
        intoWorkId: active.id,
      });
      expect(res.status).toBe(409);
      expect((await workStore.getWork(archived.id))!.status).toBe('done');
    });
  });

  test('a merged-away Work can be reopened, which drops the superseded pointer', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);
      const { source, target } = await twoWorks(store, workStore);
      await post(handleRequest, `/api/works/${source.id}/merge`, { intoWorkId: target.id });

      const res = await post(handleRequest, `/api/works/${source.id}/reopen`);
      expect(res.status).toBe(200);
      const body = await res.json() as WorkReopenResponse;
      expect(body.work.status).toBe('active');
      expect(body.work.resolution).toBeUndefined();
      // The pointer claimed this Work had been replaced; it has not been.
      expect(body.work.supersededByWorkId).toBeUndefined();
    });
  });
});
