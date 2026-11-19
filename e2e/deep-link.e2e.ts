import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import { apiAddWorkSession, apiArchiveCards, apiGetCards, apiResetWorksState, apiUpdateCard, type Card } from './helpers/api';

/**
 * Shareable links: `?card=<id>` (canonical, also the legacy shared form) and
 * `?session=<id>&msg=<cardId>:user|assistant`. Every spec opens the link in a
 * fresh document (`page.goto`) — the same as pasting it into a new tab — or
 * drives the browser's own back/forward/reload.
 */

const PROJECT_DIR = '/tmp/deep-link-e2e';
const GROUP_MODE_KEY = 'kanban-complete-session-view';
const READ_AT = '2099-01-01T00:00:00.000Z';

const cardDialog = (page: Page) => page.locator('.kv2-dialog--detail');
const sessionDialog = (page: Page) => page.locator('.session-conversation-dialog');
const notice = (page: Page) => page.locator('.deep-link-notice');
const message = (page: Page, cardId: string, role: 'user' | 'assistant') =>
  sessionDialog(page).locator(`[data-message-id="${cardId}:${role}"]`);

function search(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

/** Board read (`GET /api/cards`, not the per-session read) held back by `ms`. */
async function delayBoardRead(page: Page, ms: number): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/cards' && !url.searchParams.has('session_id'),
    async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    },
  );
}

/** Simulates browser history navigation to `path` from inside the running app. */
async function historyNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

const LONG_TEXT = (label: string) =>
  Array.from({ length: 30 }, (_, i) => `${label} 줄 ${i + 1} — 스크롤 거리를 만들기 위한 본문입니다.`).join('\n\n');

type Seed = (data: { title: string; description: string } & Record<string, unknown>, status: string, extras?: Record<string, unknown>) => Promise<Card>;

/** A session of `count` finished turns, oldest first; turn 1 carries the search keyword. */
async function seedSession(seed: Seed, sessionId: string, run: string, count = 5): Promise<Card[]> {
  const turns: Card[] = [];
  for (let i = 1; i <= count; i += 1) {
    const keywordPrompt = i === 1 ? `\n\n유일한키워드프롬프트-${run}` : '';
    const keywordResult = i === 1 ? `\n\n유일한키워드결과-${run}` : '';
    turns.push(await seed(
      {
        title: `[DL ${run}] turn ${i}`,
        description: `${LONG_TEXT(`T${i} 요청`)}${keywordPrompt}`,
        projectDir: PROJECT_DIR,
        sessionId,
      },
      'complete',
      { result: `${LONG_TEXT(`T${i} 결과`)}${keywordResult}`, completedSeenAt: READ_AT },
    ));
  }
  return turns;
}

test.beforeEach(async () => {
  await apiResetWorksState();
});

test.describe('card links', () => {
  test('new tab entry, reload, and copy-link round trip open the exact card', async ({ page, context, seedCard, baseURL }) => {
    const run = `${Date.now()}`;
    const card = await seedCard({ title: `[DL ${run}] 링크 카드`, description: '링크로 여는 카드', projectDir: PROJECT_DIR });
    await seedCard({ title: `[DL ${run}] 다른 카드`, description: '열리면 안 되는 카드', projectDir: PROJECT_DIR });

    await page.goto(`/?card=${card.id}`);
    await expect(cardDialog(page)).toBeVisible();
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(card.title);
    expect(search(page).get('card')).toBe(card.id);
    await expect(notice(page)).toHaveCount(0);

    await page.reload();
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(card.title);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await cardDialog(page).getByRole('button', { name: '카드 링크 복사' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${baseURL}/?card=${card.id}`);

    const pasted = await context.newPage();
    await pasted.goto(copied);
    await expect(cardDialog(pasted).locator('.kv2-title-text')).toHaveText(card.title);
    await pasted.close();
  });

  test('opens after delayed data loading without a premature "not found"', async ({ page, seedCard }) => {
    const card = await seedCard({ title: `[DL ${Date.now()}] 지연 카드`, description: '지연 로딩', projectDir: PROJECT_DIR });
    await delayBoardRead(page, 1500);
    await page.goto(`/?card=${card.id}`);
    // The board read is still pending: spinner mounted, no dialog, no verdict yet.
    await expect(page.locator('.loading-spinner')).toHaveCount(1);
    await expect(cardDialog(page)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(card.title, { timeout: 10_000 });
    await expect(notice(page)).toHaveCount(0);
  });

  test('board click, close, back and forward keep URL and dialog in step', async ({ page, seedCard }) => {
    const card = await seedCard({ title: `[DL ${Date.now()}] 히스토리 카드`, description: '히스토리', projectDir: PROJECT_DIR });
    await page.goto('/');
    await page.locator('.kv2-card', { hasText: card.title }).click();
    await expect(cardDialog(page)).toBeVisible();
    expect(search(page).get('card')).toBe(card.id);

    await page.goBack();
    await expect(cardDialog(page)).toHaveCount(0);
    expect(search(page).has('card')).toBe(false);

    await page.goForward();
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(card.title);
    expect(search(page).get('card')).toBe(card.id);

    // The close button pops the entry it pushed: URL back to the board, and
    // Back afterwards does not land on the closed card a second time.
    await cardDialog(page).getByRole('button', { name: 'Close dialog' }).click();
    await expect(cardDialog(page)).toHaveCount(0);
    await expect.poll(() => search(page).has('card')).toBe(false);

    // Closing a card that came from the URL the tab opened with rewrites the URL in place.
    await page.goto(`/?card=${card.id}`);
    await expect(cardDialog(page)).toBeVisible();
    await cardDialog(page).getByRole('button', { name: 'Close dialog' }).click();
    await expect(cardDialog(page)).toHaveCount(0);
    expect(search(page).has('card')).toBe(false);
    await page.reload();
    await expect(page.locator('.kv2-card', { hasText: card.title })).toBeVisible();
    await expect(cardDialog(page)).toHaveCount(0);
  });

  test('missing, malformed and legacy short ids', async ({ page, seedCard }) => {
    await page.goto('/?card=doesNotExist123456789');
    await expect(notice(page)).toHaveAttribute('data-reason', 'card-not-found');
    await expect(notice(page)).toContainText('카드를 찾을 수 없습니다');
    await expect(cardDialog(page)).toHaveCount(0);

    await page.goto('/?card=%3Cscript%3E');
    await expect(notice(page)).toHaveAttribute('data-reason', 'invalid');
    await expect(cardDialog(page)).toHaveCount(0);

    // Short ids (the 8 characters the UI displays) resolve when unambiguous.
    const card = await seedCard({ title: `[DL ${Date.now()}] 짧은 ID`, description: 'legacy', projectDir: PROJECT_DIR });
    await page.goto(`/?card=${card.id.slice(0, 8)}`);
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(card.title);
    expect(search(page).get('card')).toBe(card.id);
  });

  test('a card in another Work: archived card names its Work; WORK filter follows the link', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = `${Date.now()}`;
    const [sessionA, sessionB, sessionDone] = [`dl-a-${run}`, `dl-b-${run}`, `dl-done-${run}`];
    await seedCardWithStatus({ title: `[DL ${run}] A`, description: 'A', projectDir: PROJECT_DIR, sessionId: sessionA }, 'complete', { completedSeenAt: READ_AT });
    const cardB = await seedCardWithStatus({ title: `[DL ${run}] B`, description: 'B', projectDir: PROJECT_DIR, sessionId: sessionB }, 'complete', { completedSeenAt: READ_AT });
    const archived = await seedCardWithStatus({ title: `[DL ${run}] 완료된 Work 카드`, description: 'C', projectDir: PROJECT_DIR, sessionId: sessionDone }, 'done', { result: '끝' });
    const workA = await seedWork({ title: `[DL ${run}] Work A` });
    const workB = await seedWork({ title: `[DL ${run}] Work B` });
    const workDone = await seedWork({ title: `[DL ${run}] Work Done` });
    await apiAddWorkSession(workA.id, { sessionId: sessionA });
    await apiAddWorkSession(workB.id, { sessionId: sessionB });
    await apiAddWorkSession(workDone.id, { sessionId: sessionDone });
    await apiArchiveCards([archived.id]);

    await page.goto(`/?card=${archived.id}`);
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(archived.title);
    await expect(notice(page)).toHaveAttribute('data-reason', 'archived');
    await expect(notice(page)).toContainText(workDone.title);

    // GROUP: WORKS filtered to Work A, then history lands on a card of Work B.
    await page.addInitScript((key) => localStorage.setItem(key, 'works'), GROUP_MODE_KEY);
    await page.goto('/');
    await page.locator('.kv2-filter-trigger').click();
    await page.locator('.kv2-filter-option').filter({ hasText: workA.title }).click();
    const workSection = (id: string) => page.locator(`section.kv2-work[data-work-id="${id}"][data-work-status="complete"]`);
    await expect(workSection(workA.id)).toBeVisible();
    await expect(workSection(workB.id)).toHaveCount(0);
    await page.keyboard.press('Escape');

    await historyNavigate(page, `/?card=${cardB.id}`);
    await expect(cardDialog(page).locator('.kv2-title-text')).toHaveText(cardB.title);
    await expect(workSection(workB.id)).toHaveCount(1);
    await expect(workSection(workA.id)).toHaveCount(0);
  });
});

test.describe('session and message links', () => {
  test('direct session entry, reload and copy link', async ({ page, context, seedCardWithStatus, baseURL }) => {
    const run = `${Date.now()}`;
    const sessionId = `dl-session-${run}`;
    await seedSession(seedCardWithStatus, sessionId, run, 3);

    await page.goto(`/?session=${sessionId}`);
    await expect(sessionDialog(page)).toBeVisible();
    await expect(sessionDialog(page).locator('.session-conversation-turn')).toHaveCount(3);
    await page.reload();
    await expect(sessionDialog(page).locator('.session-conversation-turn')).toHaveCount(3);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await sessionDialog(page).getByRole('button', { name: '세션 링크 복사' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${baseURL}/?session=${sessionId}`);

    await sessionDialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(sessionDialog(page)).toHaveCount(0);
    expect(search(page).has('session')).toBe(false);
  });

  test('search result links land on the exact user / assistant message; reload and back restore it', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = `${Date.now()}`;
    const sessionId = `dl-search-${run}`;
    const turns = await seedSession(seedCardWithStatus, sessionId, run, 5);
    const target = turns[0]!; // T1 — the oldest, rendered last in newest-first order
    const work = await seedWork({ title: `[DL ${run}] 검색 Work` });
    await apiAddWorkSession(work.id, { sessionId });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Works' }).click();
    await page.locator('.works-card').filter({ hasText: work.title }).getByRole('button', { name: /상세 열기$/ }).click();
    const searchBox = page.getByRole('searchbox', { name: '세션 검색' });

    // ── assistant message (Result) ──
    await searchBox.fill(`유일한키워드결과-${run}`);
    const resultHitLink = page.locator('.work-search-hit-link').first();
    await expect(resultHitLink).toHaveAttribute('href', `?session=${sessionId}&msg=${target.id}%3Aassistant`);
    // Ids only: the query never leaks into the link.
    expect(await resultHitLink.getAttribute('href')).not.toContain('유일한키워드');
    await resultHitLink.click();
    await expect(sessionDialog(page)).toBeVisible();
    expect(search(page).get('msg')).toBe(`${target.id}:assistant`);
    await expect(message(page, target.id, 'assistant')).toHaveAttribute('data-link-target', 'true');
    await expect(message(page, target.id, 'assistant')).toBeInViewport();
    await expect(sessionDialog(page).locator('[data-link-target]')).toHaveCount(1);

    await page.reload();
    await expect(message(page, target.id, 'assistant')).toHaveAttribute('data-link-target', 'true');
    await expect(message(page, target.id, 'assistant')).toBeInViewport();

    await page.goBack();
    await expect(sessionDialog(page)).toHaveCount(0);
    expect(search(page).has('session')).toBe(false);
    await page.goForward();
    await expect(message(page, target.id, 'assistant')).toBeInViewport();

    // ── user message (Prompt), via the hit row itself ──
    await page.goto('/');
    await page.getByRole('tab', { name: 'Works' }).click();
    await page.locator('.works-card').filter({ hasText: work.title }).getByRole('button', { name: /상세 열기$/ }).click();
    await page.getByRole('searchbox', { name: '세션 검색' }).fill(`유일한키워드프롬프트-${run}`);
    await expect(page.locator('.work-search-hit-link').first())
      .toHaveAttribute('href', `?session=${sessionId}&msg=${target.id}%3Auser`);
    await page.locator('.work-search-hit').first().click();
    await expect(message(page, target.id, 'user')).toHaveAttribute('data-link-target', 'true');
    await expect(message(page, target.id, 'user')).toBeInViewport();
    expect(search(page).get('msg')).toBe(`${target.id}:user`);
    await page.goBack();
    await expect(sessionDialog(page)).toHaveCount(0);
    // The Work detail it was opened from is still there.
    await expect(page.getByRole('searchbox', { name: '세션 검색' })).toBeVisible();
  });

  test('message link in a fresh tab waits for delayed data, then scrolls and highlights', async ({ page, seedCardWithStatus }) => {
    const run = `${Date.now()}`;
    const sessionId = `dl-delay-${run}`;
    const turns = await seedSession(seedCardWithStatus, sessionId, run, 5);
    const target = turns[1]!;
    await delayBoardRead(page, 1500);
    await page.goto(`/?session=${sessionId}&msg=${target.id}:user`);
    await expect(sessionDialog(page)).toHaveCount(0);
    await expect(message(page, target.id, 'user')).toHaveAttribute('data-link-target', 'true', { timeout: 10_000 });
    await expect(message(page, target.id, 'user')).toBeInViewport();
    await expect(notice(page)).toHaveCount(0);
  });

  test('missing session, missing message, archived session and access denied are told apart', async ({ page, seedCardWithStatus }) => {
    const run = `${Date.now()}`;

    await page.goto(`/?session=dl-nowhere-${run}`);
    await expect(notice(page)).toHaveAttribute('data-reason', 'session-not-found');
    await expect(sessionDialog(page)).toHaveCount(0);

    const sessionId = `dl-arch-${run}`;
    const turns = await seedSession(seedCardWithStatus, sessionId, run, 2);
    await page.goto(`/?session=${sessionId}&msg=missingCard123:assistant`);
    await expect(sessionDialog(page)).toBeVisible();
    await expect(notice(page)).toHaveAttribute('data-reason', 'message-not-found');
    await expect(sessionDialog(page).locator('[data-link-target]')).toHaveCount(0);

    // A turn without a Result has no assistant message.
    const pending = await seedCardWithStatus({ title: `[DL ${run}] 결과 없음`, description: '대기', projectDir: PROJECT_DIR, sessionId }, 'complete', { completedSeenAt: READ_AT });
    await apiUpdateCard(pending.id, { result: '' });
    await page.goto(`/?session=${sessionId}&msg=${pending.id}:assistant`);
    await expect(notice(page)).toHaveAttribute('data-reason', 'message-not-found');

    // Only `done` cards are archived.
    for (const card of [...turns, pending]) await apiUpdateCard(card.id, { status: 'done' });
    await apiArchiveCards([...turns.map((card) => card.id), pending.id]);
    expect((await apiGetCards()).some((card) => card.sessionId === sessionId)).toBe(false);
    await page.goto(`/?session=${sessionId}&msg=${turns[0]!.id}:user`);
    await expect(notice(page)).toHaveAttribute('data-reason', 'archived');
    await expect(message(page, turns[0]!.id, 'user')).toHaveAttribute('data-link-target', 'true');

    // The server refusing the read is reported as such, and nothing is shown instead.
    await page.route(
      (url) => url.pathname === '/api/cards' && url.searchParams.get('session_id') === sessionId,
      (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) }),
    );
    await page.goto(`/?session=${sessionId}`);
    await expect(notice(page)).toHaveAttribute('data-reason', 'access-denied');
    await expect(notice(page)).toContainText('HTTP 403');
    await expect(sessionDialog(page)).toHaveCount(0);

    await page.route(
      (url) => url.pathname.startsWith('/api/cards/') && url.searchParams.get('include_archived') === 'true',
      (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) }),
    );
    await page.goto(`/?card=${turns[0]!.id}`);
    await expect(notice(page)).toHaveAttribute('data-reason', 'access-denied');
    await expect(cardDialog(page)).toHaveCount(0);
  });
});
