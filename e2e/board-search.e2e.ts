import { test, expect } from './fixtures/kanban';
import type { Page } from '@playwright/test';
import { BOARD_SEARCH_COPY as copy, STATUS_LABELS, TOOLBAR_COPY } from '../web/src/constants/copy';
import { CARD_SEMANTIC_SEARCH_PATH, CARD_SEMANTIC_SETTINGS_PATH } from '../src/core/card-semantic';
import { BOARD_GROUP_MODE_STORAGE_KEY } from '../web/src/components/Board/board-group-mode';
import { apiAddWorkSession } from './helpers/api';

const input = (page: Page) => page.getByRole('combobox', { name: copy.label, exact: true });
const options = (page: Page) => page.getByRole('grid', { name: copy.results }).getByRole('row');
const filter = (page: Page) => page.locator('.kv2-filter-trigger');
const hold = () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
};

async function mockStatus(page: Page, state = 'ready') {
  await page.route(CARD_SEMANTIC_SETTINGS_PATH, route => route.fulfill({
    json: { enabled: state !== 'off', state, revision: '1', pending: 0, failed: 0, directories: [] },
  }));
}

test('keyword rows stay in order and retain the selected card when a delayed semantic response arrives', async ({ page, seedCard }) => {
  const first = await seedCard({ title: '알림 실패 원인 정리', description: '대상 첫 번째' });
  const second = await seedCard({ title: '알림 기록 확인', description: '대상 두 번째' });
  const semantic = await seedCard({ title: '작업 종료 후 Telegram 메시지 전송', description: '실행 완료 시 휴대폰에서 결과를 받는다.' });
  const late = hold();
  await mockStatus(page);
  await page.route(CARD_SEMANTIC_SEARCH_PATH, async route => {
    await late.pending;
    await route.fulfill({
      json: { status: 'ready', exact: [], semantic: [semantic, first] },
    });
  });
  try {
    await page.goto('/');
    await input(page).fill('알림');
    await expect(options(page)).toHaveCount(2);
    const before = await options(page).evaluateAll(rows => rows.map(row => row.id));
    await input(page).press('ArrowDown');
    await input(page).press('ArrowDown');
    await expect(input(page)).toHaveAttribute('aria-activedescendant', before[1]);
    late.release();
    await expect(options(page)).toHaveCount(3);
    expect(await options(page).evaluateAll(rows => rows.map(row => row.id))).toEqual([...before, 'board-search-result-' + semantic.id]);
    await expect(options(page).last()).toContainText(copy.semantic);
    await expect(options(page).filter({ hasText: copy.semantic })).toHaveCount(1);
    await expect(input(page)).toHaveAttribute('aria-activedescendant', before[1]);
    await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await input(page).press('Enter');
    const expected = before[1].endsWith(first.id) ? first.title : second.title;
    await expect(page.getByRole('dialog')).toContainText(expected);
  } finally {
    late.release();
  }
});

test('PR and ID still match with vectors off, preparing or timed out', async ({ page, seedCard }) => {
  const pr = await seedCard({ title: '정확한 PR', description: 'https://github.com/example/repo/pull/77352' });
  await seedCard({ title: 'PR 관련 메모', description: '번호 후보 77352 추가 기록' });
  let state = 'off';
  await page.route(CARD_SEMANTIC_SETTINGS_PATH, route => route.fulfill({
    json: { enabled: state !== 'off', state, revision: state, pending: 0, failed: 0, directories: [] },
  }));
  await page.route(CARD_SEMANTIC_SEARCH_PATH, route => route.fulfill({
    json: { status: state === 'preparing' ? 'preparing' : 'timeout', exact: [], semantic: [] },
  }));
  for (const [next, message] of [['off', copy.phase.off], ['preparing', copy.phase.preparing], ['ready', copy.phase.timeout]]) {
    state = next;
    await page.goto('/');
    await input(page).fill('77352');
    await expect(options(page)).toHaveCount(2);
    await expect(options(page).first()).toContainText(pr.title);
    await expect(options(page).first()).toContainText(copy.exact);
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await input(page).fill('#' + pr.id);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(pr.title);
  }
});

test('composition and obsolete query or filter responses cannot open or mix cards', async ({ page, seedCard }) => {
  const task = await seedCard({ title: '알림 작업', description: '이전 요청 결과' });
  const inferred = await seedCard({ title: '휴대폰에서 결과 수신', description: '실행이 종료될 때 메시지 전달' });
  const late = hold();
  const obsolete = hold();
  const requests: string[] = [];
  await mockStatus(page);
  await page.route(CARD_SEMANTIC_SEARCH_PATH, async route => {
    const body = route.request().postDataJSON();
    requests.push(body.query);
    const outdatedQuery = body.query === '알림';
    const outdatedScope = body.query !== '알림' && !body.scope.filter.status;
    if (outdatedQuery) await late.pending;
    if (outdatedScope) await obsolete.pending;
    await route.fulfill({ json: { status: 'ready', exact: [], semantic: [outdatedQuery || outdatedScope ? task : inferred] } }).catch(() => {
      // A superseded request was aborted by the browser.
    });
  });
  try {
    await page.goto('/');
    await input(page).dispatchEvent('compositionstart');
    await input(page).fill('알림');
    await input(page).press('Enter');
    await expect(page.getByText(copy.phase.composing)).toBeVisible();
    expect(requests).toEqual([]);
    await input(page).dispatchEvent('compositionend');
    await expect.poll(() => requests).toContain('알림');
    const query = '끝나면 알려줘';
    await input(page).fill(query);
    await expect.poll(() => requests).toContain(query);
    await filter(page).click();
    await page.getByRole('group', { name: '상태', exact: true }).getByRole('button', { name: STATUS_LABELS.todo, exact: true }).click();
    await page.getByRole('button', { name: 'Close filters' }).click();
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(inferred.title);
    late.release();
    obsolete.release();
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(copy.semantic);
    await input(page).press('ArrowDown');
    await input(page).press('Enter');
    await expect(page.getByRole('dialog')).toContainText(inferred.title);
  } finally {
    late.release();
    obsolete.release();
  }
});

test('mobile search applies the same filters and clears back to the previous view', async ({ page, seedCardWithStatus, seedWork }) => {
  const doneAt = new Date().toISOString();
  const inside = await seedCardWithStatus({ title: '모바일 테스트 카드', description: '검색 범위', projectDir: '/workspace/agent-kanban' }, 'complete',
    { sessionId: 'board-search-inside', completedAt: doneAt });
  const outside = await seedCardWithStatus({ title: '모바일 테스트 외부 카드', description: '검색 범위' }, 'complete',
    { sessionId: 'board-search-outside', completedAt: doneAt });
  const work = await seedWork({ title: '보드 검색 Work' });
  await apiAddWorkSession(work.id, { sessionId: inside.sessionId! });
  await page.addInitScript(({ key }) => localStorage.setItem(key, 'works'), { key: BOARD_GROUP_MODE_STORAGE_KEY });
  await page.addInitScript(() => localStorage.setItem('kanban-theme', 'dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStatus(page);
  await page.route(CARD_SEMANTIC_SEARCH_PATH, async route => {
    const { scope } = route.request().postDataJSON();
    if (scope.unread && scope.work && scope.filter.status) {
      expect(scope).toMatchObject({ work: work.id, unread: true, filter: { status: 'complete' } });
    }
    await route.fulfill({ json: { status: 'ready', exact: [], semantic: [outside, inside] } });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(input(page)).toBeVisible();
  await expect(filter(page)).toBeVisible();
  const search = await page.locator('.app-board-search').boundingBox();
  const toolbar = await page.locator('.app-board-primary-controls').boundingBox();
  const filterBox = await filter(page).boundingBox();
  expect(search?.width).toBe(toolbar?.width);
  expect(filterBox!.y).toBeGreaterThan(search!.y);
  await input(page).fill('모바일 테스트');
  await expect(options(page)).toHaveCount(2);
  const result = options(page).filter({ hasText: inside.title }).filter({ hasText: work.title });
  const chips = result.locator('.app-board-search-chips');
  await expect(chips).toContainText(work.title);
  await expect(chips).toContainText('agent-kanban');
  await expect(result.locator('time')).toHaveAttribute('datetime', /T/);
  await expect(result).not.toContainText(inside.sessionId!.slice(0, 8));
  const shades = await options(page).evaluateAll(results => results.map(result => getComputedStyle(result).backgroundColor));
  expect(new Set(shades).size).toBe(2);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await result.getByRole('button', { name: 'resume 명령 복사', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(inside.sessionId!);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await filter(page).click();
  const filters = page.getByRole('region', { name: 'Filter cards' });
  await expect(filters).toBeVisible();
  await expect(filters.getByRole('searchbox')).toHaveCount(0);
  await filters.getByRole('button', { name: work.title, exact: false }).click();
  await page.getByRole('group', { name: '상태', exact: true }).getByRole('button', { name: STATUS_LABELS.complete, exact: true }).click();
  await page.getByRole('button', { name: 'Close filters' }).click();
  await page.locator('.kv2-unread-filter').click();
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toContainText(inside.title);
  await expect(page.getByText(copy.excluded(1))).toBeVisible();
  await expect(input(page)).toHaveAccessibleDescription(/보드 검색 Work.*검토 대기.*미확인만/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.setViewportSize({ width: 390, height: 844 });
  await input(page).press('Tab');
  await expect(page.getByRole('button', { name: copy.clear })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeFocused();
  await expect(page.getByRole('grid', { name: copy.results })).toHaveCount(0);
  await expect(page.locator('.kv2-board')).toBeVisible();
  await input(page).fill('모바일 테스트');
  await page.getByRole('button', { name: copy.archive, exact: false }).click();
  await expect(page.getByPlaceholder('제목·프롬프트·프로젝트 검색')).toBeVisible();
});


test('clearing search restores each selected board view', async ({ page, seedCard }) => {
  const card = await seedCard({ title: '복귀 확인 카드', description: '보기 상태 유지' });
  await mockStatus(page, 'off');
  await page.goto('/');
  const modes = page.getByRole('group', { name: TOOLBAR_COPY.viewModeLegend });
  for (const [label, selector] of [
    [TOOLBAR_COPY.viewList, '.kv2-board-list'],
    [TOOLBAR_COPY.viewBoard, '.kv2-board'],
    [TOOLBAR_COPY.viewTimeline, '.tl-view'],
  ]) {
    await modes.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(selector)).toBeVisible();
    await input(page).fill(card.title);
    await expect(input(page), label).toHaveValue(card.title);
    await expect(options(page), label).toHaveCount(1);
    await expect(page.locator(selector)).not.toBeVisible();
    await page.getByRole('button', { name: copy.clear }).click();
    await expect(page.locator(selector)).toBeVisible();
  }
});
