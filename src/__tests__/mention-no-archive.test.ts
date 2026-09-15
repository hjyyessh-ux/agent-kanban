import { describe, expect, spyOn, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';
import type { KanbanCard } from '../core/types';

/**
 * The mention routes must never touch the monthly archive.
 *
 * This is the whole reason the feature has no cache layer. `active.json` parses
 * in 6–11ms, so a keystroke-rate endpoint can reread it every time — but the
 * archive is 71MB / 9,483 cards and takes ~150ms, and `loadArchives()` is one
 * `includeArchived: true` away at all times: `computeSessionAggregates`
 * (`GET /api/sessions`, the Works Inbox) calls exactly that. A refactor that
 * "reuses" it here would quietly turn every `@` keystroke into a full archive
 * scan, and nothing else in the suite would notice.
 *
 * So the guard is not a performance assertion — it is a spy on the two calls
 * that could bring the scan back.
 */

function handlerWith(store: KanbanStore, workStore: WorkStore) {
  return createRouteHandler(
    store,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    workStore,
  );
}

/** A board card plus an archived one, so both sides of the guard have material. */
async function seedBoardAndArchive(store: KanbanStore): Promise<{ live: KanbanCard; archivedId: string }> {
  const live = await store.createCard({ title: 'live', description: '텔레그램 폴러 고쳐줘' });
  await store.updateCard(live.id, { sessionId: 'live1111-aaaa', status: 'complete' });

  const gone = await store.createCard({ title: 'archived', description: '텔레그램 위키 백필' });
  await store.updateCard(gone.id, { sessionId: 'gone2222-bbbb', status: 'done' });
  const { archivedCount } = await store.archiveCards([gone.id]);
  expect(archivedCount).toBe(1);

  return { live, archivedId: gone.id };
}

describe('the mention routes never read the archive', () => {
  test('GET /api/mentions calls neither loadArchives nor getCards({ includeArchived })', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedBoardAndArchive(store);

      const loadArchives = spyOn(store, 'loadArchives');
      const loadArchiveMonth = spyOn(store, 'loadArchiveMonth');
      const getCards = spyOn(store, 'getCards');

      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request('http://localhost/api/mentions?q=텔레그램'));
      expect(res.status).toBe(200);

      expect(loadArchives).not.toHaveBeenCalled();
      expect(loadArchiveMonth).not.toHaveBeenCalled();
      expect(getCards).toHaveBeenCalled();
      for (const [filter] of getCards.mock.calls) {
        expect(filter?.includeArchived).toBeFalsy();
      }
    });
  });

  test('GET /api/mentions/resolve stays board-only too', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { archivedId } = await seedBoardAndArchive(store);

      const created = await workStore.createWork({ title: '텔레그램 연동' });
      await workStore.addSession(created.id, { sessionId: 'gone2222-bbbb', projectDir: '/tmp/p' });

      const loadArchives = spyOn(store, 'loadArchives');
      const loadArchiveMonth = spyOn(store, 'loadArchiveMonth');
      const getCards = spyOn(store, 'getCards');
      const getCard = spyOn(store, 'getCard');

      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request(
        `http://localhost/api/mentions/resolve?token=${encodeURIComponent('@session:live1111')}`
        + `&token=${encodeURIComponent(`@work:${created.id}`)}`,
      ));
      expect(res.status).toBe(200);
      expect(archivedId).toBeTruthy();

      expect(loadArchives).not.toHaveBeenCalled();
      expect(loadArchiveMonth).not.toHaveBeenCalled();
      // 아카이브된 세션의 카드를 찾으러 가지 않는다 — Work 링크의 projectDir로
      // 경로를 만들고 파일 존재로 판정한다(§6.3).
      expect(getCard).not.toHaveBeenCalled();
      for (const [filter] of getCards.mock.calls) {
        expect(filter?.includeArchived).toBeFalsy();
      }
    });
  });

  test('an archived session is therefore not a mention candidate', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      await seedBoardAndArchive(store);

      const { handleRequest } = handlerWith(store, workStore);
      const res = await handleRequest(new Request('http://localhost/api/mentions?q=텔레그램'));
      const body = await res.json() as { groups: { sessions: Array<{ id: string }> } };

      // 둘 다 '텔레그램'을 담고 있지만 보드에 남은 세션만 나온다. 지나간 작업의
      // 참조는 `@doc:`(Wiki 문서)가 담당한다 — 의도된 제약이다.
      expect(body.groups.sessions.map((c) => c.id)).toEqual(['live1111']);
    });
  });
});
