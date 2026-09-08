import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { SettingsStore } from '../core/settings-store';
import { WikiWorker, groupCardsBySession, type WorkSessionIndex } from '../plugin/wiki/wiki-worker';
import { WIKI_SETTING_KEYS } from '../plugin/wiki/wiki-config';
import {
  applyWorkPatch,
  buildWorkCompletionPreview,
  resolveSessionStartedAt,
  createWorkStartedAtResolver,
  resolveWorkStartedAt,
  selectWorkCards,
} from '../plugin/works/work-lifecycle';
import { WorkCardsRunningError } from '../core/work-errors';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { saveWorksConfig } from '../plugin/works/works-config';
import { createRouteHandler, type DispatchFn } from '../server/routes';
import { createTestCard, withTempDir } from './setup';
import type {
  KanbanCard,
  Work,
  WorkBatchAddSessionsResponse,
  WorkCompletionPreview,
  WorkLinkReconcileReport,
  WorkPatchResponse,
  WorkPruneSessionsResponse,
  WorkSessionsResponse,
} from '../core/types';

/** createRouteHandler with only settingsStore (pos 5) + workStore (pos 22) wired. */
function handlerWith(store: KanbanStore, settingsStore: SettingsStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, settingsStore, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

/** Same, plus the RuntimeRunStore (pos 18) that backs the running-card guard. */
function handlerWithRuns(
  store: KanbanStore,
  settingsStore: SettingsStore,
  workStore: WorkStore,
  runStore: RuntimeRunStore,
) {
  return createRouteHandler(
    store, undefined, undefined, undefined, settingsStore, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, runStore, undefined, undefined, undefined,
    workStore,
  );
}

async function seedCard(
  store: KanbanStore,
  input: { title: string; sessionId?: string; status?: KanbanCard['status'] },
): Promise<KanbanCard> {
  const card = await store.createCard({
    title: input.title,
    description: `${input.title} desc`,
    sessionId: input.sessionId,
  });
  if (input.status && input.status !== 'todo') {
    return store.updateCard(card.id, { status: input.status });
  }
  return card;
}

async function seedWork(workStore: WorkStore, title: string, sessionIds: string[]): Promise<Work> {
  const work = await workStore.createWork({ title });
  for (const sessionId of sessionIds) {
    await workStore.addSession(work.id, { sessionId });
  }
  return (await workStore.getWork(work.id))!;
}

describe('Work completion lifecycle', () => {
  test('done flips every linked card to done and archives them wiki-pending', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);

      const a = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const b = await seedCard(store, { title: 'B', sessionId: 's2' });
      // An unrelated done card must survive the sweep.
      const outsider = await seedCard(store, { title: 'X', sessionId: 's9', status: 'done' });

      const work = await seedWork(workStore, 'Works 탭 구현', ['s1', 's2']);
      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
      });

      expect(result.archiveSkipped).toBeUndefined();
      expect(result.archivedCount).toBe(2);
      expect([...result.completedCardIds].sort()).toEqual([a.id, b.id].sort());
      expect(result.work.status).toBe('done');
      expect(result.work.resolution).toBe('completed');
      expect(result.work.resolvedAt).toBeTruthy();
      expect(result.work.archivedAt).toBeTruthy();

      expect((await store.getCards()).map(c => c.id)).toEqual([outsider.id]);

      const archived = await store.getCards({ includeArchived: true });
      for (const id of [a.id, b.id]) {
        const card = archived.find(c => c.id === id)!;
        expect(card.status).toBe('done');
        expect(card.wiki?.status).toBe('pending');
      }
    });
  });

  test('a Work with no linked cards never sweeps the rest of the board', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      // archiveCards([]) means "archive every done card"; the lifecycle must
      // never reach it with an empty seed list.
      const unrelated = await seedCard(store, { title: 'unrelated', sessionId: 's9', status: 'done' });
      const work = await seedWork(workStore, 'empty work', []);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
      });

      expect(result.archiveSkipped).toBe('no-cards');
      expect(result.archivedCount).toBe(0);
      expect(result.work.status).toBe('done');
      expect((await store.getCards()).map(c => c.id)).toEqual([unrelated.id]);
    });
  });

  test('works.done_confirm defers the sweep until the client confirms', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const card = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'confirm me', ['s1']);

      const deferred = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: true,
      });
      expect(deferred.archiveSkipped).toBe('awaiting-confirmation');
      expect(deferred.work.status).toBe('done');
      expect(deferred.work.resolvedAt).toBeTruthy();
      expect(deferred.work.archivedAt).toBeUndefined();
      // Card untouched: still on the board, still in_progress.
      expect((await store.getCards()).map(c => c.status)).toEqual(['in_progress']);

      const confirmed = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: true,
        confirmArchive: true,
      });
      expect(confirmed.archivedCount).toBe(1);
      expect(confirmed.work.archivedAt).toBeTruthy();
      expect(await store.getCards()).toEqual([]);

      const archived = await store.getCards({ includeArchived: true });
      expect(archived.find(c => c.id === card.id)?.wiki?.status).toBe('pending');
    });
  });

  test('a repeated done patch is idempotent and does not re-sweep', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'A', sessionId: 's1' });
      const work = await seedWork(workStore, 'once', ['s1']);

      const first = await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });
      expect(first.archivedCount).toBe(1);

      // A late-arriving second card of the same session must not be swept by a
      // duplicate patch — the Work is already archived.
      const late = await seedCard(store, { title: 'late', sessionId: 's1', status: 'done' });
      const second = await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });
      expect(second.archiveSkipped).toBe('already-archived');
      expect(second.archivedCount).toBe(0);
      expect(second.work.archivedAt).toBe(first.work.archivedAt);
      expect((await store.getCards()).map(c => c.id)).toEqual([late.id]);
    });
  });

  test('discard records resolvedAt/resolution and archives nothing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      await seedCard(store, { title: 'B', sessionId: 's1', status: 'done' });
      const work = await seedWork(workStore, 'abandoned work', ['s1']);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'discarded' },
        doneConfirm: false,
      });

      expect(result.archiveSkipped).toBe('not-a-completion');
      expect(result.archivedCount).toBe(0);
      expect(result.work.status).toBe('discarded');
      expect(result.work.resolution).toBe('abandoned');
      expect(result.work.resolvedAt).toBeTruthy();  // Timeline bar ends here
      expect(result.work.archivedAt).toBeUndefined();
      // Cards stay on the board, untouched.
      expect((await store.getCards()).map(c => c.status).sort()).toEqual(['done', 'in_progress']);
    });
  });

  test('re-opening a Work clears the terminal stamps', async () => {
    await withTempDir(async (dir) => {
      const workStore = new WorkStore(dir);
      const work = await seedWork(workStore, 'reopened', ['s1']);
      const discarded = await workStore.updateWork(work.id, { status: 'discarded' });
      expect(discarded.resolvedAt).toBeTruthy();

      const reopened = await workStore.updateWork(work.id, { status: 'active' });
      expect(reopened.resolvedAt).toBeUndefined();
      expect(reopened.resolution).toBeUndefined();
    });
  });

  test('selectWorkCards only matches cards of the Work’s linked sessions', async () => {
    const cards = [
      createTestCard({ id: '1', sessionId: 's1' }),
      createTestCard({ id: '2', sessionId: 's2' }),
      createTestCard({ id: '3', sessionId: 'other' }),
      createTestCard({ id: '4' }), // sessionless
    ];
    const work: Work = {
      id: 'w1', title: 'W', status: 'active',
      sessionLinks: [
        { sessionId: 's1', linkedAt: '2026-01-01' },
        { sessionId: 's2', linkedAt: '2026-01-01' },
      ],
      startedAt: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    expect(selectWorkCards(cards, work).map(c => c.id)).toEqual(['1', '2']);
  });

  test('PATCH /api/works/:id keeps its endpoint and honours works.done_confirm', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      await saveWorksConfig(settingsStore, { doneConfirm: true });
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'via route', ['s1']);
      const patch = (body: unknown) => handleRequest(new Request(
        `http://localhost/api/works/${work.id}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ));

      const deferred = await patch({ status: 'done' }) ;
      const deferredWork = await deferred.json() as Work;
      expect(deferred.status).toBe(200);
      expect(deferredWork.status).toBe('done');
      expect(deferredWork.archivedAt).toBeUndefined();
      expect((await store.getCards()).length).toBe(1);

      const confirmed = await patch({ status: 'done', confirmArchive: true });
      const confirmedWork = await confirmed.json() as Work;
      expect(confirmedWork.archivedAt).toBeTruthy();
      expect(await store.getCards()).toEqual([]);
    });
  });
});

/** A bare `Work` for the pure `resolveWorkStartedAt` tests. */
function workWith(
  links: Array<{ sessionId: string; linkedAt?: string }>,
  startedAt: string,
): Work {
  return {
    id: 'w-pure',
    title: 'W',
    status: 'active',
    sessionLinks: links.map(l => ({
      sessionId: l.sessionId,
      linkedAt: l.linkedAt ?? '2026-09-03T00:00:00.000Z',
    })),
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

/** Archives a card the way the board does: flip to done, then sweep it. */
async function archiveCard(store: KanbanStore, cardId: string): Promise<void> {
  await store.updateCard(cardId, { status: 'done' });
  await store.archiveCards([cardId]);
}

describe('Work startedAt recalculation', () => {
  test('resolveSessionStartedAt picks the session’s earliest start', () => {
    const cards = [
      createTestCard({ sessionId: 's1', startedAt: '2026-08-02T00:00:00.000Z' }),
      createTestCard({ sessionId: 's1', startedAt: '2026-08-01T00:00:00.000Z' }),
      createTestCard({ sessionId: 's2', startedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    expect(resolveSessionStartedAt(cards, 's1')).toBe('2026-08-01T00:00:00.000Z');
    expect(resolveSessionStartedAt(cards, 'missing')).toBeUndefined();
  });

  test('resolveSessionStartedAt falls back to createdAt for never-dispatched cards', () => {
    const cards = [createTestCard({ sessionId: 's1', createdAt: '2026-06-01T00:00:00.000Z' })];
    expect(resolveSessionStartedAt(cards, 's1')).toBe('2026-06-01T00:00:00.000Z');
  });

  test('resolveWorkStartedAt is min() across every linked session', () => {
    const cards = [
      createTestCard({ sessionId: 's1', startedAt: '2026-09-03T00:00:00.000Z' }),
      createTestCard({ sessionId: 's2', startedAt: '2026-09-01T00:00:00.000Z' }),
      // An unlinked session must not drag the start earlier.
      createTestCard({ sessionId: 's9', startedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const work = workWith([{ sessionId: 's1' }, { sessionId: 's2' }], '2026-09-03T00:00:00.000Z');
    expect(resolveWorkStartedAt(cards, work)).toBe('2026-09-01T00:00:00.000Z');
  });

  test('resolveWorkStartedAt falls back to linkedAt for a session with no cards', () => {
    const cardless = workWith(
      [{ sessionId: 's1', linkedAt: '2026-09-02T00:00:00.000Z' }],
      '2026-09-03T00:00:00.000Z',
    );
    expect(resolveWorkStartedAt([], cardless)).toBe('2026-09-02T00:00:00.000Z');

    // The fallback still loses to an older link that does have cards.
    const mixed = workWith(
      [
        { sessionId: 's1', linkedAt: '2026-09-02T00:00:00.000Z' },
        { sessionId: 's2', linkedAt: '2026-09-02T00:00:00.000Z' },
      ],
      '2026-09-03T00:00:00.000Z',
    );
    const cards = [createTestCard({ sessionId: 's2', startedAt: '2026-08-20T00:00:00.000Z' })];
    expect(resolveWorkStartedAt(cards, mixed)).toBe('2026-08-20T00:00:00.000Z');
  });

  test('resolveWorkStartedAt keeps the current date for a Work with no links', () => {
    const work = workWith([], '2026-09-03T00:00:00.000Z');
    expect(resolveWorkStartedAt([], work)).toBe('2026-09-03T00:00:00.000Z');
  });

  test('every link applies the recalculated startedAt, not just the first', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const work = await workStore.createWork({ title: 'W' });

      const s1 = await seedCard(store, { title: 's1', sessionId: 's1' });
      await store.updateCard(s1.id, { startedAt: '2026-08-01T00:00:00.000Z' });
      const s2 = await seedCard(store, { title: 's2', sessionId: 's2' });
      await store.updateCard(s2.id, { startedAt: '2026-07-01T00:00:00.000Z' });
      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));

      const first = await workStore.addSession(work.id, { sessionId: 's1' }, resolve);
      expect(first.startedAt).toBe('2026-08-01T00:00:00.000Z');

      // Second link resolved to an earlier min() — the bar must move left.
      const second = await workStore.addSession(work.id, { sessionId: 's2' }, resolve);
      expect(second.startedAt).toBe('2026-07-01T00:00:00.000Z');

      // Unlinking the oldest hands back a later min().
      const removed = await workStore.removeSession(work.id, 's2', resolve);
      expect(removed.startedAt).toBe('2026-08-01T00:00:00.000Z');

      // No resolver → the stored date is left untouched.
      const untouched = await workStore.addSession(work.id, { sessionId: 's3' });
      expect(untouched.startedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  test('createWorkStartedAtResolver answers min() for the link set it is given', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);

      const late = await seedCard(store, { title: 'late', sessionId: 's1' });
      await store.updateCard(late.id, { startedAt: '2026-09-03T00:00:00.000Z' });
      const early = await seedCard(store, { title: 'early', sessionId: 's2' });
      await store.updateCard(early.id, { startedAt: '2026-09-01T00:00:00.000Z' });

      const created = await workStore.createWork({ title: 'W' });
      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      await workStore.addSession(created.id, { sessionId: 's1' }, resolve);
      const work = (await workStore.getWork(created.id))!;
      expect(work.startedAt).toBe('2026-09-03T00:00:00.000Z');

      // The resolver reads the *given* link set, which is what makes it safe to
      // run inside the store's lock against the links the write just produced.
      expect(await resolve({ ...work, sessionLinks: [
        ...work.sessionLinks,
        { sessionId: 's2', linkedAt: '2026-09-05T00:00:00.000Z' },
      ] })).toBe('2026-09-01T00:00:00.000Z');
      expect(await resolve({ ...work, sessionLinks: [] })).toBe(work.startedAt);
    });
  });

  test('POST /api/works/:id/sessions back-dates startedAt from the session cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const card = await seedCard(store, { title: 'A', sessionId: 's1' });
      await store.updateCard(card.id, { startedAt: '2026-08-01T00:00:00.000Z' });
      const work = await workStore.createWork({ title: 'W' });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 's1' }),
        },
      ));
      const linked = await res.json() as Work;
      expect(res.status).toBe(200);
      expect(linked.startedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  test('a later link to an older session pulls the Timeline bar left, and unlinking pushes it back', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const late = await seedCard(store, { title: 'late', sessionId: 's-late' });
      await store.updateCard(late.id, { startedAt: '2026-09-03T09:00:00.000Z' });
      const early = await seedCard(store, { title: 'early', sessionId: 's-early' });
      await store.updateCard(early.id, { startedAt: '2026-09-01T09:00:00.000Z' });

      const work = await workStore.createWork({ title: 'W' });
      const link = (sessionId: string) => handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        },
      ));

      const first = await link('s-late');
      expect((await first.json() as Work).startedAt).toBe('2026-09-03T09:00:00.000Z');

      // The regression: a *second* link to an older session used to leave the bar
      // stuck on the triage date.
      const second = await link('s-early');
      expect((await second.json() as Work).startedAt).toBe('2026-09-01T09:00:00.000Z');

      const removed = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions/s-early`,
        { method: 'DELETE' },
      ));
      expect(removed.status).toBe(200);
      expect((await removed.json() as Work).startedAt).toBe('2026-09-03T09:00:00.000Z');
    });
  });

  test('archived cards count, and a card-less session falls back to its link time', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const closed = await seedCard(store, { title: 'closed out', sessionId: 's-archived' });
      await store.updateCard(closed.id, { startedAt: '2026-08-20T09:00:00.000Z' });
      await archiveCard(store, closed.id);
      expect(await store.getCards()).toHaveLength(0);

      const work = await workStore.createWork({ title: 'W' });
      const link = (sessionId: string) => handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        },
      ));

      // A session with no cards at all: the link time is the only signal.
      const cardless = await link('s-cardless');
      const afterCardless = await cardless.json() as Work;
      expect(new Date(afterCardless.startedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

      const archived = await link('s-archived');
      expect((await archived.json() as Work).startedAt).toBe('2026-08-20T09:00:00.000Z');
    });
  });
});

/**
 * Making the bulk done→archive sweep safe.
 *
 * Completing a Work is an irreversible mass mutation, and every defect fixed
 * here made it *quietly* wrong: it archived cards out from under running
 * agents, it reported a partly-failed sweep as `404 Work not found`, it left a
 * confirmation-deferred Work permanently unsweepable, and two concurrent
 * patches both ran it.
 */
describe('Work completion safety', () => {
  /** An `ActiveRunProbe` that reports exactly `running` as busy. */
  const probeFor = (running: string[]) =>
    async (cardIds: string[]) => cardIds.filter(id => running.includes(id));

  test('a card with a live agent run blocks the whole completion', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const busy = await seedCard(store, { title: 'still running', sessionId: 's1', status: 'in_progress' });
      const idle = await seedCard(store, { title: 'finished', sessionId: 's1', status: 'complete' });
      const work = await seedWork(workStore, 'has a live agent', ['s1']);

      const failure = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
        activeRunProbe: probeFor([busy.id]),
      }).then(() => null, (e: unknown) => e);

      expect(failure).toBeInstanceOf(WorkCardsRunningError);
      expect((failure as WorkCardsRunningError).runningCardIds).toEqual([busy.id]);

      // A refusal, not a partial completion: nothing was recorded at all.
      const after = (await workStore.getWork(work.id))!;
      expect(after.status).toBe('active');
      expect(after.archivedAt).toBeUndefined();
      expect(after.resolvedAt).toBeUndefined();
      const board = await store.getCards();
      expect(board.map(c => c.id).sort()).toEqual([busy.id, idle.id].sort());
      expect(board.find(c => c.id === idle.id)?.status).toBe('complete');
    });
  });

  test('the guard only looks at this Work’s own cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const mine = await seedCard(store, { title: 'mine', sessionId: 's1', status: 'complete' });
      const theirs = await seedCard(store, { title: 'someone else running', sessionId: 's9', status: 'in_progress' });
      const work = await seedWork(workStore, 'unrelated run', ['s1']);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
        activeRunProbe: probeFor([theirs.id]),
      });

      expect(result.archivedCount).toBe(1);
      expect(result.archiveSeedIds).toEqual([mine.id]);
      expect((await store.getCards()).map(c => c.id)).toEqual([theirs.id]);
    });
  });

  test('PATCH /api/works/:id answers 409 with the running card ids', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const { handleRequest } = handlerWithRuns(store, settingsStore, workStore, runStore);

      const busy = await seedCard(store, { title: 'running', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'route guard', ['s1']);
      const run = await runStore.createRun({
        cardId: busy.id, runtime: 'claude', cwd: dir,
      });
      await runStore.updateRun(run.runId, { status: 'running' });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', confirmArchive: true }),
        },
      ));
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string; runningCardIds: string[] };
      expect(body.runningCardIds).toEqual([busy.id]);
      expect(body.error).toContain('running agent');
      expect((await workStore.getWork(work.id))!.status).toBe('active');

      // Once the run is over the same request goes through.
      await runStore.finishRun(run.runId, { status: 'completed', exitCode: 0 });
      const retry = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', confirmArchive: true }),
        },
      ));
      expect(retry.status).toBe(200);
      expect((await retry.json() as Work).archivedAt).toBeTruthy();
    });
  });

  test('a card that vanishes mid-sweep is reported, not disguised as a missing Work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const survivor = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const doomed = await seedCard(store, { title: 'B', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'partial sweep', ['s1']);

      // The card is deleted between the sweep's read and its write. The store
      // reports that as `Card not found: <id>` — which the route used to
      // substring-match into `404 Work not found`.
      const realUpdate = store.updateCard.bind(store);
      store.updateCard = ((id: string, input: Parameters<KanbanStore['updateCard']>[1]) => (
        id === doomed.id
          ? Promise.reject(new Error(`Card not found: ${id}`))
          : realUpdate(id, input)
      )) as KanbanStore['updateCard'];

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', confirmArchive: true }),
        },
      ));
      store.updateCard = realUpdate;

      expect(res.status).toBe(200);
      const body = await res.json() as Work & {
        sweep?: { archivedCount: number; failed: { cardId: string; message: string }[] };
      };
      expect(body.status).toBe('done');
      expect(body.sweep?.archivedCount).toBe(1);
      expect(body.sweep?.failed.map(f => f.cardId)).toEqual([doomed.id]);
      expect(body.sweep?.failed[0].message).toContain('Card not found');

      // The Work's own state agrees with the response: it did archive, so it is
      // stamped, and the one card that failed is still on the board.
      expect(body.archivedAt).toBeTruthy();
      expect((await workStore.getWork(work.id))!.archivedAt).toBe(body.archivedAt);
      expect((await store.getCards()).map(c => c.id)).toEqual([doomed.id]);
      expect((await store.getCards({ includeArchived: true }))
        .find(c => c.id === survivor.id)?.status).toBe('done');
    });
  });

  test('a sweep that archives nothing rolls its own stamp back', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const only = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'total failure', ['s1']);

      const realUpdate = store.updateCard.bind(store);
      store.updateCard = (() => Promise.reject(new Error(`Card not found: ${only.id}`))
      ) as KanbanStore['updateCard'];
      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
      });
      store.updateCard = realUpdate;

      expect(result.archivedCount).toBe(0);
      expect(result.failedCards.map(f => f.cardId)).toEqual([only.id]);
      // No `archivedAt`: the Work must not advertise an archive that did not
      // happen, and it has to stay retryable.
      expect(result.work.archivedAt).toBeUndefined();
      expect((await workStore.getWork(work.id))!.archivedAt).toBeUndefined();

      const retry = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
      });
      expect(retry.archivedCount).toBe(1);
      expect(retry.work.archivedAt).toBeTruthy();
    });
  });

  test('a confirmation-deferred Work finishes on a confirm-only patch', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const card = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'deferred', ['s1']);

      const deferred = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: true,
      });
      expect(deferred.archiveSkipped).toBe('awaiting-confirmation');
      expect(deferred.work.archivedAt).toBeUndefined();

      // The client now sends only the flag — no `status`, because the Work is
      // already `done`. This used to be classified `not-a-completion`, which
      // made the deferred state a dead end the sweep could never leave.
      const confirmed = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: {},
        doneConfirm: true,
        confirmArchive: true,
      });
      expect(confirmed.archiveSkipped).toBeUndefined();
      expect(confirmed.archivedCount).toBe(1);
      expect(confirmed.work.archivedAt).toBeTruthy();
      expect(await store.getCards()).toEqual([]);
      expect((await store.getCards({ includeArchived: true }))
        .find(c => c.id === card.id)?.wiki?.status).toBe('pending');
    });
  });

  test('a confirm-only patch on an active Work is still not a completion', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'never asked', ['s1']);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id,
        updates: {},
        doneConfirm: true,
        confirmArchive: true,
      });
      expect(result.archiveSkipped).toBe('not-a-completion');
      expect(result.work.status).toBe('active');
      expect((await store.getCards()).length).toBe(1);
    });
  });

  test('a session cannot be moved out of a Work whose sweep is still deferred', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      await saveWorksConfig(settingsStore, { doneConfirm: true });
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const source = await seedWork(workStore, 'completing source', ['s1']);
      const target = await seedWork(workStore, 'open target', []);

      // `done` with the sweep deferred: no `archivedAt`, so the old gate (which
      // only looked at `archivedAt`) waved this through and let a session be
      // regrouped out from under an archive that was about to run.
      await applyWorkPatch({
        store, workStore, workId: source.id, updates: { status: 'done' }, doneConfirm: true,
      });
      expect((await workStore.getWork(source.id))!.archivedAt).toBeUndefined();

      const res = await handleRequest(new Request(
        'http://localhost/api/works/sessions/s1',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toWorkId: target.id }),
        },
      ));
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('completing source');
      // The link never moved.
      expect((await workStore.getWork(source.id))!.sessionLinks).toHaveLength(1);
      expect((await workStore.getWork(target.id))!.sessionLinks).toHaveLength(0);
    });
  });

  test('two concurrent done patches archive exactly once', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const a = await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const b = await seedCard(store, { title: 'B', sessionId: 's2', status: 'in_progress' });
      const work = await seedWork(workStore, 'double click', ['s1', 's2']);

      const patch = () => applyWorkPatch({
        store, workStore, workId: work.id,
        updates: { status: 'done' },
        doneConfirm: false,
      });
      const [first, second] = await Promise.all([patch(), patch()]);

      const outcomes = [first, second];
      const swept = outcomes.filter(r => r.archiveSkipped === undefined);
      const skipped = outcomes.filter(r => r.archiveSkipped === 'already-archived');
      expect(swept).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(swept[0].archivedCount).toBe(2);
      // The loser stopped at the claim — it never touched a card, so it has no
      // spurious `Card not found` failures from sweeping an emptied board.
      expect(skipped[0].failedCards).toEqual([]);
      expect(swept[0].failedCards).toEqual([]);

      expect(await store.getCards()).toEqual([]);
      const archived = await store.getCards({ includeArchived: true });
      expect(archived.filter(c => [a.id, b.id].includes(c.id))).toHaveLength(2);
    });
  });
});

describe('Work completion preview', () => {
  test('buildWorkCompletionPreview counts live and archived cards per status', () => {
    const work: Work = {
      id: 'w1', title: 'W', status: 'active',
      sessionLinks: [
        { sessionId: 's1', linkedAt: '2026-01-01' },
        { sessionId: 's2', linkedAt: '2026-01-01' },
      ],
      startedAt: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    const cards = [
      createTestCard({ id: 'live-todo', sessionId: 's1', status: 'todo' }),
      createTestCard({ id: 'live-run', sessionId: 's1', status: 'in_progress' }),
      createTestCard({ id: 'gone-done', sessionId: 's2', status: 'done' }),
      createTestCard({ id: 'outsider', sessionId: 's9', status: 'done' }),
      // The sweep raced the read: this card is in the board list *and* in an
      // archive month. It must be counted once.
      createTestCard({ id: 'live-todo', sessionId: 's1', status: 'done' }),
    ];

    const preview = buildWorkCompletionPreview(work, cards, {
      archivedCardIds: new Set(['gone-done']),
      runningCardIds: ['live-run'],
      scannedMonths: ['2026-01'],
    });

    expect(preview.workId).toBe('w1');
    expect(preview.cardCount).toBe(3);          // the outsider is not counted
    expect(preview.sweepCardCount).toBe(2);     // the archived one is already gone
    expect(preview.byStatus).toEqual({ todo: 1, in_progress: 1, complete: 0, done: 1 });
    expect(preview.runningCardIds).toEqual(['live-run']);
    expect(preview.sessionCount).toBe(2);
    expect(preview.alreadyArchived).toBe(false);
    expect(preview.scannedMonths).toEqual(['2026-01']);
  });

  test('GET /api/works/:id/completion-preview reports the archive and the live runs', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const { handleRequest } = handlerWithRuns(store, settingsStore, workStore, runStore);

      const gone = await seedCard(store, { title: 'already archived', sessionId: 's1' });
      await archiveCard(store, gone.id);
      const busy = await seedCard(store, { title: 'running', sessionId: 's1', status: 'in_progress' });
      await seedCard(store, { title: 'waiting', sessionId: 's1', status: 'todo' });
      // Another Work's card must not leak into the counts.
      await seedCard(store, { title: 'outsider', sessionId: 's9', status: 'todo' });

      const work = await seedWork(workStore, 'preview me', ['s1']);
      const run = await runStore.createRun({ cardId: busy.id, runtime: 'claude', cwd: dir });
      await runStore.updateRun(run.runId, { status: 'running' });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/completion-preview`,
      ));
      expect(res.status).toBe(200);
      const preview = await res.json() as WorkCompletionPreview;
      expect(preview.workId).toBe(work.id);
      expect(preview.cardCount).toBe(3);
      expect(preview.sweepCardCount).toBe(2);
      expect(preview.byStatus).toEqual({ todo: 1, in_progress: 1, complete: 0, done: 1 });
      expect(preview.runningCardIds).toEqual([busy.id]);
      expect(preview.sessionCount).toBe(1);
      expect(preview.alreadyArchived).toBe(false);
    });
  });

  test('completion-preview 404s an unknown Work and 503s without a work store', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const withWorks = handlerWith(store, settingsStore, workStore);
      const missing = await withWorks.handleRequest(new Request(
        'http://localhost/api/works/nope/completion-preview',
      ));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'Work not found' });

      const bare = createRouteHandler(store);
      const unavailable = await bare.handleRequest(new Request(
        'http://localhost/api/works/nope/completion-preview',
      ));
      expect(unavailable.status).toBe(503);
    });
  });

  test('an already-swept Work still describes its cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      await seedCard(store, { title: 'A', sessionId: 's1', status: 'in_progress' });
      const work = await seedWork(workStore, 'swept', ['s1']);
      await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/completion-preview`,
      ));
      const preview = await res.json() as WorkCompletionPreview;
      expect(preview.alreadyArchived).toBe(true);
      // Read off the archive, not the (now empty) board.
      expect(preview.cardCount).toBe(1);
      expect(preview.sweepCardCount).toBe(0);
      expect(preview.byStatus.done).toBe(1);
      expect(preview.runningCardIds).toEqual([]);
    });
  });
});

/**
 * `favorite` means "keep this card on the board". `store.archiveCards` honours
 * it for every descendant it cascades to; the Work sweep supplied its top-level
 * seeds explicitly and so walked straight past the pin.
 */
describe('Work completion and favorited cards', () => {
  test('leaves a favorited top-level card on the board and reports it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);

      const pinned = await seedCard(store, { title: 'pinned', sessionId: 's1' });
      await store.updateCard(pinned.id, { favorite: true });
      const ordinary = await seedCard(store, { title: 'ordinary', sessionId: 's1' });
      const work = await seedWork(workStore, 'mixed', ['s1']);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });

      expect(result.keptFavoriteCardIds).toEqual([pinned.id]);
      expect(result.archiveSeedIds).toEqual([ordinary.id]);
      expect(result.archivedCount).toBe(1);

      const board = await store.getCards();
      expect(board.map(c => c.id)).toEqual([pinned.id]);
      // Untouched, not merely un-archived: the sweep does not flip it either,
      // because a `done` favorite is what the next plain archive sweeps away.
      expect(board[0]?.status).toBe('todo');
    });
  });

  test('a Work whose only board cards are favorited is skipped, un-stamped and retryable', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);

      const pinned = await seedCard(store, { title: 'pinned', sessionId: 's1' });
      await store.updateCard(pinned.id, { favorite: true });
      const work = await seedWork(workStore, 'all pinned', ['s1']);

      const result = await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });
      expect(result.archiveSkipped).toBe('favorites-only');
      expect(result.keptFavoriteCardIds).toEqual([pinned.id]);
      expect(result.work.archivedAt).toBeUndefined();
      expect((await store.getCards()).map(c => c.id)).toEqual([pinned.id]);

      // Un-pinning makes it completable, which is why the stamp stays off.
      await store.updateCard(pinned.id, { favorite: false, status: 'done' });
      const retry = await applyWorkPatch({
        store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
      });
      expect(retry.archivedCount).toBe(1);
    });
  });

  test('the completion preview counts favorites out of the sweep and reports them', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const pinned = await seedCard(store, { title: 'pinned', sessionId: 's1' });
      await store.updateCard(pinned.id, { favorite: true });
      await seedCard(store, { title: 'ordinary', sessionId: 's1' });
      const work = await seedWork(workStore, 'preview', ['s1']);

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/completion-preview`,
      ));
      const preview = await res.json() as WorkCompletionPreview;
      expect(preview.cardCount).toBe(2);
      // The dialog must promise exactly what the sweep will take.
      expect(preview.sweepCardCount).toBe(1);
      expect(preview.favoriteCardIds).toEqual([pinned.id]);
    });
  });

  test('PATCH reports kept favorites on the sweep report', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      await saveWorksConfig(settingsStore, { doneConfirm: false });
      const { handleRequest } = handlerWith(store, settingsStore, workStore);

      const pinned = await seedCard(store, { title: 'pinned', sessionId: 's1' });
      await store.updateCard(pinned.id, { favorite: true });
      await seedCard(store, { title: 'ordinary', sessionId: 's1' });
      const work = await seedWork(workStore, 'report', ['s1']);

      const res = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }));
      expect(res.status).toBe(200);
      const patched = await res.json() as WorkPatchResponse;
      expect(patched.sweep?.archivedCount).toBe(1);
      expect(patched.sweep?.keptFavoriteCardIds).toEqual([pinned.id]);
    });
  });
});

/**
 * Dangling `WorkSessionLink`s — the gap card deletion left. Nothing told Works
 * that a session had lost its last card, so the link stayed and
 * `resolveWorkStartedAt` quietly fell back to `linkedAt`: the Timeline bar
 * started at triage time instead of when the work began.
 */
describe('Work link reconciliation after card deletion', () => {
  test('deleting a session\'s last card stamps the link and stops re-dating the bar', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      const old = await seedCard(store, { title: 'old', sessionId: 's-old' });
      await store.updateCard(old.id, { startedAt: '2026-07-01T00:00:00.000Z' });
      const doomed = await seedCard(store, { title: 'doomed', sessionId: 's-gone' });
      await store.updateCard(doomed.id, { startedAt: '2026-08-01T00:00:00.000Z' });

      const work = await workStore.createWork({ title: 'W' });
      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      await workStore.addSession(work.id, { sessionId: 's-old' }, resolve);
      await workStore.addSession(work.id, { sessionId: 's-gone' }, resolve);
      expect((await workStore.getWork(work.id))?.startedAt).toBe('2026-07-01T00:00:00.000Z');

      const deleted = await handleRequest(new Request(
        `http://localhost/api/cards/${doomed.id}`, { method: 'DELETE' },
      ));
      expect(deleted.status).toBe(204);

      const stamped = (await workStore.getWork(work.id))!;
      const goneLink = stamped.sessionLinks.find(l => l.sessionId === 's-gone')!;
      expect(goneLink.cardsMissingAt).toBeTruthy();
      expect(stamped.sessionLinks.find(l => l.sessionId === 's-old')?.cardsMissingAt)
        .toBeUndefined();

      // The detail response surfaces it, so the dialog can name the bad row.
      const detail = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
      ));
      const body = await detail.json() as WorkSessionsResponse;
      expect(body.sessions.find(s => s.sessionId === 's-gone')?.cardsMissingAt).toBeTruthy();
      expect(body.sessions.find(s => s.sessionId === 's-old')?.cardsMissingAt).toBeUndefined();
    });
  });

  test('restoring the card clears the stamp', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      const card = await seedCard(store, { title: 'temporary', sessionId: 's1' });
      const work = await seedWork(workStore, 'W', ['s1']);

      await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, { method: 'DELETE' }));
      expect((await workStore.getWork(work.id))?.sessionLinks[0]?.cardsMissingAt).toBeTruthy();

      const restored = await handleRequest(new Request(
        `http://localhost/api/cards/${card.id}/restore`, { method: 'POST' },
      ));
      expect(restored.status).toBe(200);
      expect((await workStore.getWork(work.id))?.sessionLinks[0]?.cardsMissingAt).toBeUndefined();
    });
  });

  test('reconcile-links repairs historical data and is idempotent', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      // Deleted straight through the store, the way it happened before the
      // delete route knew about Works at all.
      const card = await seedCard(store, { title: 'legacy', sessionId: 's1' });
      const work = await seedWork(workStore, 'legacy work', ['s1', 's2']);
      await store.deleteCard(card.id);
      expect((await workStore.getWork(work.id))?.sessionLinks[0]?.cardsMissingAt).toBeUndefined();

      const first = await handleRequest(new Request(
        'http://localhost/api/works/reconcile-links', { method: 'POST' },
      ));
      expect(first.status).toBe(200);
      const firstReport = await first.json() as WorkLinkReconcileReport;
      expect(firstReport.marked).toEqual([{ workId: work.id, sessionIds: ['s1', 's2'] }]);

      const second = await handleRequest(new Request(
        'http://localhost/api/works/reconcile-links', { method: 'POST' },
      ));
      const secondReport = await second.json() as WorkLinkReconcileReport;
      expect(secondReport.marked).toEqual([]);
      expect(secondReport.cleared).toEqual([]);
      expect(secondReport.scanned).toBe(1);
    });
  });

  test('prune-sessions drops only the stamped links and re-dates what remains', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      const kept = await seedCard(store, { title: 'kept', sessionId: 's-kept' });
      await store.updateCard(kept.id, { startedAt: '2026-08-10T00:00:00.000Z' });
      const doomed = await seedCard(store, { title: 'doomed', sessionId: 's-gone' });
      await store.updateCard(doomed.id, { startedAt: '2026-08-01T00:00:00.000Z' });

      const work = await workStore.createWork({ title: 'W' });
      const resolve = createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
      await workStore.addSession(work.id, { sessionId: 's-kept' }, resolve);
      await workStore.addSession(work.id, { sessionId: 's-gone' }, resolve);

      await handleRequest(new Request(`http://localhost/api/cards/${doomed.id}`, { method: 'DELETE' }));
      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/prune-sessions`, { method: 'POST' },
      ));
      expect(res.status).toBe(200);
      const pruned = await res.json() as WorkPruneSessionsResponse;
      expect(pruned.removedSessionIds).toEqual(['s-gone']);
      expect(pruned.work.sessionLinks.map(l => l.sessionId)).toEqual(['s-kept']);
      // min() over what is left, not the deleted session's linkedAt.
      expect(pruned.work.startedAt).toBe('2026-08-10T00:00:00.000Z');
    });
  });

  test('prune-sessions keeps an emptied Work rather than deleting it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      const card = await seedCard(store, { title: 'only', sessionId: 's1' });
      const work = await seedWork(workStore, 'soon empty', ['s1']);
      await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, { method: 'DELETE' }));

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/prune-sessions`, { method: 'POST' },
      ));
      const pruned = await res.json() as WorkPruneSessionsResponse;
      expect(pruned.work.sessionLinks).toEqual([]);
      // A cleanup button must not silently take the record, its Summary and its
      // Timeline history with it — deleting is a separate, confirmed action.
      expect(await workStore.getWork(work.id)).not.toBeNull();
    });
  });
});

/**
 * `POST /api/works/:id/sessions/batch`. One card snapshot for the whole
 * selection, and partial failure reported rather than thrown.
 */
describe('batch session linking', () => {
  test('links a whole selection and settles startedAt at min() over all of them', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      for (const [sessionId, startedAt] of [
        ['s1', '2026-08-20T00:00:00.000Z'],
        ['s2', '2026-08-05T00:00:00.000Z'],
        ['s3', '2026-08-12T00:00:00.000Z'],
      ]) {
        const card = await seedCard(store, { title: sessionId, sessionId });
        await store.updateCard(card.id, { startedAt });
      }
      const work = await workStore.createWork({
        title: 'batch', startedAt: '2026-09-01T00:00:00.000Z',
      });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions/batch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessions: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }],
            role: 'review',
          }),
        },
      ));
      expect(res.status).toBe(200);
      const body = await res.json() as WorkBatchAddSessionsResponse;
      expect(body.linkedSessionIds).toEqual(['s1', 's2', 's3']);
      expect(body.failed).toEqual([]);
      expect(body.work.startedAt).toBe('2026-08-05T00:00:00.000Z');
      expect(body.work.sessionLinks.every(l => l.role === 'review')).toBe(true);
    });
  });

  test('reports the sessions it could not link without undoing the ones it did', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);

      const other = await workStore.createWork({ title: 'owner' });
      await workStore.addSession(other.id, { sessionId: 's-taken' });
      const target = await workStore.createWork({ title: 'target' });

      const res = await handleRequest(new Request(
        `http://localhost/api/works/${target.id}/sessions/batch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessions: [{ sessionId: 's-free' }, { sessionId: 's-taken' }, { sessionId: 's-free-2' }],
          }),
        },
      ));
      expect(res.status).toBe(200);
      const body = await res.json() as WorkBatchAddSessionsResponse;
      // 1:N is per session — one rejection must not roll the batch back.
      expect(body.linkedSessionIds).toEqual(['s-free', 's-free-2']);
      expect(body.failed.map(f => f.sessionId)).toEqual(['s-taken']);
      expect(body.failed[0]?.message).toContain('already linked');
      expect((await workStore.getWork(target.id))?.sessionLinks.map(l => l.sessionId))
        .toEqual(['s-free', 's-free-2']);
      expect((await workStore.getWork(other.id))?.sessionLinks.map(l => l.sessionId))
        .toEqual(['s-taken']);
    });
  });

  test('rejects a malformed batch body before touching the store', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, new SettingsStore(dir), workStore);
      const work = await workStore.createWork({ title: 'W' });

      const post = (body: unknown) => handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions/batch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ));
      expect((await post({ sessions: [] })).status).toBe(400);
      expect((await post({ sessions: [{}] })).status).toBe(400);
      expect((await post({ sessions: [{ sessionId: 's1' }], role: 'nope' })).status).toBe(400);
      expect((await workStore.getWork(work.id))?.sessionLinks).toEqual([]);
    });
  });
});

/**
 * `dispatchFn` is the only seam through which the server can start an agent run,
 * and `docs/invariants.md` says neither end of a Work's life may reach it:
 * finishing work must not start new work, and re-opening finished work must not
 * either. The reason is structural rather than stylistic — the bulk card flip is
 * a plain `store.updateCard` write, so it bypasses the completion hook in
 * `event-handler.ts` that owns queue auto-dispatch. If anyone ever routes the
 * sweep through that hook "for consistency", a Work holding twenty cards would
 * fire twenty queued follow-ups at once, and re-opening it would fire them again.
 *
 * The card queued behind the swept card is the witness: it stays `todo`, with no
 * session and no run, across both transitions.
 */
describe('Work completion and reopen never auto-dispatch a queued card', () => {
  function handlerWithDispatch(
    store: KanbanStore,
    settingsStore: SettingsStore,
    workStore: WorkStore,
    dispatchFn: DispatchFn,
  ) {
    return createRouteHandler(
      store, dispatchFn, undefined, undefined, settingsStore, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      workStore,
    );
  }

  /** A swept card plus the `todo` card queued behind it, inside one Work. */
  async function seedQueuedChain(store: KanbanStore, workStore: WorkStore) {
    const leader = await seedCard(store, { title: 'swept leader', sessionId: 'ses-queue' });
    const follower = await store.createCard({ title: 'queued follower', description: 'waits' });
    await store.updateCard(follower.id, {
      queuedAfterCardId: leader.id,
      queuePosition: 1,
    });
    const work = await seedWork(workStore, 'work with a queue behind it', ['ses-queue']);
    return { leader, follower, work };
  }

  test('completing a Work archives its cards without touching the queue', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatched: string[] = [];
      const dispatchFn: DispatchFn = async (cardId: string) => {
        dispatched.push(cardId);
        return { sessionId: `ses-${cardId}`, runId: `run-${cardId}`, startedAt: new Date().toISOString() };
      };
      const { leader, follower, work } = await seedQueuedChain(store, workStore);
      const { handleRequest } = handlerWithDispatch(store, settingsStore, workStore, dispatchFn);

      const res = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', confirmArchive: true }),
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as WorkPatchResponse;
      expect(body.sweep?.archivedCount).toBe(1);

      // The leader really was swept — otherwise the queue is untouched for the
      // trivial reason that nothing happened at all.
      expect((await store.getCards({})).map(c => c.id)).not.toContain(leader.id);

      expect(dispatched).toEqual([]);
      const stillQueued = (await store.getCards({})).find(c => c.id === follower.id);
      expect(stillQueued?.status).toBe('todo');
      expect(stillQueued?.sessionId).toBeUndefined();
      expect(stillQueued?.startedAt).toBeUndefined();
      expect(stillQueued?.queuedAfterCardId).toBe(leader.id);
    });
  });

  test('reopening a Work restores its cards without touching the queue', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatched: string[] = [];
      const dispatchFn: DispatchFn = async (cardId: string) => {
        dispatched.push(cardId);
        return { sessionId: `ses-${cardId}`, runId: `run-${cardId}`, startedAt: new Date().toISOString() };
      };
      const { leader, follower, work } = await seedQueuedChain(store, workStore);
      const { handleRequest } = handlerWithDispatch(store, settingsStore, workStore, dispatchFn);

      await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', confirmArchive: true }),
      }));

      const reopened = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/reopen`,
        { method: 'POST' },
      ));
      expect(reopened.status).toBe(200);
      const restored = await reopened.json() as { restoredCardIds: string[] };
      expect(restored.restoredCardIds).toEqual([leader.id]);

      // The restored leader comes back `done` (the sweep records no prior
      // status), and that is exactly the state a completion hook would treat as
      // "this card just finished, dispatch what is queued behind it".
      const board = await store.getCards({});
      expect(board.find(c => c.id === leader.id)?.status).toBe('done');
      expect(dispatched).toEqual([]);
      const stillQueued = board.find(c => c.id === follower.id);
      expect(stillQueued?.status).toBe('todo');
      expect(stillQueued?.sessionId).toBeUndefined();
      expect(stillQueued?.queuedAfterCardId).toBe(leader.id);
    });
  });
});

// Review regressions: children may start in a new session after Work assignment.
describe('Work completion cascade safety', () => {
  test('preview and guard include a late running descendant', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 'parent-session', status: 'complete' });
      const work = await seedWork(workStore, 'late child', ['parent-session']);
      const child = await store.createCard({ title: 'late child', description: '', sessionId: 'child-session', parentCardId: parent.id });
      const runStore = new RuntimeRunStore(dir);
      const run = await runStore.createRun({ cardId: child.id, runtime: 'codex', cwd: dir });
      await runStore.updateRun(run.runId, { status: 'running' });
      const { handleRequest: handler } = handlerWithRuns(store, new SettingsStore(dir), workStore, runStore);
      const previewResponse = await handler(new Request(`http://localhost/api/works/${work.id}/completion-preview`));
      const preview = await previewResponse!.json() as WorkCompletionPreview;
      expect(preview.sweepCardCount).toBe(2);
      expect(preview.runningCardIds).toEqual([child.id]);
      expect(preview.runningCardTitles).toEqual(['late child']);
      const response = await handler(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', confirmArchive: true }),
      }));
      expect(response!.status).toBe(409);
      expect((await workStore.getWork(work.id))?.status).toBe('active');
      expect((await store.getCards()).length).toBe(2);
      expect((await store.getCard(parent.id))?.status).toBe('complete');
    });
  });

  test('a descendant owned by another Work blocks the whole completion', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 's-parent' });
      const child = await store.createCard({ title: 'other work child', description: '', sessionId: 's-child', parentCardId: parent.id });
      const work = await seedWork(workStore, 'parent work', ['s-parent']);
      await seedWork(workStore, 'child work', ['s-child']);
      const { handleRequest: handler } = handlerWith(store, new SettingsStore(dir), workStore);
      const preview = await (await handler(new Request(`http://localhost/api/works/${work.id}/completion-preview`)))!.json() as WorkCompletionPreview;
      expect(preview.conflictingCardIds).toEqual([child.id]);
      const response = await handler(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done', confirmArchive: true }),
      }));
      expect(response!.status).toBe(409);
      expect((await workStore.getWork(work.id))?.status).toBe('active');
      expect((await store.getCards()).length).toBe(2);
    });
  });

  test('rechecks live runs under the archive lock and leaves a retryable Work', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const card = await seedCard(store, { title: 'starts late', sessionId: 's' });
      const work = await seedWork(workStore, 'racing run', ['s']);
      let reads = 0;
      const result = await applyWorkPatch({ store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false,
        activeRunProbe: async ids => ++reads === 1 ? [] : ids,
      });
      expect(result.archivedCount).toBe(0);
      expect(result.failedCards.map(f => f.cardId)).toEqual([card.id]);
      expect((await store.getCards()).length).toBe(1);
      expect((await workStore.getWork(work.id))?.archivedAt).toBeUndefined();
    });
  });

  test('completed late child sessions remain discoverable in Work history', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const parent = await seedCard(store, { title: 'parent', sessionId: 's-parent' });
      const work = await seedWork(workStore, 'with late child', ['s-parent']);
      const child = await store.createCard({ title: 'child', description: '', sessionId: 's-child', parentCardId: parent.id });
      const result = await applyWorkPatch({ store, workStore, workId: work.id, updates: { status: 'done' }, doneConfirm: false });
      expect(result.archivedCount).toBe(2);
      expect(result.work.sessionLinks.map(l => l.sessionId)).toContain('s-child');
      const { handleRequest: handler } = handlerWith(store, new SettingsStore(dir), workStore);
      const detail = await (await handler(new Request(`http://localhost/api/works/${work.id}/sessions`)))!.json() as WorkSessionsResponse;
      expect(detail.cardCount).toBe(2);
      expect(detail.sessions.flatMap(session => session.cardIds)).toContain(child.id);
    });
  });
});
