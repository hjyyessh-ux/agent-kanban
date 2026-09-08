import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import {
  apiAddWorkSession,
  apiArchiveCards,
  apiCreateWork,
  apiDeleteCard,
  apiGetCards,
  apiGetCardsIncludingArchived,
  apiGetWork,
  apiGetWorkInbox,
  apiGetWorks,
  apiGetIgnoredSessions,
  apiGetWorksConfig,
  apiIgnoreWorkSession,
  apiResetWorksState,
  apiSaveWorksConfig,
  apiUpdateCard,
  apiUpdateWork,
} from './helpers/api';

/**
 * Works tab + the Board tab's Timeline view (design doc screens ① / ③ / ⑤).
 *
 * Inbox triage is covered three ways because they are three code paths onto the
 * same mutations: one row at a time, a drag-selected batch, and the assign-all
 * modal.
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

/**
 * The Timeline is a Board *view*, not a tab: 리스트 / 보드 / 타임라인 switch
 * inside the Board tab, which is the default tab on load.
 */
async function openTimeline(page: Page): Promise<void> {
  await page.getByRole('button', { name: '타임라인' }).click();
  await expect(page.locator('.timeline')).toBeVisible();
}

/** The Inbox row group for a seeded card, addressed by its (unique) title. */
function inboxRow(page: Page, cardTitle: string): Locator {
  return page.locator('.works-inbox-row-group').filter({ hasText: cardTitle });
}

/** The Active/Resolved Work card for a Work, addressed by its (unique) title. */
function workCard(page: Page, workTitle: string): Locator {
  return page.locator('.works-card').filter({ hasText: workTitle });
}

/**
 * The 완료/폐기 confirmation dialog. Both terminal transitions are irreversible
 * and neither offers an undo, so neither runs off its own button any more — the
 * scope of the bulk archive is stated here first.
 */
function resolveConfirm(page: Page, mode: '완료' | '폐기'): Locator {
  return page.getByRole('dialog', { name: `${mode} 확인`, exact: true });
}

/** Open the completion confirmation from a list row and wait for its scope read. */
async function openCompleteConfirm(page: Page, workTitle: string): Promise<Locator> {
  await workCard(page, workTitle).getByRole('button', { name: '완료…' }).click();
  const dialog = resolveConfirm(page, '완료');
  await expect(dialog).toBeVisible();
  // The confirm action is disabled until the preview lands: the dialog exists to
  // avoid committing before the scope is known.
  await expect(dialog.getByRole('button', { name: '✔ 완료 (일괄 archive)' })).toBeEnabled();
  return dialog;
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
 * A session's Timeline row. The visible label is the session's title (or its
 * oldest card's title), so the row is addressed by the id it carries as data —
 * the id itself is no longer printed.
 */
function sessionRow(page: Page, sessionId: string): Locator {
  return page.locator(`.tl-row[data-session-id="${sessionId}"]`);
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

  const row = inboxRow(page, first.title);
  await row.getByRole('button', { name: '배정' }).click();

  // "새 Work 만들기" is only the default when nothing is recommendable, so pick
  // it explicitly rather than relying on the reset having emptied the Work list.
  const newWorkOption = page.locator('.works-assign-option').filter({ hasText: '새 Work 만들기' });
  await newWorkOption.click();
  await expect(newWorkOption).toHaveAttribute('aria-pressed', 'true');

  const workTitle = `Work ${runId}`;
  // Addressed by label, not by a fixed DOM id: the panel renders in three
  // places (Inbox row, batch panel, move dialog) and its ids are `useId`-based.
  await page.getByLabel('새 Work 제목').fill(workTitle);
  await page.getByLabel('이 세션 역할').selectOption('review');
  await page.getByRole('button', { name: `"${workTitle}" 만들기` }).click();

  // Active Works picks it up with the session (and its role) attached…
  await page.getByRole('button', { name: /^진행 중 \d/ }).click();
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

test('Inbox drag-selects sessions, click toggles them, and one assign links the batch', async ({ page, seedCard, trackWork }) => {
  const runId = `works-multi-${Date.now()}`;
  const titles: string[] = [];
  // Serialized so `updatedAt` is strictly increasing and the Inbox order is stable.
  for (const suffix of ['a', 'b', 'c']) {
    const card = await seedCard({
      title: `[E2E ${runId}] 세션 ${suffix}`,
      description: '다중 선택 배정 fixture',
      projectDir: PROJECT_DIR,
      sessionId: `claude-${runId}-${suffix}`,
    });
    titles.push(card.title);
  }

  await openWorksTab(page);
  await expect(page.getByText('미배정 세션 3개')).toBeVisible();
  // No selection yet → no checkboxes at all.
  await expect(page.locator('.works-inbox-check')).toHaveCount(0);

  // Drag across the whole list. The rows are full-width, so only the vertical
  // sweep matters; x sits on the title text, clear of the row's buttons.
  const boxes = await Promise.all(
    titles.map((title) => inboxRow(page, title).locator('.works-inbox-row').boundingBox()),
  );
  const tops = boxes.map((box) => box!.y);
  const bottoms = boxes.map((box) => box!.y + box!.height);
  const dragX = boxes[0]!.x + 60;
  await page.mouse.move(dragX, Math.min(...tops) + 4);
  await page.mouse.down();
  await page.mouse.move(dragX, Math.max(...bottoms) - 4, { steps: 10 });
  await page.mouse.up();

  // The drag turned selection mode on and checked every row it covered.
  await expect(page.locator('.works-inbox-check')).toHaveCount(3);
  await expect(page.locator('.works-inbox-check:checked')).toHaveCount(3);

  // Clicking an already-selected row takes it back out of the selection.
  await inboxRow(page, titles[2]).locator('.works-inbox-title').click();
  await expect(page.locator('.works-inbox-check:checked')).toHaveCount(2);
  await expect(page.getByText('선택 2개')).toBeVisible();

  await page.getByRole('button', { name: '배정하기 (2)' }).click();
  const newWorkOption = page.locator('.works-assign-option').filter({ hasText: '새 Work 만들기' });
  await newWorkOption.click();

  const workTitle = `다중 배정 Work ${runId}`;
  await page.getByLabel('새 Work 제목').fill(workTitle);
  await page.getByLabel('세션 2개 역할').selectOption('debug');
  await page.getByRole('button', { name: `"${workTitle}" 만들고 2개 연결` }).click();

  // One Work, both selected sessions on it, with the one shared role.
  await page.getByRole('button', { name: /^진행 중 \d/ }).click();
  const created = workCard(page, workTitle);
  await expect(created).toBeVisible();
  await expect(created).toContainText('세션 2');
  await expect(created).toContainText('디버그 2');

  // Only the deselected session is left in the Inbox, and the selection is gone.
  await expect(page.getByText('미배정 세션 1개')).toBeVisible();
  await expect(inboxRow(page, titles[2])).toHaveCount(1);
  await expect(page.locator('.works-inbox-check')).toHaveCount(0);
  await expect(worksTabBadge(page)).toHaveText('1');

  const works = await apiGetWorks();
  const persisted = works.find((work) => work.title === workTitle);
  expect(persisted).toBeDefined();
  trackWork(persisted!.id);
  expect(persisted!.sessionLinks.map((link) => link.sessionId).sort()).toEqual([
    `claude-${runId}-a`,
    `claude-${runId}-b`,
  ]);
  expect(persisted!.sessionLinks.every((link) => link.role === 'debug')).toBe(true);
});

/**
 * Every Inbox row used to look the same: a session with an agent still running,
 * one whose card had never been dispatched, a duplicate subagent row, and a
 * session that finished last week were four identical grey lines. The row now
 * carries the two things that decide the triage: what state the session is in,
 * and whether it continues another session (which used to be visible only after
 * 배정 was already pressed).
 */
test('Inbox 행은 상태 칩과 계보 마크를 그 자리에서 보여준다', async ({
  page, seedCard, seedCardWithStatus,
}) => {
  const runId = `works-chips-${Date.now()}`;
  const idle = await seedCard({
    title: `[E2E ${runId}] 미실행 세션`,
    description: 'inbox chip fixture — never dispatched',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-idle`,
  });
  const running = await seedCardWithStatus({
    title: `[E2E ${runId}] 실행 중 세션`,
    description: 'inbox chip fixture — running',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-running`,
  }, 'in_progress');
  const parent = await seedCardWithStatus({
    title: `[E2E ${runId}] 부모 세션`,
    description: 'inbox chip fixture — parent',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-parent`,
  }, 'complete');
  const child = await seedCardWithStatus({
    title: `[E2E ${runId}] subagent 세션`,
    description: 'inbox chip fixture — subagent',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-child`,
    parentCardId: parent.id,
  }, 'complete');

  await openWorksTab(page);

  await expect(inboxRow(page, idle.title).locator('.works-inbox-state')).toHaveText('미실행');
  await expect(inboxRow(page, running.title).locator('.works-inbox-state')).toHaveText('실행 중');
  await expect(inboxRow(page, child.title).locator('.works-inbox-state')).toHaveText('subagent');
  // A settled session says nothing — a chip on every row would be noise.
  await expect(inboxRow(page, parent.title).locator('.works-inbox-state')).toHaveCount(0);

  // Lineage is symmetric: triage asks from whichever side is unassigned, and
  // both sides are still in the Inbox here.
  await expect(inboxRow(page, child.title).locator('.works-inbox-chain'))
    .toHaveText('🔗 이어진 세션 1');
  await expect(inboxRow(page, parent.title).locator('.works-inbox-chain'))
    .toHaveText('🔗 이어진 세션 1');
  await expect(inboxRow(page, idle.title).locator('.works-inbox-chain')).toHaveCount(0);
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
  await expect(newWorkOption).toHaveAttribute('aria-pressed', 'true');

  // The selected option's inputs render *inside* the option list, immediately
  // after it — not at the end, below every recommendation.
  const optionChildren = dialog.locator('.bulk-assign-options > *');
  await expect(optionChildren.nth(0)).toHaveClass(/bulk-assign-option/);
  await expect(optionChildren.nth(1)).toHaveClass(/bulk-assign-detail/);

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
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
  // The detail block follows the newly selected option, wherever it sits.
  await expect(dialog.locator('.bulk-assign-options > *').nth(2)).toHaveClass(/bulk-assign-detail/);
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

/**
 * The modal's shortcuts are bound on `window` in the capture phase, so they
 * fire wherever focus is. `Enter` used to be handled *above* the typing check,
 * which meant pressing it with `X 폐기` focused ran 연결하고 다음 and
 * `preventDefault`ed the button's own activation — the user got the opposite of
 * the action they had reached for, and 폐기 had no undo at all at the time.
 */
test('모달에서 폐기 버튼에 포커스한 Enter는 폐기만 실행한다', async ({ page, seedCard }) => {
  const runId = `works-key-enter-${Date.now()}`;
  const card = await seedCard({
    title: `[E2E ${runId}] Enter 대상 세션`,
    description: 'modal Enter-on-button fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}`,
  });

  await openWorksTab(page);
  await page.getByRole('button', { name: '⚡ 모두 배정하기' }).click();
  const dialog = page.getByRole('dialog', { name: '세션 배정' });
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(card.title);

  // Focus, not click: the point is what the *key* does on a focused button.
  await dialog.getByRole('button', { name: 'X 폐기' }).focus();
  await page.keyboard.press('Enter');

  // The last session was discarded, which closes the walk.
  await expect(dialog).toHaveCount(0);
  // 폐기 ran…
  const ignored = await apiGetIgnoredSessions();
  expect(ignored.map((entry) => entry.sessionId)).toContain(`claude-${runId}`);
  // …and 연결하고 다음 did not: no Work was created.
  expect(await apiGetWorks()).toHaveLength(0);
  await expect(inboxRow(page, card.title)).toHaveCount(0);
});

/**
 * The typing check listed only `INPUT`/`TEXTAREA`, so a letter typed with the
 * 역할 `<select>` focused was still read as a shortcut — `x` there discarded the
 * session outright.
 */
test('모달에서 역할 select에 포커스한 x는 아무 일도 하지 않는다', async ({ page, seedCard }) => {
  const runId = `works-key-select-${Date.now()}`;
  await seedCard({
    title: `[E2E ${runId}] select 포커스 세션`,
    description: 'modal select-focus fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-1`,
  });
  await seedCard({
    title: `[E2E ${runId}] 두 번째 세션`,
    description: 'modal select-focus fixture 2',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-2`,
  });

  // The Inbox is ordered by most recent activity, so the modal's first card is
  // the *newest* session — read the order rather than assuming it.
  const [step1] = await apiGetWorkInbox();

  await openWorksTab(page);
  await page.getByRole('button', { name: '⚡ 모두 배정하기' }).click();
  const dialog = page.getByRole('dialog', { name: '세션 배정' });
  await expect(dialog.getByText('1 / 2')).toBeVisible();

  await dialog.locator('#bulk-assign-role').focus();
  await page.keyboard.press('x');
  await page.keyboard.press('s');
  await page.keyboard.press('1');

  // Still on the same card, nothing discarded, nothing linked.
  await expect(dialog.getByText('1 / 2')).toBeVisible();
  await expect(dialog.locator('.bulk-assign-prompt')).toHaveText(step1.cardTitle);
  const ignored = await apiGetIgnoredSessions();
  expect(ignored.map((entry) => entry.sessionId)).not.toContain(step1.sessionId);
  expect(await apiGetWorks()).toHaveLength(0);

  // The select still works as a select — the keys reached it, not the modal.
  await dialog.locator('#bulk-assign-role').selectOption('debug');
  await expect(dialog.locator('#bulk-assign-role')).toHaveValue('debug');
});

/**
 * 폐기 was write-only: `ignoredSessionIds` could only be appended to, with no
 * read route and no UI, so one click (or one mistyped `x`) removed a session
 * from the Inbox, the tab badge and the Timeline permanently.
 */
test('폐기한 세션은 무시한 세션 목록에서 복원해 Inbox로 되돌린다', async ({ page, seedCard }) => {
  const runId = `works-restore-${Date.now()}`;
  const card = await seedCard({
    title: `[E2E ${runId}] 복원할 세션`,
    description: 'ignore/restore fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}`,
  });

  await openWorksTab(page);
  await expect(worksTabBadge(page)).toHaveText('1');

  await inboxRow(page, card.title).getByRole('button', { name: '폐기' }).click();
  await expect(inboxRow(page, card.title)).toHaveCount(0);

  // An undo is offered on the spot, too — 폐기 is one click from a row.
  const notice = page.locator('.work-session-notice');
  await expect(notice).toContainText('폐기했습니다');
  await expect(notice.getByRole('button', { name: '되돌리기' })).toBeVisible();
  await notice.getByRole('button', { name: '알림 닫기' }).click();

  // …and the list is the durable path, long after the toast is gone.
  await page.getByRole('button', { name: /무시한 세션 \d+개/ }).click();
  const ignoredRow = page.locator('.works-ignored-row').filter({ hasText: card.title });
  await expect(ignoredRow).toBeVisible();
  await ignoredRow.getByRole('button', { name: '복원' }).click();

  await expect(inboxRow(page, card.title)).toHaveCount(1);
  await expect(worksTabBadge(page)).toHaveText('1');
  const ignored = await apiGetIgnoredSessions();
  expect(ignored.map((entry) => entry.sessionId)).not.toContain(`claude-${runId}`);
});

/**
 * The panel held the target Work by id and enabled 연결 on the bare id, so a
 * Work that finished while the panel was open (Works polls every 10s, and here
 * it is completed from the very same screen) still accepted the session — the
 * server had no status guard on `POST /api/works/:id/sessions` either.
 */
test('추천에서 사라진 완료 Work로는 연결 버튼이 비활성된다', async ({ page, seedCard, seedWork, trackWork }) => {
  const runId = `works-stale-target-${Date.now()}`;
  const target = await seedWork({ title: `완료될 Work ${runId}`, projectDir: PROJECT_DIR });
  trackWork(target.id);
  const card = await seedCard({
    title: `[E2E ${runId}] 배정 대기 세션`,
    description: 'stale recommendation fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}`,
  });

  await openWorksTab(page);
  await inboxRow(page, card.title).getByRole('button', { name: '배정' }).click();

  // Same directory → the seeded Work is the default target and 연결 is live.
  const submit = page.getByRole('button', { name: `"${target.title}"에 연결` });
  await expect(submit).toBeEnabled();

  // Another client completes the selected recommendation while Inbox stays open.
  await apiUpdateWork(target.id, { status: 'done', confirmArchive: true });

  // The panel is still open, still aimed at that Work — and now refuses.
  await expect(page.locator('.works-assign-inline')).toBeVisible();
  await expect(page.getByRole('button', { name: '연결', exact: true })).toBeDisabled({ timeout: 15000 });
  expect((await apiGetWork(target.id)).sessionLinks).toHaveLength(0);
  await expect(inboxRow(page, card.title)).toHaveCount(1);
});

/** The `works-dir-cN` palette slot on an element, or null. */
async function dirSlot(locator: Locator): Promise<string | null> {
  const className = (await locator.getAttribute('class')) ?? '';
  return className.match(/works-dir-c\d/)?.[0] ?? null;
}

test('배정 패널은 같은 디렉토리를 같은 색으로, 이어진 세션을 🔗로 구분한다', async ({ page, seedCard, seedWork, trackWork }) => {
  const runId = `works-affinity-${Date.now()}`;
  const OTHER_DIR = `${PROJECT_DIR}-other`;

  // A Work in a *different* directory that holds the session our target resumes,
  // so 🔗 cannot be mistaken for the directory signal.
  const lineageSeed = await seedCard({
    title: `[E2E ${runId}] 이어받을 원본`,
    description: 'lineage fixture',
    projectDir: OTHER_DIR,
    sessionId: `claude-${runId}-origin`,
  });
  const lineageWork = await seedWork({ title: `이어진 Work ${runId}`, projectDir: OTHER_DIR });
  trackWork(lineageWork.id);
  await apiAddWorkSession(lineageWork.id, {
    sessionId: `claude-${runId}-origin`,
    projectDir: OTHER_DIR,
    role: 'dev',
  });

  // A same-directory Work — the runner-up signal.
  const sameDirWork = await seedWork({ title: `같은 디렉토리 Work ${runId}`, projectDir: PROJECT_DIR });
  trackWork(sameDirWork.id);

  const target = await seedCard({
    title: `[E2E ${runId}] 배정 대상`,
    description: 'affinity target',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-target`,
    resumeSessionId: lineageSeed.sessionId,
  });

  await openWorksTab(page);
  await inboxRow(page, target.title).getByRole('button', { name: '배정' }).click();
  const panel = page.locator('.works-assign-inline');

  // Lineage first, shared directory second — a directory says "same project",
  // lineage says "same piece of work".
  const items = panel.locator('.works-assign-work-item');
  await expect(items.nth(0)).toContainText(lineageWork.title);
  await expect(items.nth(0)).toContainText('🔗 이어진 세션');
  await expect(items.nth(1)).toContainText(sameDirWork.title);
  await expect(items.nth(1)).toContainText('같은 디렉토리');
  await expect(items.nth(1)).not.toContainText('🔗');

  // Same directory ⇒ same palette slot as the session's own chip; a different
  // directory ⇒ a different slot.
  const sessionSlot = await dirSlot(panel.locator('.works-dir-chip'));
  expect(sessionSlot).not.toBeNull();
  expect(await dirSlot(items.nth(1))).toBe(sessionSlot!);
  expect(await dirSlot(items.nth(0))).not.toBe(sessionSlot!);
});

test('상세에서 제목과 디렉토리를 고치면 목록과 Timeline이 따라간다', async ({
  page, seedCard, seedWork, trackWork,
}) => {
  // A Work's title used to be fixed at creation, and it is created from a
  // session's *first prompt* — so a Work called "로그인 버그 좀 봐줘" stayed that
  // forever even after it grew into three sessions of release work.
  const runId = `works-rename-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const anchor = daysAgo(2);

  const card = await seedCard({
    title: `[E2E ${runId}] 이름을 바꿀 Work의 세션`,
    description: 'rename fixture',
    projectDir: PROJECT_DIR,
    sessionId,
  });
  await apiUpdateCard(card.id, {
    startedAt: noonAfter(anchor, 0),
    completedAt: noonAfter(anchor, 0),
  });

  const oldTitle = `고치기 전 이름 ${runId}`;
  const newTitle = `고친 뒤 이름 ${runId}`;
  const work = await seedWork({
    title: oldTitle,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(anchor, 0),
  });
  trackWork(work.id);
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, oldTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: oldTitle });
  await expect(detail).toBeVisible();

  // The title is the dialog heading, edited in place: click it, and the
  // heading swaps to an input.
  await detail.locator('.work-title-text').click();
  const titleInput = detail.locator('.work-title-input');
  await expect(titleInput).toHaveValue(oldTitle);
  await titleInput.fill(newTitle);
  await titleInput.press('Enter');

  // Persisted, not just repainted.
  await expect.poll(async () => (await apiGetWork(work.id)).title, { timeout: 10_000 })
    .toBe(newTitle);
  // Every surface that names the Work follows: its own dialog header, the list
  // row, and the Timeline bar.
  const renamed = page.getByRole('dialog', { name: newTitle });
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: 'Close dialog' }).click();
  await expect(renamed).toHaveCount(0);
  await expect(workCard(page, newTitle)).toBeVisible();
  await expect(workCard(page, oldTitle)).toHaveCount(0);

  await page.getByRole('tab', { name: 'Board' }).click();
  await openTimeline(page);
  await expect(barSlot(page, newTitle)).toBeVisible();

  // Escape abandons a draft instead of closing the dialog — and instead of
  // committing it. `DialogSkeleton` reads Escape as "close", and `input.blur()`
  // inside a keydown handler runs `onBlur` before React re-renders, so an
  // Escape that cleared the draft in state alone was followed by a blur that
  // committed the abandoned text.
  await page.getByRole('tab', { name: 'Works' }).click();
  await workCard(page, newTitle).getByRole('button', { name: '상세', exact: true }).click();
  // Addressed by class, not by accessible name: the name *is* the title being
  // edited, so a locator built from it stops matching the moment a rename lands.
  const reopened = page.locator('.work-detail-dialog');
  await expect(reopened).toBeVisible();
  await reopened.locator('.work-title-text').click();
  const reopenedTitle = reopened.locator('.work-title-input');
  await reopenedTitle.fill('버려질 편집');
  await reopenedTitle.press('Escape');
  await expect(reopened).toBeVisible();
  await expect(reopened.locator('.work-title-text')).toHaveText(newTitle);
  // …and nothing was saved. Checked against the server, because the input
  // snapping back is also what a successful save looks like for one frame.
  await expect.poll(async () => (await apiGetWork(work.id)).title, { timeout: 3_000 })
    .toBe(newTitle);

  // The directory is editable too, and it is what the affinity colour hashes.
  // Same tile as the card detail: a click-to-edit DIRECTORY card that swaps to
  // the DirectoryPicker.
  const dirTile = reopened.locator('.kv2-meta-card--directory');
  await expect(dirTile.locator('.kv2-meta-value--mono')).toHaveText(PROJECT_DIR);
  await dirTile.click();
  // Escape abandons the directory draft without closing the dialog, like the title.
  await reopened.locator('.kv2-directory-input').press('Escape');
  await expect(reopened).toBeVisible();
  await expect(reopened.locator('.kv2-directory-input')).toHaveCount(0);
  await dirTile.click();
  const dirInput = reopened.locator('.kv2-directory-input');
  await expect(dirInput).toHaveValue(PROJECT_DIR);
  await dirInput.fill(`${PROJECT_DIR}-moved`);
  await dirInput.press('Enter');
  await expect(reopened.locator('.kv2-meta-card--directory .kv2-meta-value--mono'))
    .toHaveText(`${PROJECT_DIR}-moved`);
  await expect.poll(async () => (await apiGetWork(work.id)).projectDir, { timeout: 10_000 })
    .toBe(`${PROJECT_DIR}-moved`);
});

test('상세는 상태와 산출물을 사용자 언어로만 말한다', async ({
  page, seedCard, seedCardWithStatus, seedWork, trackWork,
}) => {
  // The dialog used to print the wire enums: an `ACTIVE` badge beside `완료` and
  // `폐기`, and `done 5` / `in_progress 1` chips — the second of which also
  // mis-named its own number (`inProgressCount` is todo + in_progress).
  const runId = `works-copy-${Date.now()}`;
  const sessionId = `claude-${runId}`;

  await seedCardWithStatus({
    title: `[E2E ${runId}] 끝난 카드`,
    description: 'copy fixture done',
    projectDir: PROJECT_DIR,
    sessionId,
  }, 'complete', { startedAt: noonAfter(daysAgo(1), 0), completedAt: noonAfter(daysAgo(1), 0) });
  // A `todo` card: the old `in_progress N` chip counted it, which is exactly
  // why the label had to change rather than the number.
  await seedCard({
    title: `[E2E ${runId}] 아직 시작하지 않은 카드`,
    description: 'copy fixture todo',
    projectDir: PROJECT_DIR,
    sessionId,
  });

  const title = `표현을 검사할 Work ${runId}`;
  const work = await seedWork({
    title,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(daysAgo(1), 0),
  });
  trackWork(work.id);
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: title });
  await expect(detail).toBeVisible();

  // One badge, in Korean.
  await expect(detail.locator('.work-status')).toHaveText(/^진행 중 · \d+일째$/);
  await expect(detail.locator('.work-detail-status .kv2-status-badge')).toHaveCount(1);

  // The 산출물 row is the wiki documents only — no card counts to leak an enum.
  await expect(detail.locator('.work-meta-card--stat')).toHaveCount(0);

  // Nothing anywhere in the dialog says a status the way the wire does.
  const body = (await detail.locator('.work-detail').innerText()).replace(/\s+/g, ' ');
  for (const enumName of ['ACTIVE', 'in_progress', 'todo']) {
    expect(body, `상세가 아직 "${enumName}"를 노출한다`).not.toContain(enumName);
  }

  // Neither placeholder button is here any more: App never wired 세션 연결, and
  // Wiki 정리 was hardcoded `disabled`. A control that can never fire is worse
  // than none, because it advertises a capability and withholds it.
  await expect(detail.getByRole('button', { name: /세션 연결/ })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /Wiki 정리/ })).toHaveCount(0);
  // And 요약 생성 — the one button that spends an LLM call — is not the primary.
  const summaryButton = detail.getByRole('button', { name: /요약 생성/ });
  await expect(summaryButton).toHaveClass(/kv2-btn--outline/);
  await expect(summaryButton).not.toHaveClass(/kv2-btn--primary/);
});

test('설정의 같은 폴더 우선을 끄면 배정 추천 순서가 바뀐다', async ({
  page, seedCard, seedWork, trackWork,
}) => {
  // `works.assign_prefer_same_dir` was written by this panel and read by nothing
  // — `recommendWorksForSession` always put same-directory Works first — so the
  // checkbox was decorative. This walks the setting end to end.
  const runId = `works-prefer-${Date.now()}`;
  const OTHER_DIR = `${PROJECT_DIR}-elsewhere`;
  const original = await apiGetWorksConfig();

  try {
    await apiSaveWorksConfig({ assignPreferSameDir: true });

    // The same-directory Work is the *older* one, so directory-first and
    // recency-first disagree about which comes first.
    const sameDir = await seedWork({
      title: `같은 폴더 Work ${runId}`,
      projectDir: PROJECT_DIR,
    });
    trackWork(sameDir.id);
    const elsewhere = await seedWork({
      title: `다른 폴더 Work ${runId}`,
      projectDir: OTHER_DIR,
    });
    trackWork(elsewhere.id);
    // Touch the other-directory Work so it is unambiguously the most recent.
    await apiUpdateWork(elsewhere.id, { title: `다른 폴더 Work ${runId}` });

    const target = await seedCard({
      title: `[E2E ${runId}] 추천 순서 확인용 세션`,
      description: 'prefer-same-dir fixture',
      projectDir: PROJECT_DIR,
      sessionId: `claude-${runId}`,
    });

    await openWorksTab(page);
    await inboxRow(page, target.title).getByRole('button', { name: '배정' }).click();
    const items = page.locator('.works-assign-inline .works-assign-work-item');
    await expect(items.nth(0)).toContainText(sameDir.title);
    // The panel has two option buttons; only the 기존 Work one describes the ranking.
    const existingOption = page.locator('.works-assign-option')
      .filter({ hasText: '기존 Work에 연결' });
    await expect(existingOption).toContainText('같은 폴더에서 나온 Work를 먼저 보여줍니다');

    // Turn it off through the panel the user actually has.
    await page.getByRole('button', { name: 'Works 설정' }).click();
    const settings = page.locator('.works-config');
    await expect(settings).toBeVisible();
    await settings.getByRole('checkbox', { name: '같은 폴더에서 나온 Work를 먼저 추천' }).uncheck();
    await settings.getByRole('button', { name: '저장' }).click();
    await expect.poll(
      async () => (await apiGetWorksConfig()).assignPreferSameDir,
      { timeout: 10_000 },
    ).toBe(false);

    // The panel is still open on the row behind the settings, and it reorders
    // where it stands — no reopen needed, which is also the stronger claim: the
    // setting takes effect on the panel the user is already looking at.
    await page.getByRole('button', { name: 'Works 설정' }).click();
    const reordered = page.locator('.works-assign-inline .works-assign-work-item');
    await expect(reordered.nth(0)).toContainText(elsewhere.title);
    await expect(reordered.nth(1)).toContainText(sameDir.title);
    await expect(page.locator('.works-assign-option').filter({ hasText: '기존 Work에 연결' }))
      .toContainText('최근에 움직인 Work부터 보여줍니다');
    // The 같은 디렉토리 mark describes the Work, not the ranking, so it stays.
    await expect(reordered.nth(1)).toContainText('같은 디렉토리');
  } finally {
    await apiSaveWorksConfig({ assignPreferSameDir: original.assignPreferSameDir });
  }
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

  // The row button only *asks*; the confirmation states the scope and is the
  // only thing that may send the sweep.
  const confirm = await openCompleteConfirm(page, workTitle);
  await expect(confirm).toContainText('카드 2장이 done 처리된 뒤 archive됩니다');
  // The numbers are tiles (label above value), not one `세션 1` chip.
  await expect(confirm.locator('.work-resolve-fact-card').filter({ hasText: '세션' }).locator('.work-resolve-stat'))
    .toHaveText('1');
  await confirm.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  await expect(confirm).toHaveCount(0);

  // The Work leaves Active for Resolved, which shows only its count until it
  // is expanded.
  await expect(active).toHaveCount(0);
  await expandResolved(page);
  const resolvedSection = page.locator('.works-section').filter({ hasText: '완료·폐기한 작업' });

  // It lost its 완료 button on the way.
  const resolved = workCard(page, workTitle);
  await expect(resolved).toHaveClass(/works-card--resolved/);
  await expect(resolved).toHaveClass(/works-card--done/);
  await expect(resolved.getByRole('button', { name: '완료…' })).toHaveCount(0);

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

/**
 * Cancelling the completion confirmation.
 *
 * The regression this pins: the list row's 완료 was a green primary button that
 * ran the irreversible bulk archive on one click, and the detail dialog chained
 * `.then(onClose)` onto a promise that resolved just as happily when the user
 * *declined* — so a cancelled confirmation closed the dialog and looked exactly
 * like a finished archive.
 */
test('완료 확인을 취소하면 Work는 active로 남고 카드도 archive되지 않는다', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `works-cancel-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const card = await seedCardWithStatus(
    { title: `[E2E ${runId}] 남아야 하는 카드`, description: '취소 fixture', projectDir: PROJECT_DIR },
    'complete',
    { sessionId, resolution: 'completed' },
  );

  const workTitle = `취소할 Work ${runId}`;
  const work = await seedWork({ title: workTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  const confirm = await openCompleteConfirm(page, workTitle);
  await expect(confirm).toContainText('카드 1장이 done 처리된 뒤 archive됩니다');
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toHaveCount(0);

  // Nothing was sent: still Active, still `active`, card still on the board.
  await expect(workCard(page, workTitle)).toHaveClass(/works-card--active/);
  const persisted = await apiGetWork(work.id);
  expect(persisted.status).toBe('active');
  expect(persisted.resolvedAt).toBeUndefined();
  expect(persisted.archivedAt).toBeUndefined();
  expect((await apiGetCards()).map((c) => c.id)).toContain(card.id);
  expect((await apiGetCards()).find((c) => c.id === card.id)?.status).toBe('complete');
});

test('상세에서 완료를 취소하면 상세 다이얼로그가 닫히지 않는다', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `works-detail-cancel-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const card = await seedCardWithStatus(
    { title: `[E2E ${runId}] 유지되는 카드`, description: '상세 취소 fixture', projectDir: PROJECT_DIR },
    'complete',
    { sessionId, resolution: 'completed' },
  );

  const workTitle = `상세 취소 Work ${runId}`;
  const work = await seedWork({ title: workTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, workTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: workTitle });
  await expect(detail).toBeVisible();

  await detail.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  const confirm = resolveConfirm(page, '완료');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toHaveCount(0);

  // The whole point: the detail dialog is still open, because nothing happened.
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '✔ 완료 (일괄 archive)' })).toBeEnabled();
  expect((await apiGetWork(work.id)).status).toBe('active');
  expect((await apiGetCards()).find((c) => c.id === card.id)?.status).toBe('complete');
});

test('폐기도 확인을 거치고, 취소하면 Work가 그대로 남는다', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `works-discard-cancel-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const card = await seedCardWithStatus(
    { title: `[E2E ${runId}] 폐기해도 남는 카드`, description: '폐기 fixture', projectDir: PROJECT_DIR },
    'complete',
    { sessionId, resolution: 'completed' },
  );

  const workTitle = `폐기할 Work ${runId}`;
  const work = await seedWork({ title: workTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, workTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: workTitle });

  // 폐기 used to fire straight off the button with no confirmation and no undo.
  await detail.getByRole('button', { name: '폐기…' }).click();
  const confirm = resolveConfirm(page, '폐기');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`"${workTitle}"을 폐기합니다.`);
  await expect(confirm).toContainText('보드에 그대로 남고');
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(detail).toBeVisible();
  expect((await apiGetWork(work.id)).status).toBe('active');

  // Confirming does discard it — and leaves the card on the board.
  await detail.getByRole('button', { name: '폐기…' }).click();
  await resolveConfirm(page, '폐기').getByRole('button', { name: '폐기', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect.poll(async () => (await apiGetWork(work.id)).status, { timeout: 10_000 })
    .toBe('discarded');
  expect((await apiGetCards()).find((c) => c.id === card.id)?.status).toBe('complete');
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
  await openTimeline(page);

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
  await openTimeline(page);

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
  const endInput = dialog.getByLabel('End', { exact: true });
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
  await openTimeline(page);

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
  const endField = dialog.locator('.work-meta-card').filter({ hasText: 'Planned end' });
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

test('Timeline says nothing ran when the range is empty', async ({ page }) => {
  await page.goto('/');
  await openTimeline(page);

  // Two weeks ahead: nothing can have *executed* there, and after
  // apiResetWorksState there is no Work whose bar reaches that far either. The
  // current week is never reliably empty — specs share one server, and every
  // executed card from an earlier spec file is a session row here.
  await page.getByRole('button', { name: '다음 주' }).click();
  await page.getByRole('button', { name: '다음 주' }).click();

  await expect(page.locator('.tl-empty')).toContainText('이 기간에 실행된 세션이 없습니다');
  await expect(page.locator('.tl-bar')).toHaveCount(0);
  await expect(page.locator('.tl-rail')).toHaveCount(0);
});

test('Timeline nests executed sessions under their Work and marks unassigned ones', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `tl-sessions-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const assignedSession = `claude-${runId}-assigned`;
  const looseSession = `claude-${runId}-loose`;

  // Executed: a Tuesday card that finished the same day → one day cell.
  await seedCardWithStatus({
    title: `[E2E ${runId}] 실행된 카드`,
    description: 'timeline executed fixture',
    projectDir: PROJECT_DIR,
    sessionId: assignedSession,
  }, 'complete', {
    startedAt: noonAfter(weekStart, 1),
    completedAt: noonAfter(weekStart, 1),
  });

  // Unassigned but executed — must still show, marked 미배정.
  await seedCardWithStatus({
    title: `[E2E ${runId}] 미배정 카드`,
    description: 'timeline unassigned fixture',
    projectDir: PROJECT_DIR,
    sessionId: looseSession,
  }, 'complete', {
    startedAt: noonAfter(weekStart, 2),
    completedAt: noonAfter(weekStart, 2),
  });

  // Never executed: no startedAt/completedAt, so the grid must ignore it no
  // matter how long it has been sitting in todo.
  const planned = await seedCardWithStatus({
    title: `[E2E ${runId}] 실행 안 된 카드`,
    description: 'timeline planned fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-planned`,
  }, 'todo');

  const workTitle = `타임라인 Work ${runId}`;
  const work = await seedWork({
    title: workTitle,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 0),
  });
  await apiAddWorkSession(work.id, { sessionId: assignedSession, projectDir: PROJECT_DIR });

  await page.goto('/');
  await openTimeline(page);

  // Directory group → Work bracket → session row. Every locator is scoped to
  // this run's own ids: specs share one server, so earlier spec files' executed
  // cards are legitimately session rows on this same grid.
  await expect(page.locator('.tl-label--dir').filter({ hasText: 'works-e2e-project' }))
    .toHaveCount(1);
  const workLabel = page.locator('.tl-label--work').filter({ hasText: workTitle });
  await expect(workLabel).toHaveCount(1);
  // Works open collapsed: the bracket alone stands for its sessions until the
  // caret is clicked, and the row under test is one of those sessions.
  await expect(sessionRow(page, assignedSession)).toHaveCount(0);
  await expect(workLabel).toContainText('펼치기');
  await workLabel.locator('.tl-group-toggle--caret').click();

  const assignedRow = sessionRow(page, assignedSession);
  await expect(assignedRow.locator('.tl-label--session')).toHaveCount(1);
  await expect(assignedRow.locator('.tl-unassigned')).toHaveCount(0);

  const looseRow = sessionRow(page, looseSession);
  await expect(looseRow.locator('.tl-unassigned')).toHaveText('미배정');

  // The unexecuted card contributes neither a row nor a day cell.
  await expect(sessionRow(page, `claude-${runId}-planned`)).toHaveCount(0);
  await expect(page.locator(`.tl-day[title*="${planned.title}"]`)).toHaveCount(0);

  // A card that ran on Tuesday occupies exactly Tuesday's column (grid col 3).
  const dayCell = assignedRow.locator('.tl-day-slot');
  await expect(dayCell).toHaveCount(1);
  await expect(dayCell.locator('.tl-day--complete')).toHaveCount(1);
  expect((await gridColumnBounds(dayCell)).start).toBe('3');

  // Assigning the loose session moves its row under the (now expanded) Work.
  // Addressed by class, not getByRole: `.tl-row` is `display: contents` (its
  // children place themselves on the parent grid), and role queries scoped
  // under a box-less ancestor do not resolve.
  await looseRow.locator('.tl-assign-btn').click();
  const modal = page.getByRole('dialog', { name: '세션 배정' });
  await expect(modal).toBeVisible();
  await modal.locator('.bulk-assign-option').filter({ hasText: workTitle }).click();
  await modal.getByRole('button', { name: '연결하고 다음 →' }).click();

  await expect.poll(async () => (await apiGetWork(work.id)).sessionLinks.length, { timeout: 10_000 })
    .toBe(2);
  await expect.poll(
    async () => sessionRow(page, looseSession)
      .locator('.tl-unassigned').count(),
    { timeout: 15_000 },
  ).toBe(0);
  await expect(sessionRow(page, looseSession)).toHaveCount(1);
  await expect(page.locator('.tl-label--work').filter({ hasText: workTitle }))
    .toContainText('세션 2');
});

/**
 * A discarded session keeps its Timeline row (the work really ran) but must not
 * offer 배정: it left the Inbox, which is the only source of the DTO the assign
 * modal needs, so the button opened nothing and stayed dead forever.
 */
test('폐기한 세션은 Timeline에 남지만 배정 버튼을 갖지 않는다', async ({
  page, seedCardWithStatus,
}) => {
  const runId = `tl-ignored-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const discarded = `claude-${runId}-discarded`;
  const kept = `claude-${runId}-kept`;

  for (const sessionId of [discarded, kept]) {
    await seedCardWithStatus({
      title: `[E2E ${runId}] ${sessionId}`,
      description: 'timeline ignored fixture',
      projectDir: PROJECT_DIR,
      sessionId,
    }, 'complete', {
      startedAt: noonAfter(weekStart, 1),
      completedAt: noonAfter(weekStart, 1),
    });
  }
  await apiIgnoreWorkSession(discarded);

  await page.goto('/');
  await openTimeline(page);

  const discardedRow = sessionRow(page, discarded);
  await expect(discardedRow.locator('.tl-ignored')).toHaveText('폐기');
  await expect(discardedRow.locator('.tl-assign-btn')).toHaveCount(0);
  await expect(discardedRow.locator('.tl-unassigned')).toHaveCount(0);

  // The session next to it is untouched: still 미배정, still assignable.
  const keptRow = sessionRow(page, kept);
  await expect(keptRow.locator('.tl-unassigned')).toHaveText('미배정');
  await expect(keptRow.locator('.tl-assign-btn')).toHaveCount(1);
});

/** ISO local noon `days` before today — safely inside that day's column. */
function noonDaysAgo(days: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0, 0).toISOString();
}

/** `M/D`, matching `formatShortDate`'s ko-KR output in `worksAssign.ts`. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * A Work whose bar is cut by the left edge of the current week: it started
 * eleven days ago and is still open, so it is drawn from column 0 while its real
 * start is off-screen.
 */
async function seedClippedWork(title: string): Promise<{ id: string; startedAt: string }> {
  const startedAt = noonDaysAgo(11);
  const work = await apiCreateWork({ title, projectDir: PROJECT_DIR, startedAt });
  return { id: work.id, startedAt };
}

/**
 * Keyboard editing of a bar whose left edge is a *cut*.
 *
 * The nudge used to read the bar's clamped column, so `→` on a Work that
 * started eleven days before the visible week rewrote `startedAt` to the day
 * after the week's Monday — nearly two weeks forward, with no undo. It must
 * move the real date by exactly one day.
 */
test('Timeline의 잘린 바를 →로 옮기면 실제 시작일 기준으로 하루만 움직인다', async ({
  page, trackWork,
}) => {
  const runId = `tl-clip-nudge-${Date.now()}`;
  const title = `잘린 Work ${runId}`;
  const { id, startedAt } = await seedClippedWork(title);
  trackWork(id);

  await page.goto('/');
  await openTimeline(page);

  const slot = barSlot(page, title);
  await expect(slot).toBeVisible();
  // Drawn from the first day column even though it began eleven days earlier.
  await expect(slot.locator('.tl-bar')).toHaveClass(/tl-bar--clipped-left/);
  expect((await gridColumnBounds(slot)).start).toBe('2');
  await expect(slot.locator('.tl-bar-edge')).toContainText(shortDate(startedAt));

  const handle = slot.locator('.tl-bar-handle--start');
  // The slider announces the *real* start, not the column it is drawn at.
  await expect(handle).toHaveAttribute('aria-valuetext', shortDate(startedAt));

  // Focused rather than clicked: a clipped bar's start handle sits under the
  // sticky label column (higher z-index), so a synthetic click there is
  // geometry-dependent. The click → focus path has its own test below.
  await handle.focus();
  await handle.press('ArrowRight');

  await expect.poll(async () => (await apiGetWork(id)).startedAt, { timeout: 10_000 })
    .toBe(noonDaysAgo(10));

  // …and the edit is reversible, because nothing confirmed it.
  const notice = page.locator('.work-session-notice');
  await expect(notice).toContainText('시작일');
  await notice.getByRole('button', { name: '되돌리기' }).click();
  await expect.poll(async () => (await apiGetWork(id)).startedAt, { timeout: 10_000 })
    .toBe(startedAt);
});

/**
 * Clicking a resize handle has to focus it. `beginDrag` calls
 * `preventDefault()` (it must, to take pointer capture), which also suppresses
 * the implicit focus a `tabIndex` element would get — so the documented
 * "focus the handle and press ←/→" was reachable by Tab only, and pressing `→`
 * right after a click moved focus to the 월간 button instead.
 */
test('Timeline 손잡이를 클릭하면 포커스가 그 손잡이로 간다', async ({ page, trackWork }) => {
  const runId = `tl-focus-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const title = `포커스 Work ${runId}`;

  const work = await apiCreateWork({
    title,
    projectDir: PROJECT_DIR,
    startedAt: noonAfter(weekStart, 2), // Wednesday — clear of the label column
  });
  trackWork(work.id);
  await apiUpdateWork(work.id, { status: 'done', resolvedAt: noonAfter(weekStart, 3) });

  await page.goto('/');
  await openTimeline(page);

  const slot = barSlot(page, title);
  await expect(slot).toBeVisible();
  await slot.locator('.tl-bar-handle--start').click();

  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-tl-handle')))
    .toBe('start');
  // A press without a drag still writes nothing.
  expect((await apiGetWork(work.id)).startedAt).toBe(noonAfter(weekStart, 2));

  // With focus where the click put it, the arrow keys edit the date instead of
  // walking the toolbar.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await apiGetWork(work.id)).startedAt, { timeout: 10_000 })
    .toBe(noonAfter(weekStart, 1));
});

/**
 * The Board's project switcher is hidden in this view, which left a busy grid
 * with no filter at all — only per-group collapsing. This one is built from the
 * grid's own directory groups.
 */
test('Timeline의 디렉토리 필터가 다른 프로젝트 행을 걸러낸다', async ({
  page, seedCardWithStatus,
}) => {
  const runId = `tl-dirfilter-${Date.now()}`;
  const weekStart = mondayOf(new Date());
  const otherDir = `${PROJECT_DIR}-other`;
  const mine = `claude-${runId}-mine`;
  const theirs = `claude-${runId}-theirs`;

  await seedCardWithStatus({
    title: `[E2E ${runId}] 이쪽 카드`,
    description: 'timeline dir filter fixture',
    projectDir: PROJECT_DIR,
    sessionId: mine,
  }, 'complete', {
    startedAt: noonAfter(weekStart, 1),
    completedAt: noonAfter(weekStart, 1),
  });
  await seedCardWithStatus({
    title: `[E2E ${runId}] 저쪽 카드`,
    description: 'timeline dir filter fixture',
    projectDir: otherDir,
    sessionId: theirs,
  }, 'complete', {
    startedAt: noonAfter(weekStart, 2),
    completedAt: noonAfter(weekStart, 2),
  });

  await page.goto('/');
  await openTimeline(page);

  const filter = page.locator('.tl-dir-filter');
  await expect(filter).toBeVisible();
  await expect(sessionRow(page, mine)).toHaveCount(1);
  await expect(sessionRow(page, theirs)).toHaveCount(1);

  // Selecting one directory drops the other one's rows, group header included.
  await filter.getByRole('button', { name: /works-e2e-project-other/ }).click();
  await expect(sessionRow(page, theirs)).toHaveCount(1);
  await expect(sessionRow(page, mine)).toHaveCount(0);
  await expect(page.locator('.tl-label--dir')).toHaveCount(1);

  // 전체 puts everything back.
  await filter.getByRole('button', { name: '전체' }).click();
  await expect(sessionRow(page, mine)).toHaveCount(1);
  await expect(sessionRow(page, theirs)).toHaveCount(1);
});

/**
 * A failed window used to print the route's own words (`Not found`) over a
 * fully drawn, session-free grid — two signals that together read "nothing ran
 * this week" when the truth was "we never got an answer".
 */
test('Timeline이 응답을 못 받으면 사용자 문장으로 알리고 그리드를 흐리게 한다', async ({ page }) => {
  await page.route('**/api/timeline?**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Not found' }),
  }));

  await page.goto('/');
  await openTimeline(page);

  const banner = page.locator('.error-banner').filter({ hasText: '타임라인' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('데몬');
  await expect(banner).not.toContainText('Not found');

  // The grid says it is not the answer, rather than an empty week.
  await expect(page.locator('.timeline--errored')).toHaveCount(1);
  await expect(page.locator('.tl-empty')).toContainText('불러오지 못해');
});

/** Local midnight `days` before today — a stable anchor that is always past. */
function daysAgo(days: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
}

test('⋯ 메뉴의 세션 이동은 양쪽 시작일을 다시 계산하고, 비워진 원본 Work를 삭제한다', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `works-move-${Date.now()}`;
  const anchor = daysAgo(30);
  // Three distinct calendar days so a re-dating is visible as a M/D change,
  // and all in the past so nothing depends on which weekday the suite runs on.
  const oldest = noonAfter(anchor, 0);
  const middle = noonAfter(anchor, 4);
  const newest = noonAfter(anchor, 8);

  const oldSession = `claude-${runId}-old`;
  const keepSession = `claude-${runId}-keep`;
  const targetSession = `claude-${runId}-target`;

  const oldCard = await seedCardWithStatus(
    {
      title: `[E2E ${runId}] 가장 오래된 세션`,
      description: '세션 이동 fixture 1',
      projectDir: PROJECT_DIR,
      sessionId: oldSession,
    },
    'todo',
    { startedAt: oldest },
  );
  const keepCard = await seedCardWithStatus(
    {
      title: `[E2E ${runId}] 남는 세션`,
      description: '세션 이동 fixture 2',
      projectDir: PROJECT_DIR,
      sessionId: keepSession,
    },
    'todo',
    { startedAt: middle },
  );
  await seedCardWithStatus(
    {
      title: `[E2E ${runId}] 대상 Work 세션`,
      description: '세션 이동 fixture 3',
      projectDir: PROJECT_DIR,
      sessionId: targetSession,
    },
    'todo',
    { startedAt: newest },
  );

  const sourceTitle = `원본 Work ${runId}`;
  const targetTitle = `대상 Work ${runId}`;
  const source = await seedWork({ title: sourceTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(source.id, { sessionId: oldSession, projectDir: PROJECT_DIR, role: 'dev' });
  await apiAddWorkSession(source.id, { sessionId: keepSession, projectDir: PROJECT_DIR, role: 'review' });
  const target = await seedWork({ title: targetTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(target.id, { sessionId: targetSession, projectDir: PROJECT_DIR, role: 'dev' });

  // `startedAt` is min() over every linked session's earliest card time.
  expect((await apiGetWork(source.id)).startedAt).toBe(oldest);
  expect((await apiGetWork(target.id)).startedAt).toBe(newest);

  await openWorksTab(page);
  await workCard(page, sourceTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: sourceTitle });
  await expect(detail).toBeVisible();

  // ── 이동 1: 원본이 세션 1개를 남기고 살아남는 경우 ────────────────────────
  const oldRow = detail.locator('.work-session-item').filter({ hasText: oldCard.title });
  await oldRow.getByRole('button', { name: '세션 작업 메뉴' }).click();
  await page.getByRole('menuitem', { name: '↪ 다른 Work로 이동…' }).click();

  const moveDialog = page.getByRole('dialog', { name: '세션 이동' });
  await expect(moveDialog.locator('.works-assign-current')).toContainText(sourceTitle);
  // "이미 속한 Work로 이동"은 목적지가 아니므로 추천에서 빠진다.
  const destinations = moveDialog.locator('.works-assign-work-item');
  await expect(destinations).toHaveCount(1);
  await destinations.filter({ hasText: targetTitle }).click();

  // 영향 미리보기: 양쪽 시작일이 모두 바뀐다 (원본은 뒤로, 대상은 앞으로).
  const preview = moveDialog.locator('.works-move-preview li');
  await expect(preview).toHaveCount(2);
  await expect(preview.nth(0)).toContainText(`"${sourceTitle}"의 시작일이`);
  await expect(preview.nth(1)).toContainText(`"${targetTitle}"의 시작일이`);

  await moveDialog.getByRole('button', { name: `"${targetTitle}"(으)로 이동` }).click();
  await expect(moveDialog).toHaveCount(0);

  const notice = page.locator('.work-session-notice');
  await expect(notice).toContainText(`✓ 세션을 "${targetTitle}"으로 옮겼습니다.`);
  // 되돌릴 수 있는 이동이므로 undo가 붙는다.
  await expect(notice.getByRole('button', { name: '되돌리기' })).toBeVisible();

  // 미리보기가 예고한 대로 양쪽 startedAt이 실제로 다시 계산됐다.
  expect((await apiGetWork(source.id)).startedAt).toBe(middle);
  const afterFirst = await apiGetWork(target.id);
  expect(afterFirst.startedAt).toBe(oldest);
  expect(afterFirst.sessionLinks.find((link) => link.sessionId === oldSession))
    .toMatchObject({ sessionId: oldSession, role: 'dev' });

  // ── 이동 2: 마지막 세션까지 옮겨 원본이 비는 경우 ────────────────────────
  const keepRow = detail.locator('.work-session-item').filter({ hasText: keepCard.title });
  await keepRow.getByRole('button', { name: '세션 작업 메뉴' }).click();
  await page.getByRole('menuitem', { name: '↪ 다른 Work로 이동…' }).click();

  await expect(moveDialog).toBeVisible();
  // 대상 시작일은 이미 oldest이므로 바뀌지 않고, 원본 삭제만 예고된다.
  await expect(moveDialog.locator('.works-move-preview li')).toHaveCount(1);
  await expect(moveDialog.locator('.works-move-preview'))
    .toContainText(`마지막 세션이므로 "${sourceTitle}" Work는 삭제됩니다.`);
  await moveDialog.locator('.works-assign-work-item').filter({ hasText: targetTitle }).click();
  await moveDialog.getByRole('button', { name: `"${targetTitle}"(으)로 이동` }).click();

  // 원본이 삭제되면 상세 다이얼로그도 함께 닫히고, 알림만 남는다.
  await expect(detail).toHaveCount(0);
  await expect(page.locator('.work-session-notice--warn')).toContainText(
    `✓ 세션을 "${targetTitle}"으로 옮기고, 비워진 Work "${sourceTitle}"를 삭제했습니다.`,
  );
  // 삭제된 Work는 id/Summary/createdAt을 복구할 수 없으므로 undo를 주지 않는다.
  await expect(page.locator('.work-session-notice').getByRole('button', { name: '되돌리기' }))
    .toHaveCount(0);

  await expect(workCard(page, sourceTitle)).toHaveCount(0);
  await expect(workCard(page, targetTitle)).toContainText('세션 3');

  const works = await apiGetWorks();
  expect(works.map((work) => work.id)).not.toContain(source.id);
  const merged = works.find((work) => work.id === target.id);
  expect(merged?.startedAt).toBe(oldest);
  expect(merged?.sessionLinks.map((link) => [link.sessionId, link.role])).toEqual(
    expect.arrayContaining([
      [targetSession, 'dev'],
      [oldSession, 'dev'],
      // 링크가 그대로 옮겨오므로 원래 역할(리뷰)이 유지된다.
      [keepSession, 'review'],
    ]),
  );
  // 이동은 세션을 Inbox로 돌려보내지 않는다.
  expect(await apiGetWorkInbox()).toHaveLength(0);
});

test('Work 삭제는 확인을 거쳐 세션만 Inbox로 되돌리고 카드는 보드에 남긴다', async ({
  page, seedCard, seedWork,
}) => {
  const runId = `works-delete-${Date.now()}`;
  const sessionIds = [`claude-${runId}-1`, `claude-${runId}-2`];
  const cards = [];
  for (const [index, sessionId] of sessionIds.entries()) {
    cards.push(await seedCard({
      title: `[E2E ${runId}] 세션 ${index + 1}`,
      description: 'Work 삭제 fixture',
      projectDir: PROJECT_DIR,
      sessionId,
    }));
  }

  const title = `삭제할 Work ${runId}`;
  const work = await seedWork({ title, projectDir: PROJECT_DIR });
  for (const sessionId of sessionIds) {
    await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });
  }

  await openWorksTab(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: title });
  await expect(detail).toBeVisible();

  // 되돌릴 수 없는 동작이므로 확인을 생략하지 않는다 — 취소하면 아무 일도 없다.
  let prompted = '';
  page.once('dialog', (dialog) => {
    prompted = dialog.message();
    void dialog.dismiss();
  });
  await detail.getByRole('button', { name: '삭제…' }).click();
  await expect(detail).toBeVisible();
  expect(prompted).toContain(`"${title}"을 삭제합니다.`);
  expect(prompted).toContain('연결된 세션 2개는 Inbox로 돌아가고, 카드는 보드에 그대로 남습니다.');
  expect((await apiGetWork(work.id)).sessionLinks).toHaveLength(2);

  page.once('dialog', (dialog) => { void dialog.accept(); });
  await detail.getByRole('button', { name: '삭제…' }).click();

  // 성공하면 다이얼로그가 닫히고 Works 목록 + Inbox가 갱신된다.
  await expect(detail).toHaveCount(0);
  await expect(workCard(page, title)).toHaveCount(0);
  await expect(page.getByText('미배정 세션 2개')).toBeVisible();
  await expect(worksTabBadge(page)).toHaveText('2');

  expect((await apiGetWorks()).map((entry) => entry.id)).not.toContain(work.id);
  expect((await apiGetWorkInbox()).map((session) => session.sessionId).sort())
    .toEqual([...sessionIds].sort());
  // 삭제는 Work만 없앤다 — 카드는 archive되지도, 지워지지도 않는다.
  const board = (await apiGetCards()).map((card) => card.id);
  for (const card of cards) expect(board).toContain(card.id);
});

/**
 * A link whose session lost every card.
 *
 * Deleting a card never told Works about it, so the link stayed and
 * `resolveWorkStartedAt` fell back to its `linkedAt` — the Timeline bar silently
 * started at triage time instead of when the work began, and the detail dialog
 * kept offering a 대화 button into a session that no longer existed. The row now
 * says so and the footer offers the one-click cleanup.
 */
test('카드가 모두 삭제된 세션은 상세에서 경고로 표시되고 정리할 수 있다', async ({
  page, seedCard, seedWork, trackWork,
}) => {
  const runId = `works-dangling-${Date.now()}`;
  const keepSession = `claude-${runId}-keep`;
  const goneSession = `claude-${runId}-gone`;

  const keepCard = await seedCard({
    title: `[E2E ${runId}] 남는 카드`,
    description: 'dangling fixture keep',
    projectDir: PROJECT_DIR,
    sessionId: keepSession,
  });
  const doomedCard = await seedCard({
    title: `[E2E ${runId}] 지울 카드`,
    description: 'dangling fixture doomed',
    projectDir: PROJECT_DIR,
    sessionId: goneSession,
  });
  // The doomed session is the older one, so its link is what currently sets the
  // bar's left edge — which is exactly what a dangling link distorts.
  const oldest = '2026-08-01T00:00:00.000Z';
  const later = '2026-08-20T00:00:00.000Z';
  await apiUpdateCard(doomedCard.id, { startedAt: oldest });
  await apiUpdateCard(keepCard.id, { startedAt: later });

  const title = `끊긴 세션 Work ${runId}`;
  const work = await seedWork({ title, projectDir: PROJECT_DIR });
  trackWork(work.id);
  await apiAddWorkSession(work.id, { sessionId: goneSession, projectDir: PROJECT_DIR, role: 'dev' });
  await apiAddWorkSession(work.id, { sessionId: keepSession, projectDir: PROJECT_DIR, role: 'review' });
  expect((await apiGetWork(work.id)).startedAt).toBe(oldest);

  await apiDeleteCard(doomedCard.id);
  // The delete route reconciles the owning Work's links on the way out.
  expect((await apiGetWork(work.id)).sessionLinks
    .find((link) => link.sessionId === goneSession)?.cardsMissingAt).toBeTruthy();

  await openWorksTab(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: title });
  await expect(detail).toBeVisible();

  const missingRow = detail.locator('.work-session-item--missing');
  await expect(missingRow).toHaveCount(1);
  await expect(missingRow).toContainText('카드가 하나도 남아 있지 않습니다');
  // The healthy row is left alone.
  await expect(detail.locator('.work-session-item')).toHaveCount(2);

  const prune = detail.getByRole('button', { name: /끊긴 세션 정리 \(1\)/ });
  await expect(prune).toBeVisible();

  // Confirmed, because a session with no cards does not come back to the Inbox.
  let prompted = '';
  page.once('dialog', (dialog) => {
    prompted = dialog.message();
    void dialog.dismiss();
  });
  await prune.click();
  expect(prompted).toContain('카드가 하나도 남지 않은 세션 1개의 연결을 끊습니다.');
  expect((await apiGetWork(work.id)).sessionLinks).toHaveLength(2);

  page.once('dialog', (dialog) => { void dialog.accept(); });
  await prune.click();

  await expect(detail.locator('.work-session-item--missing')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /끊긴 세션 정리/ })).toHaveCount(0);

  const pruned = await apiGetWork(work.id);
  expect(pruned.sessionLinks.map((link) => link.sessionId)).toEqual([keepSession]);
  // The bar's start is min() over what is left, not the removed link's linkedAt.
  expect(pruned.startedAt).toBe(later);
});

/**
 * Expand ✅ Resolved — it is collapsed to a count until asked for.
 *
 * Waits for the section itself first: it only mounts once the Works fetch has a
 * resolved Work, so reading `count()` right after the tab click could see zero
 * toggles, skip the click, and leave the list collapsed.
 */
async function expandResolved(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^완료·폐기 \d/ }).click();
  await expect(page.locator('.works-section').filter({ hasText: '완료·폐기한 작업' })).toBeVisible();
}

/**
 * Reading a Work *after* it has been completed — the whole point of the entity.
 *
 * Completing bulk-archives every card under it, so a detail dialog that derived
 * its numbers from the board list reported `카드 0 · done 0` and fell back to raw
 * session ids, and the 대화 button did nothing at all. The counts and titles
 * asserted here come from `GET /api/works/:id/sessions`, which reads the archive.
 */
test('완료된 Work 상세는 archive된 산출물과 세션 제목을 그대로 보여주고 대화를 연다', async ({
  page, seedCardWithStatus, seedWork,
}) => {
  const runId = `works-resolved-detail-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const firstTitle = `[E2E ${runId}] 첫 프롬프트`;
  const secondTitle = `[E2E ${runId}] 두 번째 턴`;
  const anchor = daysAgo(4);

  await seedCardWithStatus({
    title: firstTitle,
    description: '완료 후 상세 fixture 1',
    projectDir: PROJECT_DIR,
    sessionId,
  }, 'complete', {
    startedAt: noonAfter(anchor, 0),
    completedAt: noonAfter(anchor, 0),
    result: '첫 턴의 결과입니다.',
  });
  await seedCardWithStatus({
    title: secondTitle,
    description: '완료 후 상세 fixture 2',
    projectDir: PROJECT_DIR,
    sessionId,
  }, 'complete', {
    startedAt: noonAfter(anchor, 1),
    completedAt: noonAfter(anchor, 1),
    result: '두 번째 턴의 결과입니다.',
  });

  const title = `완료 후 되돌아볼 Work ${runId}`;
  const work = await seedWork({ title, projectDir: PROJECT_DIR, startedAt: noonAfter(anchor, 0) });
  await apiAddWorkSession(work.id, { sessionId, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const open = page.getByRole('dialog', { name: title });
  await expect(open.locator('.work-wiki-archive')).toHaveCount(0);
  const sessionRow = open.locator('.work-session-item');
  await expect(sessionRow.locator('.work-session-title')).toHaveText(firstTitle);

  // Complete from the dialog: the same PATCH the list row sends, behind the same
  // confirmation. The detail dialog closes only once the transition landed.
  await open.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  const detailConfirm = resolveConfirm(page, '완료');
  await expect(detailConfirm).toBeVisible();
  await detailConfirm.getByRole('button', { name: '✔ 완료 (일괄 archive)' }).click();
  await expect(detailConfirm).toHaveCount(0);
  await expect(open).toHaveCount(0);
  await expect.poll(async () => (await apiGetWork(work.id)).archivedAt ?? null, { timeout: 10_000 })
    .not.toBeNull();
  // Nothing of this session is left on the board — the pre-fix source of truth.
  await expect.poll(
    async () => (await apiGetCards()).filter((card) => card.sessionId === sessionId).length,
    { timeout: 10_000 },
  ).toBe(0);

  await expandResolved(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const resolved = page.getByRole('dialog', { name: title });
  await expect(resolved).toBeVisible();

  // 산출물 survives the sweep: same card count as before, now all done.
  // The archive sweep queues the cards for the wiki, so this is "생성 대기 중",
  // never the old unconditional "아직 없음".
  await expect(resolved.getByLabel('보관된 Work의 Wiki')).toContainText('생성 대기 중');

  // The session keeps its prompt title and card count instead of collapsing to
  // a short session id.
  const resolvedRow = resolved.locator('.work-session-item');
  await expect(resolvedRow.locator('.work-session-title')).toHaveText(firstTitle);
  await expect(resolvedRow.locator('.work-session-meta')).toContainText('카드 2');
  await expect(resolvedRow.locator('.work-session-meta')).toContainText('보관됨');

  // 대화 now opens the conversation off the archive.
  await resolvedRow.getByRole('button', { name: '대화' }).click();
  const conversation = page.locator('.session-conversation-dialog');
  await expect(conversation).toBeVisible();
  // The header carries the session's own title; the turns carry each card's
  // prompt and result — all of it read out of the archive.
  await expect(conversation).toContainText(firstTitle);
  await expect(conversation.locator('.kv2-complete-session-turn')).toHaveCount(2);
  await expect(conversation).toContainText('첫 턴의 결과입니다.');
  await expect(conversation).toContainText('두 번째 턴의 결과입니다.');
});

test('완료된 Work 상세는 완료 안내를 감추고 기간을 resolvedAt에 고정한다', async ({
  page, seedWork,
}) => {
  const runId = `works-resolved-span-${Date.now()}`;
  const anchor = daysAgo(10);
  const startedAt = noonAfter(anchor, 0);
  const resolvedAt = endOfDayAfter(anchor, 2);

  const title = `기간 고정 Work ${runId}`;
  const work = await seedWork({ title, projectDir: PROJECT_DIR, startedAt });
  // A planned end set first survives completion, which makes the span a fixed
  // fixture value rather than "whenever the test happened to run".
  await apiUpdateWork(work.id, { resolvedAt });
  await apiUpdateWork(work.id, { status: 'done', confirmArchive: true });

  // startedAt → resolvedAt spans two-and-a-bit days: 3 inclusive. The bug was
  // that this counted from startedAt to *today* (11일째 here) forever.
  const expectedDays = Math.floor(
    (Date.parse(resolvedAt) - Date.parse(startedAt)) / 86_400_000,
  ) + 1;
  expect(expectedDays).toBe(3);

  await openWorksTab(page);
  await expandResolved(page);
  await workCard(page, title).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: title });
  await expect(detail).toBeVisible();

  // One badge, and it says the span rather than "n일째" — a Work finished in
  // March is not on its 190th day.
  await expect(detail.locator('.work-status')).toHaveText(`완료 · ${expectedDays}일 소요`);
  // The 기간 row no longer repeats the day count the badge already carries; it
  // adds the resolution date and the last activity.
  await expect(detail.locator('.work-detail-facts')).not.toContainText('일째');
  await expect(detail.locator('.work-detail-facts')).not.toContainText('active');
  // The resolution date lives in the End field, not repeated in Last activity.
  await expect(detail.getByLabel('End', { exact: true })).not.toHaveValue('');

  // The "✅ 완료 시: …" notice describes an action this Work no longer has, and
  // 폐기 would overwrite the resolution the sweep already recorded.
  await expect(detail.locator('.work-detail-note')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '폐기…' })).toBeDisabled();
  // 완료 is not merely disabled but gone: a greyed-out primary still read as
  // "click me", and the slot now holds the transition this Work does have.
  await expect(detail.getByRole('button', { name: '✔ 완료 (일괄 archive)' })).toHaveCount(0);
  // …and no 다시 열기 in its place: a finished record has no primary action.
  await expect(detail.getByRole('button', { name: '다시 열기', exact: true })).toBeEnabled();
});

test('Timeline의 archive된 카드 날짜 칸을 누르면 카드 상세가 열린다', async ({
  page, seedCardWithStatus,
}) => {
  const runId = `tl-archived-${Date.now()}`;
  const sessionId = `claude-${runId}`;
  const weekStart = mondayOf(new Date());
  const cardTitle = `[E2E ${runId}] archive된 실행 카드`;

  const card = await seedCardWithStatus({
    title: cardTitle,
    description: 'timeline archived fixture',
    projectDir: PROJECT_DIR,
    sessionId,
  }, 'complete', {
    startedAt: noonAfter(weekStart, 1),
    completedAt: noonAfter(weekStart, 1),
    result: 'archive된 카드의 결과입니다.',
  });

  // Sweep it off the board exactly the way a Work completion does.
  await apiUpdateCard(card.id, { status: 'done' });
  const { archivedCount } = await apiArchiveCards([card.id]);
  expect(archivedCount).toBe(1);
  expect((await apiGetCards()).map((entry) => entry.id)).not.toContain(card.id);

  await page.goto('/');
  await openTimeline(page);

  // The grid still draws it — `/api/timeline` reads the archive by month.
  const row = sessionRow(page, sessionId);
  const dayCell = row.locator('.tl-day-slot');
  await expect(dayCell).toHaveCount(1);

  // One card in the cell → card detail. Before the fix this fetched the board
  // card, got a 404, and failed silently as an unhandled rejection.
  await dayCell.locator('.tl-day').click();
  const detail = page.locator('.kv2-dialog--detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(cardTitle);
  await expect(detail).toContainText('archive된 카드의 결과입니다.');

  // The board poll must not close a dialog whose card is legitimately off the
  // board (board polling runs every 3s).
  await page.waitForTimeout(4_000);
  await expect(detail).toBeVisible();
});

/**
 * ② 메모.
 *
 * A Work had no human-writable free-text field at all. `summary` looks like one
 * and is not: it is regenerated from transcripts by an LLM and overwritten
 * wholesale on every ↻ 다시 생성, so anything typed there is lost.
 */
test('상세의 메모는 저장 후 새로고침해도 남는다', async ({ page, seedWork }) => {
  const runId = `works-notes-${Date.now()}`;
  const workTitle = `메모할 Work ${runId}`;
  const work = await seedWork({ title: workTitle, projectDir: PROJECT_DIR });

  await openWorksTab(page);
  await workCard(page, workTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: workTitle });
  // 메모 opens folded when empty — a disclosure heading, like the card detail's
  // sections — so the textarea appears only after the heading is clicked.
  await detail.locator('.work-detail-disclosure').click();
  const notes = detail.getByLabel('메모', { exact: true });
  await expect(notes).toBeVisible();
  await expect(notes).toHaveValue('');

  // Commits on an explicit button, not on blur: a multi-line note is long
  // enough that clicking away mid-thought is normal.
  const text = '락 순서 정리부터 다시. 완료 전에 wiki 큐 확인.';
  await notes.fill(text);
  await expect(detail.getByText('저장하지 않은 변경')).toBeVisible();
  await detail.getByRole('button', { name: '메모 저장' }).click();
  await expect(detail.getByText('저장하지 않은 변경')).toHaveCount(0);
  expect((await apiGetWork(work.id)).notes).toBe(text);

  // Reload, reopen: still there, and not folded into the LLM Summary.
  await openWorksTab(page);
  await workCard(page, workTitle).getByRole('button', { name: '상세', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: workTitle });
  // A saved note opens unfolded: it is the reason the reader came back.
  await expect(reopened.getByLabel('메모', { exact: true })).toHaveValue(text);
  await expect(reopened.locator('.work-summary')).not.toContainText('락 순서');
});

/**
 * ③ 검색·필터·정렬.
 *
 * The Active list was `updatedAt` descending with no controls — which is the
 * wrong order for the question it is usually asked, because a Work nobody has
 * touched for weeks sank to where it was already invisible.
 */
test('Active 목록은 검색으로 걸러지고 오래 방치된 순으로 다시 정렬된다', async ({
  page, seedWork,
}) => {
  const runId = `works-sort-${Date.now()}`;
  const stale = await seedWork({ title: `방치된 wiki Work ${runId}`, projectDir: PROJECT_DIR });
  const fresh = await seedWork({ title: `최근 wiki Work ${runId}`, projectDir: PROJECT_DIR });
  const other = await seedWork({ title: `타임라인 Work ${runId}`, projectDir: PROJECT_DIR });
  // A patch bumps `updatedAt`, so this pins the order rather than relying on
  // creation timestamps landing in distinct milliseconds.
  await apiUpdateWork(stale.id, { notes: '가장 오래 방치됨' });
  await apiUpdateWork(other.id, { notes: '중간' });
  await apiUpdateWork(fresh.id, { notes: '가장 최근' });

  await openWorksTab(page);
  const activeSection = page.locator('.works-section').filter({ hasText: '진행 중인 작업' });
  const titles = () => activeSection.locator('.works-card .works-card-title');
  await expect(titles()).toHaveCount(3);

  // Default is 최근 활동, so the newest patch is first.
  await expect(titles().first()).toHaveText(`최근 wiki Work ${runId}`);

  // Search reaches the title; the heading reports the narrowing.
  await activeSection.getByLabel('Work 검색').fill('wiki');
  await expect(titles()).toHaveCount(2);
  await expect(activeSection).toContainText('2 / 3개');
  await expect(activeSection).not.toContainText(`타임라인 Work ${runId}`);

  // 오래 방치된 순 is the exact mirror — the longest untouched Work first.
  await activeSection.getByLabel('정렬').selectOption('stale');
  await expect(titles().first()).toHaveText(`방치된 wiki Work ${runId}`);

  // A query that matches nothing says so instead of looking like an empty tab.
  await activeSection.getByLabel('Work 검색').fill('존재하지-않는-검색어');
  await expect(activeSection).toContainText('검색·필터 조건에 맞는 Work가 없습니다');
});

/**
 * ④ 병합.
 *
 * Two Works turning out to be one piece of work is routine, and the only way to
 * reconcile them was to move sessions out one at a time until the source
 * emptied — at which point the server *deletes* it, taking its Summary, notes
 * and Timeline history with it, with no undo.
 */
test('다른 Work에 병합하면 세션이 합쳐지고 원본은 병합됨으로 남는다', async ({
  page, seedCard, seedWork,
}) => {
  const runId = `works-merge-${Date.now()}`;
  const fromSession = `claude-${runId}-from`;
  const toSession = `claude-${runId}-to`;
  await seedCard({
    title: `[E2E ${runId}] 원본 세션 카드`,
    description: '병합 fixture from',
    projectDir: PROJECT_DIR,
    sessionId: fromSession,
  });
  await seedCard({
    title: `[E2E ${runId}] 대상 세션 카드`,
    description: '병합 fixture to',
    projectDir: PROJECT_DIR,
    sessionId: toSession,
  });

  const fromTitle = `합쳐질 Work ${runId}`;
  const toTitle = `받는 Work ${runId}`;
  const from = await seedWork({ title: fromTitle, projectDir: PROJECT_DIR });
  const to = await seedWork({ title: toTitle, projectDir: PROJECT_DIR });
  await apiAddWorkSession(from.id, { sessionId: fromSession, projectDir: PROJECT_DIR, role: 'dev' });
  await apiAddWorkSession(to.id, { sessionId: toSession, projectDir: PROJECT_DIR, role: 'dev' });

  await openWorksTab(page);
  await workCard(page, fromTitle).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: fromTitle });
  await detail.getByRole('button', { name: '⇉ 다른 Work에 병합…' }).click();

  const merge = page.getByRole('dialog', { name: 'Work 병합', exact: true });
  await expect(merge).toBeVisible();
  // The source is never a target of itself, and the picker only offers active
  // Works — the store's move gate refuses both ends of a closed one.
  await expect(merge.locator('.works-assign-work-item')).toContainText([toTitle]);
  await merge.getByRole('button', { name: new RegExp(toTitle) }).click();
  // The consequences are stated before the button: the source closes, it is not
  // deleted, and the target's session total is spelled out.
  await expect(merge).toContainText('총 2개가 됩니다');
  await expect(merge).toContainText('폐기(병합됨)로 닫히고');
  await merge.getByRole('button', { name: '병합', exact: true }).click();
  await expect(merge).toHaveCount(0);

  // The dialog follows the sessions to the target.
  const target = page.getByRole('dialog', { name: toTitle });
  await expect(target).toBeVisible();
  await expect(target.locator('.work-session-item')).toHaveCount(2);
  await target.getByRole('button', { name: 'Close dialog' }).click();

  // Target summed, source closed as 병합됨 in Resolved (not deleted).
  await expect(workCard(page, toTitle)).toContainText('세션 2');
  await expect(workCard(page, fromTitle)).toHaveCount(0);
  await expandResolved(page);
  const resolvedSection = page.locator('.works-section').filter({ hasText: '완료·폐기한 작업' });
  const resolved = workCard(page, fromTitle);
  await expect(resolved).toContainText('병합됨');
  await expect(resolved).not.toContainText('폐기');

  const persistedFrom = await apiGetWork(from.id);
  expect(persistedFrom.status).toBe('discarded');
  expect(persistedFrom.resolution).toBe('superseded');
  expect(persistedFrom.supersededByWorkId).toBe(to.id);
  expect(persistedFrom.sessionLinks).toHaveLength(0);
  const persistedTo = await apiGetWork(to.id);
  expect(persistedTo.sessionLinks.map((l) => l.sessionId).sort())
    .toEqual([fromSession, toSession].sort());
});

/**
 * The detail dialog's footer at phone width.
 *
 * The footer is one non-wrapping flex row, and this branch grew it: `삭제…`
 * joined `폐기…` on the left, and `⇉ 다른 Work에 병합…` / `↺ 다시 열기…` /
 * `🧹 끊긴 세션 정리` joined the middle. At 390px that pushed `✔ 완료 (일괄
 * archive)` — the dialog's primary action — past the dialog's right edge, where
 * it is not merely ugly but **unreachable**: the footer is `position: sticky`
 * inside a vertically scrolling dialog, so there is nothing to scroll sideways.
 *
 * The page-level "does the document overflow" check cannot see this; the
 * clipping happens inside the dialog. So this asserts the thing that actually
 * matters: every footer button's right edge is inside the dialog's box.
 */
test('상세 다이얼로그의 푸터 버튼은 390px에서도 전부 화면 안에 있다', async ({ page, seedCard, trackWork }) => {
  const runId = `works-mobile-${Date.now()}`;
  await seedCard({
    title: `[E2E ${runId}] 모바일 푸터 세션`,
    description: '모바일 푸터 fixture',
    projectDir: PROJECT_DIR,
    sessionId: `claude-${runId}-1`,
  });
  const work = await apiCreateWork({ title: `[E2E ${runId}] 모바일 푸터`, projectDir: PROJECT_DIR });
  trackWork(work.id);
  await apiAddWorkSession(work.id, { sessionId: `claude-${runId}-1`, projectDir: PROJECT_DIR });

  await page.setViewportSize({ width: 390, height: 844 });
  await openWorksTab(page);
  await workCard(page, `[E2E ${runId}] 모바일 푸터`).getByRole('button', { name: '상세', exact: true }).click();
  const detail = page.getByRole('dialog', { name: `[E2E ${runId}] 모바일 푸터` });
  await expect(detail).toBeVisible();

  await expect(detail.getByRole('button', { name: '삭제…' })).toBeVisible();
  const dialogBox = await detail.boundingBox();
  expect(dialogBox).not.toBeNull();
  const footerButtons = detail.locator('.kv2-dialog-footer button');
  const count = await footerButtons.count();
  // The four this branch put there: 폐기… · 삭제… · ⇉ 병합… · ✔ 완료.
  expect(count).toBeGreaterThanOrEqual(4);

  for (let i = 0; i < count; i += 1) {
    const button = footerButtons.nth(i);
    const label = (await button.textContent())?.trim() ?? `#${i}`;
    const box = await button.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(
      box!.x + box!.width,
      `${label} is clipped past the dialog's right edge`,
    ).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
  }
});
