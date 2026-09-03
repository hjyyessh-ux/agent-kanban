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
  resolveSessionStartedAt,
  selectWorkCards,
} from '../plugin/works/work-lifecycle';
import { saveWorksConfig } from '../plugin/works/works-config';
import { createRouteHandler } from '../server/routes';
import { createTestCard, withTempDir } from './setup';
import type { KanbanCard, Work } from '../core/types';

/** createRouteHandler with only settingsStore (pos 5) + workStore (pos 22) wired. */
function handlerWith(store: KanbanStore, settingsStore: SettingsStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, settingsStore, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
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

describe('Work startedAt stamping', () => {
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

  test('the first link back-dates startedAt; later links leave it alone', async () => {
    await withTempDir(async (dir) => {
      const workStore = new WorkStore(dir);
      const work = await workStore.createWork({ title: 'W' });

      const first = await workStore.addSession(work.id, {
        sessionId: 's1', startedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(first.startedAt).toBe('2026-08-01T00:00:00.000Z');

      const second = await workStore.addSession(work.id, {
        sessionId: 's2', startedAt: '2026-07-01T00:00:00.000Z',
      });
      expect(second.startedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  test('the first link falls back to the link time when no card start is known', async () => {
    await withTempDir(async (dir) => {
      const workStore = new WorkStore(dir);
      const work = await workStore.createWork({ title: 'W', startedAt: '2020-01-01T00:00:00.000Z' });
      const linked = await workStore.addSession(work.id, { sessionId: 's1' });
      expect(linked.startedAt).not.toBe('2020-01-01T00:00:00.000Z');
      expect(new Date(linked.startedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
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
});
