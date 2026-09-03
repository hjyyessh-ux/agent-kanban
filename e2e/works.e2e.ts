import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import {
  apiAddWorkSession,
  apiCreateWork,
  apiGetCards,
  apiGetCardsIncludingArchived,
  apiGetWork,
  apiGetWorkInbox,
  apiGetWorks,
  apiResetWorksState,
  apiUpdateWork,
} from './helpers/api';

/**
 * Works + Timeline tabs (design doc screens ① / ③ / ⑤).
 *
 * The Works domain is global state on a shared server, and specs run
 * sequentially, so every test starts from `apiResetWorksState()` — otherwise
 * sessions and Works left by earlier spec files would land in the Inbox, the
 * Active list, and the tab badge. Bar *geometry* is covered exhaustively by the
 * `timelineModel.test.ts` unit tests; the Timeline test here asserts the render
 * and click paths only.
 */

const PROJECT_DIR = '/tmp/works-e2e-project';

function worksTabBadge(page: Page): Locator {
  return page.locator('#app-tab-works .app-tab-badge');
}

async function openWorksTab(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Works' }).click();
}

/** The Inbox row group for a seeded card, addressed by its (unique) title. */
function inboxRow(page: Page, cardTitle: string): Locator {
  return page.locator('.works-inbox-row-group').filter({ hasText: cardTitle });
}

/** The Active/Resolved Work card for a Work, addressed by its (unique) title. */
function workCard(page: Page, workTitle: string): Locator {
  return page.locator('.works-card').filter({ hasText: workTitle });
}

/** Local midnight of the Monday that starts `date`'s week (the grid's column 0). */
function mondayOf(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
}

/** ISO timestamp at local noon, `offsetDays` after `from` — safely inside the day. */
function noonAfter(from: Date, offsetDays: number): string {
  return new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + offsetDays, 12, 0, 0,
  ).toISOString();
}

/**
 * Where a *manually set* end date lands: local end-of-day. Starts keep their
 * real clock time, ends do not — see `endIsoForColumn` in `timelineModel.ts`.
 */
function endOfDayAfter(from: Date, offsetDays: number): string {
  return new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + offsetDays, 23, 59, 59, 999,
  ).toISOString();
}

/**
 * A Work's bar slot — the grid-placed wrapper. Column geometry and the resize
 * handles live here; `.tl-bar` inside it is only the clickable label.
 */
function barSlot(page: Page, workTitle: string): Locator {
  return page.locator('.tl-bar-slot').filter({ hasText: workTitle });
}

/** The explicit `grid-column` bounds React wrote onto a grid child. */
function gridColumnBounds(locator: Locator): Promise<{ start: string; end: string }> {
  return locator.evaluate((el: HTMLElement) => ({
    start: el.style.gridColumnStart,
    end: el.style.gridColumnEnd,
  }));
}

test.beforeEach(async () => {
  await apiResetWorksState();
});

test('Inbox session becomes a new Work and drops the tab badge', async ({ page, seedCard, trackWork }) => {
  const runId = `works-new-${Date.now()}`;
  const first = await seedCard({
    title: `[E2E ${runId}] 첫 번째 세션`,
    description: 'Inbox → 새 Work 배정 fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-1`,
  });
  await seedCard({
    title: `[E2E ${runId}] 두 번째 세션`,
    description: 'Inbox 잔여 세션 fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-2`,
  });

  await openWorksTab(page);

  // Both seeded sessions land in the Inbox, and the tab badge counts them.
  await expect(worksTabBadge(page)).toHaveText('2');
  await expect(page.getByText('미배정 세션 2개')).toBeVisible();
  await expect(page.getByText('진행 중인 Work가 없습니다.', { exact: false })).toBeVisible();

  const row = inboxRow(page, first.title);
  await row.getByRole('button', { name: '배정' }).click();

  // "새 Work 만들기" is only the default when nothing is recommendable, so pick
  // it explicitly rather than relying on the reset having emptied the Work list.
  const newWorkOption = page.locator('.works-assign-option').filter({ hasText: '새 Work 만들기' });
  await newWorkOption.click();
  await expect(newWorkOption).toHaveAttribute('aria-pressed', 'true');

  const workTitle = `Work ${runId}`;
  await page.locator('#works-new-title').fill(workTitle);
  await page.locator('#works-new-role').selectOption('review');
  await page.getByRole('button', { name: `"${workTitle}" 만들기` }).click();

  // Active Works picks it up with the session (and its role) attached…
  const created = workCard(page, workTitle);
  await expect(created).toBeVisible();
  await expect(created).toHaveClass(/works-card--active/);
  await expect(created).toContainText('세션 1');
  await expect(created).toContainText('리뷰 1');

  // …and the assigned session leaves the Inbox, decrementing the badge.
  await expect(inboxRow(page, first.title)).toHaveCount(0);
  await expect(page.getByText('미배정 세션 1개')).toBeVisible();
  await expect(worksTabBadge(page)).toHaveText('1');

  const works = await apiGetWorks();
  const persisted = works.find((work) => work.title === workTitle);
  expect(persisted).toBeDefined();
  trackWork(persisted!.id);
  expect(persisted!.status).toBe('active');
  expect(persisted!.sessionLinks).toHaveLength(1);
  expect(persisted!.sessionLinks[0]).toMatchObject({
    sessionId: `claude-${runId}-1`,
    role: 'review',
  });
});

test('Assign-all modal walks the Inbox with the N / 1 / S / X shortcuts', async ({ page, seedCard, seedWork, trackWork }) => {
  const runId = `works-bulk-${Date.now()}`;
  const existing = await seedWork({
    title: `기존 Work ${runId}`,
    projectDir: PROJECT_DIR,
  });

  // Serialize creation so `updatedAt` (which orders the Inbox) is strictly
  // increasing; the modal's step order is then the Inbox order we read back.
  for (const suffix of ['a', 'b', 'c', 'd']) {
    await seedCard({
      title: `[E2E ${runId}] 세션 ${suffix}`,
      description: 'Bulk assign fixture',
      projectDir: PROJECT_DIR,
      sessionId: `claude-${runId}-${suffix}`,
    });
  }

  const inbox = await apiGetWorkInbox();
  expect(inbox).toHaveLength(4);
  const [step1, step2, step3, step4] = inbox;

  await openWorksTab(page);
  await expect(worksTabBadge(page)).toHaveText('4');
  await page.getByRole('button', { name: '⚡ 모두 배정하기' }).click();

  const dialog = page.getByRole('dialog', { name: '세션 배정' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('1 / 4')).toBeVisible();
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(step1.cardTitle);

  // ── Step 1: N → 새 Work 만들기, Enter → 연결하고 다음 ────────────────────
  const newWorkOption = dialog.locator('.bulk-assign-option').filter({ hasText: '새 Work 만들기' });
  await page.keyboard.press('n');
  await expect(newWorkOption).toHaveAttribute('aria-selected', 'true');
  const step1WorkTitle = `N키 Work ${runId}`;
  await dialog.locator('#bulk-assign-title').fill(step1WorkTitle);
  await page.keyboard.press('Enter');

  // ── Step 2: 1 → the first recommendation, then the primary button ────────
  await expect(dialog.getByText('2 / 4')).toBeVisible();
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(step2.cardTitle);
  // Both Works share the session's projectDir, so they are ranked by recency:
  // the Work created one step ago outranks the pre-seeded one.
  const options = dialog.locator('.bulk-assign-option');
  await expect(options.nth(1)).toContainText(step1WorkTitle);
  await expect(options.nth(2)).toContainText(existing.title);
  await page.keyboard.press('1');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: '연결하고 다음 →' }).click();

  // ── Step 3: S → 건너뛰기 (session stays unassigned) ──────────────────────
  await expect(dialog.getByText('3 / 4')).toBeVisible();
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(step3.cardTitle);
  await page.keyboard.press('s');

  // ── Step 4: X → 폐기 (session is ignored), which closes the last card ────
  await expect(dialog.getByText('4 / 4')).toBeVisible();
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(step4.cardTitle);
  await page.keyboard.press('x');
  await expect(dialog).toHaveCount(0);

  const works = await apiGetWorks();
  for (const work of works) trackWork(work.id);

  // N created a Work for step 1; 1 linked step 2 onto that same Work.
  const fromNewKey = works.find((work) => work.title === step1WorkTitle);
  expect(fromNewKey?.sessionLinks.map((link) => link.sessionId))
    .toEqual([step1.sessionId, step2.sessionId]);
  expect(works.find((work) => work.id === existing.id)?.sessionLinks).toHaveLength(0);

  // The skipped session is still awaiting triage; the discarded one is gone for good.
  const remaining = await apiGetWorkInbox();
  expect(remaining.map((session) => session.sessionId)).toEqual([step3.sessionId]);
  const allLinked = works.flatMap((work) => work.sessionLinks.map((link) => link.sessionId));
  expect(allLinked).not.toContain(step4.sessionId);

  // Inbox drained from 4 to 1 (2 assigned, 1 discarded, 1 skipped).
  await expect(worksTabBadge(page)).toHaveText('1');
});

test('Completing a Work archives every card under its sessions', async ({ page, seedCardWithStatus, seedWork }) => {
  const runId = `works-done-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const inProgress = await seedCardWithStatus(
    { title: `[E2E ${runId}] 진행 중 카드`, description: 'Work 완료 fixture 1', projectDir: PROJECT_DIR },
    'in_progress',
    { sessionId },
  );
  const complete = await seedCardWithStatus(
    { title: `[E2E ${runId}] 완료 카드`, description: 'Work 완료 fixture 2', projectDir: PROJECT_DIR },
    'complete',
    { sessionId, resolution: 'completed' },
  );

  const workTitle = `완료할 Work ${runId}`;
  const work = await seedWork({ title: workTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);

  const active = workCard(page, workTitle);
  await expect(active).toHaveClass(/works-card--active/);
  await active.getByRole('button', { name: '완료' }).click();

  // The Work moves to the Resolved section and loses its 완료 button.
  const resolved = workCard(page, workTitle);
  await expect(resolved).toHaveClass(/works-card--resolved/);
  await expect(resolved).toHaveClass(/works-card--done/);
  await expect(resolved.getByRole('button', { name: '완료' })).toHaveCount(0);

  // Both cards were flipped to `done` and swept off the board into the archive.
  await expect(async () => {
    const board = await apiGetCards();
    const boardIds = board.map((card) => card.id);
    expect(boardIds).not.toContain(inProgress.id);
    expect(boardIds).not.toContain(complete.id);

    // `archivedAt` lives on the monthly archive file, not on the card, so
    // "off the board but still readable with include_archived" *is* the archive.
    const all = await apiGetCardsIncludingArchived();
    for (const id of [inProgress.id, complete.id]) {
      expect(all.find((card) => card.id === id)?.status).toBe('done');
    }
  }).toPass({ timeout: 5_000 });

  const persisted = await apiGetWork(work.id);
  expect(persisted.status).toBe('done');
  expect(persisted.resolvedAt).toBeTruthy();
  expect(persisted.archivedAt).toBeTruthy();
});

test('Timeline extends an unresolved bar to today and pins a done bar to its span', async ({ page, seedWork, trackWork }) => {
  const runId = `works-timeline-${Date.now()}`;
  const weekStart = mondayOf(new Date());

  // Both Works start on this week's Monday (grid column 0) so the expected
  // columns are fixed no matter which weekday the suite runs on.
  const activeTitle = `진행중 Work ${runId}`;
  const doneTitle = `완료 Work ${runId}`;
  await seedWork({
    title: activeTitle,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 0),
  });
  const doneWork = await apiCreateWork({
    title: doneTitle,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 0),
  });
  trackWork(doneWork.id);
  await apiUpdateWork(doneWork.id, { status: 'done', resolvedAt: noonAfter(weekStart, 1) });

  await page.goto('/');
  await page.getByRole('tab', { name: 'Timeline' }).click();

  // The today column anchors the assertions, so no date math is duplicated here.
  const todayHead = page.locator('.tl-head--today');
  await expect(todayHead).toHaveCount(1);
  const todayColumn = Number.parseInt((await gridColumnBounds(todayHead)).start, 10);
  expect(Number.isNaN(todayColumn)).toBe(false);

  // Unresolved: bar runs from Monday to the today column and stays open.
  const activeBar = page.locator('.tl-bar').filter({ hasText: activeTitle });
  await expect(activeBar).toHaveClass(/tl-bar--active/);
  await expect(activeBar).toHaveClass(/tl-bar--ongoing/);
  await expect(activeBar).toContainText('진행중');
  expect(await gridColumnBounds(barSlot(page, activeTitle)))
    .toEqual({ start: '2', end: String(todayColumn + 1) });

  // Done: Monday → Tuesday, unaffected by where today falls.
  const doneBar = page.locator('.tl-bar').filter({ hasText: doneTitle });
  await expect(doneBar).toHaveClass(/tl-bar--done/);
  await expect(doneBar).not.toHaveClass(/tl-bar--ongoing/);
  expect(await gridColumnBounds(barSlot(page, doneTitle))).toEqual({ start: '2', end: '4' });

  // Unresolved Works sort above resolved ones (mockup footnote).
  await expect(page.locator('.tl-bar').first()).toContainText(activeTitle);

  // Month mode keeps the same day grid, widened to whole weeks (28–35 columns).
  await page.getByRole('button', { name: '월간' }).click();
  await expect(page.locator('.timeline--month')).toBeVisible();
  const monthColumns = await page.locator('.tl-head').count();
  expect(monthColumns).toBeGreaterThanOrEqual(29); // 1 label column + >= 28 days
  expect(monthColumns).toBeLessThanOrEqual(36);
  await page.getByRole('button', { name: '주간' }).click();
  await expect(page.locator('.tl-head')).toHaveCount(8);

  // A bar opens the shared Work detail dialog.
  await activeBar.click();
  await expect(page.getByRole('dialog', { name: activeTitle })).toBeVisible();
});

test('Timeline re-dates a Work by dragging a bar edge and via the detail dialog', async ({ page, trackWork }) => {
  const runId = `works-redate-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const title = `날짜조정 Work ${runId}`;

  const work = await apiCreateWork({
    title,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 2), // Wednesday → grid column 2
  });
  trackWork(work.id);
  await apiUpdateWork(work.id, { status: 'done', resolvedAt: noonAfter(weekStart, 3) });

  await page.goto('/');
  await page.getByRole('tab', { name: 'Timeline' }).click();

  const slot = barSlot(page, title);
  await expect(slot).toBeVisible();
  expect(await gridColumnBounds(slot)).toEqual({ start: '4', end: '6' });

  // Drag the left handle two columns left, onto Monday.
  const mondayHead = page.locator('[data-tl-col="0"]');
  const target = await mondayHead.boundingBox();
  const handle = slot.locator('.tl-bar-handle--start');
  const from = await handle.boundingBox();
  if (!target || !from) throw new Error('timeline geometry not measurable');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, from.y + from.height / 2, { steps: 8 });
  await expect(slot.locator('.tl-bar-preview')).toBeVisible();
  await page.mouse.up();

  await expect.poll(async () => (await apiGetWork(work.id)).startedAt)
    .toBe(noonAfter(weekStart, 0));
  // The noon time-of-day survives a day-level drag.
  expect((await apiGetWork(work.id)).resolvedAt).toBe(noonAfter(weekStart, 3));
  await expect.poll(async () => (await gridColumnBounds(slot)).start).toBe('2');

  // Same edit from the detail dialog's date inputs: pull the end back a day.
  await page.locator('.tl-bar').filter({ hasText: title }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  const endInput = dialog.locator('.work-date-field', { hasText: '종료' }).locator('input');
  const endDay = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 2);
  const pad = (n: number) => String(n).padStart(2, '0');
  await endInput.fill(`${endDay.getFullYear()}-${pad(endDay.getMonth() + 1)}-${pad(endDay.getDate())}`);

  await expect.poll(async () => (await apiGetWork(work.id)).resolvedAt)
    .toBe(endOfDayAfter(weekStart, 2));

  // An end before the start is refused client-side, leaving the Work untouched.
  const beforeStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 3);
  await endInput.fill(
    `${beforeStart.getFullYear()}-${pad(beforeStart.getMonth() + 1)}-${pad(beforeStart.getDate())}`,
  );
  await expect(dialog.locator('.work-date-error')).toContainText('빠를 수 없습니다');
  expect((await apiGetWork(work.id)).resolvedAt).toBe(endOfDayAfter(weekStart, 2));
});

test('An open Work takes a planned end that survives completion', async ({ page, trackWork }) => {
  const runId = `works-planned-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const title = `예정일 Work ${runId}`;

  const work = await apiCreateWork({
    title,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 0),
  });
  trackWork(work.id);

  await page.goto('/');
  await page.getByRole('tab', { name: 'Timeline' }).click();

  // With no end set the bar tracks today and reads 진행중.
  const slot = barSlot(page, title);
  await expect(slot).toBeVisible();
  const todayColumn = Number.parseInt(
    (await gridColumnBounds(page.locator('.tl-head--today'))).start, 10,
  );
  expect(await gridColumnBounds(slot)).toEqual({ start: '2', end: String(todayColumn + 1) });
  await expect(slot.locator('.tl-bar-ongoing')).toHaveText('▸ 진행중');

  // Set a planned end from the dialog: Sunday, the last column of the week.
  await page.locator('.tl-bar').filter({ hasText: title }).click();
  const dialog = page.getByRole('dialog', { name: title });
  const endField = dialog.locator('.work-date-field', { hasText: '종료 예정' });
  const sunday = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
  const pad = (n: number) => String(n).padStart(2, '0');
  await endField.locator('input')
    .fill(`${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`);

  await expect.poll(async () => (await apiGetWork(work.id)).resolvedAt)
    .toBe(endOfDayAfter(weekStart, 6));
  // Still active — a planned end is not a completion.
  expect((await apiGetWork(work.id)).status).toBe('active');

  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect.poll(async () => (await gridColumnBounds(slot)).end).toBe('9');
  await expect(slot.locator('.tl-bar-ongoing')).toContainText('예정');

  // Completing later keeps the planned date instead of stamping "now".
  await apiUpdateWork(work.id, { status: 'done', confirmArchive: true });
  expect((await apiGetWork(work.id)).resolvedAt).toBe(endOfDayAfter(weekStart, 6));
});

test('Timeline shows the triage nudge when no Work overlaps the range', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Timeline' }).click();

  await expect(page.locator('.tl-empty')).toContainText('이 기간에 걸친 Work이 없습니다');
  await expect(page.locator('.tl-bar')).toHaveCount(0);
});
