import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { createRouteHandler } from '../server/routes';
import {
  buildWorkSessionsResponse,
  workCardScanFloor,
} from '../core/timeline-aggregate';
import { withTempDir } from './setup';
import type { KanbanCard, Work, WorkSessionsResponse } from '../core/types';

/**
 * Reading a Work — and the cards under it — *after* it was completed.
 *
 * Completing a Work bulk-archives every card of every linked session, so the
 * live board holds none of them a moment later. Everything here fixes the two
 * consequences that made a finished Work unreadable in the UI: a deep link to an
 * archived card answered `404`, and the detail dialog's own rollup (derived from
 * the board list) reported `카드 0 · done 0` for exactly the Works whose purpose
 * is to be looked back at.
 */

/** createRouteHandler with only workStore (positional arg 22) wired. */
function handlerWith(store: KanbanStore, workStore: WorkStore) {
  return createRouteHandler(
    store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

async function seedSessionCard(
  store: KanbanStore,
  input: { title: string; sessionId: string; startedAt?: string; projectDir?: string },
): Promise<KanbanCard> {
  const card = await store.createCard({ title: input.title, description: 'fixture' });
  return store.updateCard(card.id, {
    sessionId: input.sessionId,
    startedAt: input.startedAt ?? new Date().toISOString(),
    projectDir: input.projectDir,
  });
}

describe('archived card reads', () => {
  test('GET /api/cards/:id needs include_archived once the card has been swept', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);

      const card = await seedSessionCard(store, { title: 'archived me', sessionId: 's-1' });
      await store.updateCard(card.id, { status: 'done' });
      const { archivedCount } = await store.archiveCards([card.id]);
      expect(archivedCount).toBe(1);

      // The plain read is the pre-fix behaviour, and stays that way: the board
      // API describes the board.
      const plain = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`));
      expect(plain.status).toBe(404);

      const withArchive = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}?include_archived=true`),
      );
      expect(withArchive.status).toBe(200);
      const body = await withArchive.json() as KanbanCard;
      expect(body.id).toBe(card.id);
      expect(body.title).toBe('archived me');
      expect(body.status).toBe('done');
    });
  });

  test('include_archived still 404s an id that exists nowhere', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);

      const res = await handleRequest(
        new Request('http://localhost/api/cards/nope-nope?include_archived=true'),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Card not found' });
    });
  });

  test('a live card is unaffected by include_archived', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);

      const card = await seedSessionCard(store, { title: 'on the board', sessionId: 's-1' });
      const res = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}?include_archived=true`),
      );
      expect(res.status).toBe(200);
      expect((await res.json() as KanbanCard).id).toBe(card.id);
    });
  });

  test('GET /api/cards?session_id= narrows to one conversation, archive included', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);

      const mine = await seedSessionCard(store, { title: 'turn 1', sessionId: 's-mine' });
      const alsoMine = await seedSessionCard(store, { title: 'turn 2', sessionId: 's-mine' });
      const other = await seedSessionCard(store, { title: 'elsewhere', sessionId: 's-other' });
      for (const card of [mine, alsoMine, other]) {
        await store.updateCard(card.id, { status: 'done' });
      }
      await store.archiveCards([mine.id, alsoMine.id, other.id]);

      const res = await handleRequest(new Request(
        'http://localhost/api/cards?session_id=s-mine&include_archived=true',
      ));
      expect(res.status).toBe(200);
      const cards = await res.json() as KanbanCard[];
      expect(cards.map((c) => c.id).sort()).toEqual([mine.id, alsoMine.id].sort());

      // Without the archive there is nothing left to open.
      const boardOnly = await handleRequest(
        new Request('http://localhost/api/cards?session_id=s-mine'),
      );
      expect(await boardOnly.json() as KanbanCard[]).toEqual([]);
    });
  });
});

describe('GET /api/works/:id/sessions', () => {
  test('404s an unknown Work and 503s without a work store', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);

      const missing = await handlerWith(store, workStore)
        .handleRequest(new Request('http://localhost/api/works/nope/sessions'));
      expect(missing.status).toBe(404);

      const noStore = await createRouteHandler(store)
        .handleRequest(new Request('http://localhost/api/works/nope/sessions'));
      expect(noStore.status).toBe(503);
    });
  });

  test('counts a completed Work’s archived cards instead of reporting zero', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, workStore);

      const sessionId = 'claude-work-detail';
      const first = await seedSessionCard(store, {
        title: '첫 프롬프트',
        sessionId,
        startedAt: '2026-09-01T01:00:00.000Z',
        projectDir: '/tmp/proj',
      });
      const second = await seedSessionCard(store, {
        title: '두 번째 카드',
        sessionId,
        startedAt: '2026-09-02T01:00:00.000Z',
        projectDir: '/tmp/proj',
      });

      const work = await workStore.createWork({ title: '되돌아볼 Work', projectDir: '/tmp/proj' });
      const linked = await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, projectDir: '/tmp/proj', role: 'dev' }),
        },
      ));
      expect(linked.status).toBe(200);

      const before = await (await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
      ))).json() as WorkSessionsResponse;
      expect(before.cardCount).toBe(2);
      expect(before.sessions[0].archived).toBe(false);
      expect(before.sessions[0].title).toBe('첫 프롬프트');

      // Complete it — the sweep flips both cards to `done` and archives them,
      // which is what used to empty this response.
      const done = await handleRequest(new Request(`http://localhost/api/works/${work.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', confirmArchive: true }),
      }));
      expect(done.status).toBe(200);
      expect((await done.json() as Work).archivedAt).toBeTruthy();
      expect(await store.getCards({})).toEqual([]);

      const after = await (await handleRequest(new Request(
        `http://localhost/api/works/${work.id}/sessions`,
      ))).json() as WorkSessionsResponse;
      expect(after.cardCount).toBe(2);
      expect(after.doneCount).toBe(2);
      expect(after.inProgressCount).toBe(0);
      expect(after.sessions).toHaveLength(1);

      const session = after.sessions[0];
      expect(session.sessionId).toBe(sessionId);
      expect(session.role).toBe('dev');
      // The session keeps its human title — the pre-fix UI fell back to the
      // raw session id here.
      expect(session.title).toBe('첫 프롬프트');
      expect(session.cardCount).toBe(2);
      expect(session.archived).toBe(true);
      expect(session.cardIds).toEqual([first.id, second.id]);
      expect(session.firstCardAt).toBe('2026-09-01T01:00:00.000Z');
      // `archiveCards` stamps the wiki queue, so a just-completed Work is
      // "생성 대기 중" rather than "문서 없음".
      expect(after.wikiPending).toBe(true);
      expect(after.wikiDocPaths).toEqual([]);
      expect(after.scannedMonths.length).toBeGreaterThan(0);
    });
  });
});

describe('buildWorkSessionsResponse', () => {
  const base: Work = {
    id: 'w1',
    title: 'W',
    status: 'done',
    sessionLinks: [
      { sessionId: 's-b', linkedAt: '2026-09-02T00:00:00.000Z', role: 'review' },
      { sessionId: 's-a', linkedAt: '2026-09-01T00:00:00.000Z' },
    ],
    startedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };

  function card(over: Partial<KanbanCard> & { id: string }): KanbanCard {
    return {
      title: over.id,
      description: '',
      status: 'done',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      ...over,
    } as KanbanCard;
  }

  test('orders sessions by link time and ignores cards of other sessions', () => {
    const response = buildWorkSessionsResponse(base, [
      card({ id: 'c1', sessionId: 's-a', title: 'A first', startedAt: '2026-09-01T02:00:00.000Z' }),
      card({ id: 'c2', sessionId: 's-b', title: 'B first', startedAt: '2026-09-02T02:00:00.000Z' }),
      card({ id: 'c3', sessionId: 's-unlinked', title: 'not ours' }),
    ]);
    expect(response.sessions.map((s) => s.sessionId)).toEqual(['s-a', 's-b']);
    expect(response.cardCount).toBe(2);
    expect(response.sessions[1].role).toBe('review');
  });

  test('counts a card once when the sweep raced the read', () => {
    const duplicated = card({ id: 'c1', sessionId: 's-a' });
    const response = buildWorkSessionsResponse(base, [duplicated, duplicated]);
    expect(response.cardCount).toBe(1);
    expect(response.sessions[0].cardIds).toEqual(['c1']);
  });

  test('marks a session archived only when every card of it is off the board', () => {
    const cards = [
      card({ id: 'c1', sessionId: 's-a' }),
      card({ id: 'c2', sessionId: 's-a' }),
    ];
    const partly = buildWorkSessionsResponse(base, cards, {
      archivedCardIds: new Set(['c1']),
    });
    expect(partly.sessions[0].archived).toBe(false);

    const fully = buildWorkSessionsResponse(base, cards, {
      archivedCardIds: new Set(['c1', 'c2']),
    });
    expect(fully.sessions[0].archived).toBe(true);
  });

  test('an empty session is not archived and contributes nothing', () => {
    const response = buildWorkSessionsResponse(base, [], { archivedCardIds: new Set() });
    expect(response.cardCount).toBe(0);
    expect(response.sessions.every((s) => s.archived === false)).toBe(true);
    expect(response.sessions.every((s) => s.title === '')).toBe(true);
    // No cards at all → the Work's own updatedAt is the last thing that happened.
    expect(response.lastActivityAt).toBe(base.updatedAt);
  });

  test('collects kept wiki docs and reports pending separately', () => {
    const response = buildWorkSessionsResponse(base, [
      card({ id: 'c1', sessionId: 's-a', wiki: { status: 'processed', decision: 'kept', docPath: 'howto/a.md' } }),
      card({ id: 'c2', sessionId: 's-a', wiki: { status: 'processed', decision: 'kept', docPath: 'howto/a.md' } }),
      card({ id: 'c3', sessionId: 's-b', wiki: { status: 'processed', decision: 'skipped', docPath: 'howto/ignored.md' } }),
      card({ id: 'c4', sessionId: 's-b', wiki: { status: 'pending' } }),
    ]);
    expect(response.wikiDocPaths).toEqual(['howto/a.md']);
    expect(response.wikiPending).toBe(true);
    expect(response.sessions[0].wikiPending).toBe(false);
  });

  test('splits done from in-progress the way the 산출물 row reads them', () => {
    const response = buildWorkSessionsResponse(base, [
      card({ id: 'c1', sessionId: 's-a', status: 'done' }),
      card({ id: 'c2', sessionId: 's-a', status: 'complete' }),
      card({ id: 'c3', sessionId: 's-b', status: 'in_progress' }),
      card({ id: 'c4', sessionId: 's-b', status: 'todo' }),
    ]);
    expect(response.doneCount).toBe(2);
    expect(response.inProgressCount).toBe(2);
  });

  test('drops soft-deleted cards', () => {
    const response = buildWorkSessionsResponse(base, [
      card({ id: 'c1', sessionId: 's-a' }),
      card({ id: 'c2', sessionId: 's-a', deletedAt: '2026-09-03T00:00:00.000Z' }),
    ]);
    expect(response.cardCount).toBe(1);
  });
});

describe('workCardScanFloor', () => {
  test('reaches back to the earliest of startedAt / createdAt / linkedAt', () => {
    expect(workCardScanFloor({
      startedAt: '2026-09-10T00:00:00.000Z',
      createdAt: '2026-09-05T00:00:00.000Z',
      sessionLinks: [{ sessionId: 's', linkedAt: '2026-08-20T00:00:00.000Z' }],
    })).toBe('2026-08-20T00:00:00.000Z');
  });

  test('ignores unparseable timestamps rather than poisoning the floor', () => {
    expect(workCardScanFloor({
      startedAt: 'not-a-date',
      createdAt: '2026-09-05T00:00:00.000Z',
      sessionLinks: [],
    })).toBe('2026-09-05T00:00:00.000Z');
  });
});
