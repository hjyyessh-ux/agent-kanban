import type { Locator, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/kanban';
import {
  apiAddWorkSession,
  apiCreateWork,
  apiResetWorksState,
  apiUpdateCard,
  apiUpdateWork,
} from './helpers/api';

/**
 * Visual review pass for the Works & Timeline work, not a regression spec: it
 * seeds one realistic Work and photographs every screen the review touched, in
 * light, dark and 390px mobile. Output goes to the gitignored `.playwright-mcp/`
 * so nothing lands in the repo.
 *
 * Locators are copied from `works.e2e.ts` on purpose — this file must not
 * invent a second vocabulary for the same screens.
 */
const OUT_DIR = path.resolve(process.cwd(), '.playwright-mcp', 'works-flow-revision');
mkdirSync(OUT_DIR, { recursive: true });

const PROJECT_DIR = '/tmp/works-review-project';
const WORK_TITLE = 'Works & Timeline 점검 반영';
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('kanban-theme', value);
    document.documentElement.setAttribute('data-theme', value);
    window.dispatchEvent(new CustomEvent('kanban-theme-change'));
  }, theme);
  await page.waitForTimeout(150);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

async function openWorksTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Works' }).click();
}

function workCard(page: Page, title: string): Locator {
  return page.locator('.works-card').filter({ hasText: title });
}

async function expandResolved(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^완료·폐기 \d/ }).click();
  await expect(page.locator('.works-section').filter({ hasText: '완료·폐기한 작업' })).toBeVisible();
}

/** A Work with two sessions of executed work, one still running, plus an unassigned session. */
async function seedReviewWork(
  seedCard: (data: { title: string; description: string } & Record<string, unknown>) => Promise<{ id: string }>,
  trackWork: (id: string) => void,
): Promise<void> {
  const runId = `review-${Date.now()}`;
  const sessionA = `claude-${runId}-a`;
  const sessionB = `claude-${runId}-b`;
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  const first = await seedCard({
    title: '[리뷰] 세션 링크 동시성 수정',
    description: 'addSession이 락 안에서 startedAt을 재계산한다',
    projectDir: PROJECT_DIR, sessionId: sessionA, sessionTitle: '링크 동시성',
  });
  await apiUpdateCard(first.id, { status: 'done', startedAt: daysAgo(4), completedAt: daysAgo(3), result: '## 결정\n세션 연결과 시작일 계산을 같은 잠금 안에서 처리합니다.\n\n## 검증\n동시 연결 테스트가 통과했습니다.' });

  const second = await seedCard({
    title: '[리뷰] Timeline 손잡이 포커스',
    description: 'beginDrag에서 focus()를 명시 호출한다',
    projectDir: PROJECT_DIR, sessionId: sessionA, sessionTitle: '링크 동시성',
  });
  await apiUpdateCard(second.id, { status: 'complete', startedAt: daysAgo(3), completedAt: daysAgo(2) });

  const third = await seedCard({
    title: '[리뷰] 디렉토리 팔레트 대비 재설계',
    description: '45도 hue 링 + 명도 교차',
    projectDir: PROJECT_DIR, sessionId: sessionB, sessionTitle: '팔레트 대비',
  });
  await apiUpdateCard(third.id, { status: 'in_progress', startedAt: daysAgo(1) });

  await seedCard({
    title: '[리뷰] 아직 배정되지 않은 세션',
    description: 'Inbox triage fixture',
    projectDir: '/tmp/works-review-other', sessionId: `claude-${runId}-c`, sessionTitle: '미배정 세션',
  });

  const work = await apiCreateWork({ title: WORK_TITLE, projectDir: PROJECT_DIR });
  trackWork(work.id);
  await apiAddWorkSession(work.id, { sessionId: sessionA, projectDir: PROJECT_DIR, role: 'dev' });
  await apiAddWorkSession(work.id, { sessionId: sessionB, projectDir: PROJECT_DIR, role: 'dev' });
  // A planned end already in the past, so the 예정 N일 초과 warn treatment is in frame.
  await apiUpdateWork(work.id, {
    startedAt: daysAgo(4),
    resolvedAt: daysAgo(1),
    notes: '점검 리포트 1~8번 카드의 반영 결과를 이 Work에 모았습니다.',
  });
}

test.beforeEach(async () => {
  await apiResetWorksState();
});

test('capture: Works tab and Work detail in both themes', async ({ page, seedCard, trackWork }) => {
  test.setTimeout(120_000);
  await seedReviewWork(seedCard, trackWork);

  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await setTheme(page, 'light');
  await openWorksTab(page);
  await expect(workCard(page, WORK_TITLE)).toBeVisible();
  await shot(page, '01-works-tab-light');

  await setTheme(page, 'dark');
  await shot(page, '02-works-tab-dark');
  await setTheme(page, 'light');

  await workCard(page, WORK_TITLE).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: WORK_TITLE });
  await expect(detail).toBeVisible();
  await shot(page, '03-work-detail-light');

  await setTheme(page, 'dark');
  await shot(page, '04-work-detail-dark');
  await detail.getByLabel('세션 추가', { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, '17-work-sessions-dark');
  await detail.getByRole('button', { name: '삭제…' }).scrollIntoViewIfNeeded();
  await shot(page, '18-work-actions-dark');
});

test('capture: completion confirm, resolved layout, and reopen', async ({ page, seedCard, trackWork }) => {
  test.setTimeout(120_000);
  await seedReviewWork(seedCard, trackWork);

  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await setTheme(page, 'light');
  await openWorksTab(page);

  // The scope preview: how many cards this archives, and what it leaves alone.
  await workCard(page, WORK_TITLE).getByRole('button', { name: '완료…' }).click();
  const confirm = page.getByRole('dialog', { name: '완료 확인', exact: true });
  await expect(confirm).toBeVisible();
  const commit = confirm.getByRole('button', { name: '✔ 완료 (일괄 archive)' });
  await expect(commit).toBeEnabled();
  await shot(page, '05-complete-confirm-light');

  await setTheme(page, 'dark');
  await shot(page, '06-complete-confirm-dark');
  await setTheme(page, 'light');

  await commit.click();
  await expect(confirm).not.toBeVisible();

  await expandResolved(page);
  await shot(page, '07-works-tab-after-complete');

  await workCard(page, WORK_TITLE).getByRole('button', { name: '상세', exact: true }).click();
  const resolved = page.getByRole('dialog', { name: WORK_TITLE });
  await expect(resolved).toBeVisible();
  await shot(page, '08-resolved-detail-light');

  await resolved.getByLabel('보관된 Work의 Wiki').scrollIntoViewIfNeeded();
  await shot(page, '21-work-archived-wiki');

  // Completed Works expose their archive and can be reopened.
  await expect(resolved.getByRole('button', { name: '다시 열기', exact: true })).toBeEnabled();
  await expect(resolved.getByRole('button', { name: /완료 \(일괄 archive\)/ })).toHaveCount(0);
  await setTheme(page, 'dark');
  await shot(page, '09-resolved-detail-dark');
  await setTheme(page, 'light');
  await resolved.getByRole('button', { name: '다시 열기', exact: true }).click();
  const reopen = page.getByRole('dialog', { name: '다시 열기 확인', exact: true });
  await reopen.getByRole('button', { name: '↺ 다시 열기', exact: true }).click();
  await expect(reopen).not.toBeVisible();
  await expect(resolved.locator('.work-status')).toContainText('진행 중');
});

test('capture: Timeline in both themes', async ({ page, seedCard, trackWork }) => {
  test.setTimeout(120_000);
  await seedReviewWork(seedCard, trackWork);

  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await setTheme(page, 'light');
  await page.getByRole('button', { name: '타임라인' }).click();
  await expect(page.locator('.timeline')).toBeVisible();
  await shot(page, '11-timeline-light');

  await setTheme(page, 'dark');
  await shot(page, '12-timeline-dark');
});

test('capture: 390px mobile, and nothing overflows sideways', async ({ page, seedCard, trackWork }) => {
  test.setTimeout(120_000);
  await seedReviewWork(seedCard, trackWork);

  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await setTheme(page, 'light');

  // At 390px the board's controls collapse behind a `≡ Board 도구` disclosure,
  // so the view switch is one tap deeper than on desktop.
  const boardTools = page.getByRole('button', { name: /Board 도구/ });
  if (await boardTools.count() > 0) await boardTools.first().click();
  await page.getByRole('button', { name: '타임라인' }).click();
  await expect(page.locator('.timeline')).toBeVisible();
  await shot(page, '13-timeline-mobile-390');

  await openWorksTab(page);
  await expect(workCard(page, WORK_TITLE)).toBeVisible();
  await shot(page, '14-works-tab-mobile-390-light');

  await setTheme(page, 'dark');
  await shot(page, '15-works-tab-mobile-390-dark');
  await setTheme(page, 'light');

  await workCard(page, WORK_TITLE).getByRole('button', { name: '상세', exact: true }).click();
  await expect(page.getByRole('dialog', { name: WORK_TITLE })).toBeVisible();
  await shot(page, '16-work-detail-mobile-390');
  const detail = page.getByRole('dialog', { name: WORK_TITLE });
  await detail.getByLabel('세션 추가', { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, '19-work-session-picker-mobile');
  await detail.getByRole('button', { name: '삭제…' }).scrollIntoViewIfNeeded();
  await shot(page, '20-work-actions-mobile');

  // The mobile failure mode this pass is looking for: the *page* must not gain a
  // horizontal scrollbar (an inner strip scrolling itself is fine and intended).
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
