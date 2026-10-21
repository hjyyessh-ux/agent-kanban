import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import { apiAddWorkSession, apiGetCards, apiGetWork, apiGetWorks } from './helpers/api';
import { BOARD_WORKS_COPY, TOOLBAR_COPY } from '../web/src/constants/copy';

/**
 * Board `GROUP: WORKS` drag & drop, bottom tray, undo and `⋯ → Work로 이동`
 * (docs/works.md ⑥, mockup B안). The board's DnD is native HTML5, which
 * Playwright's mouse `dragTo()` cannot drive — so, like board-drag-reorder,
 * the same DragEvents the app listens for are dispatched with one shared
 * DataTransfer. The board flips into its drag state a frame after
 * `dragstart`, so the drop waits for that render.
 */

const GROUP_KEY = 'kanban-complete-session-view';
const READ_AT = '2099-01-01T00:00:00.000Z';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, 'works'), GROUP_KEY);
});

const headerOf = (sessionId: string) =>
  `article[data-session-group-key="session:${sessionId}"] .kv2-complete-session-header`;
const workIn = (workId: string, status: string) =>
  `section.kv2-work[data-work-id="${workId}"][data-work-status="${status}"]`;
const unassignedZone = (status: string) => `.kv2-column[data-status="${status}"] .kv2-works-unassigned`;

/** Drag `source` onto `target`; resolves to whether the target accepted the drag (`dragover` prevented). */
async function dragTo(page: Page, source: string, target: string): Promise<boolean> {
  return page.evaluate(async ({ source, target }) => {
    const dataTransfer = new DataTransfer();
    const from = document.querySelector(source);
    if (!from) throw new Error(`no drag source ${source}`);
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    // The tray and the drop handlers mount on the next frame.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const to = document.querySelector(target);
    if (!to) throw new Error(`no drop target ${target}`);
    const rect = to.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    to.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer, ...at }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...at });
    to.dispatchEvent(over);
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...at }));
    (from.isConnected ? from : document).dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
    return over.defaultPrevented;
  }, { source, target });
}

async function linkedSessions(workId: string): Promise<string[]> {
  return (await apiGetWork(workId)).sessionLinks.map((link) => link.sessionId);
}

/** One complete/done session with a single turn — read unless `unread`. */
async function seedSession(
  seedCardWithStatus: (data: { title: string; description: string } & Record<string, unknown>, status: string, extras?: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  title: string,
  status: 'complete' | 'done' | 'in_progress' = 'complete',
  { unread = false }: { unread?: boolean } = {},
) {
  await seedCardWithStatus(
    { title, description: `${title} prompt`, sessionId, projectDir: '/tmp/board-works-e2e' },
    status,
    unread || status === 'in_progress' ? {} : { completedSeenAt: READ_AT },
  );
}

test.describe('Board GROUP: WORKS — drag & drop', () => {
  test('an unassigned session dropped on a Work links it, and 되돌리기 unlinks it', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [inW1, loose] = [`bw-a-${run}`, `bw-b-${run}`];
    await seedSession(seedCardWithStatus, inW1, `[BW] In W1 ${run}`);
    await seedSession(seedCardWithStatus, loose, `[BW] Loose ${run}`);
    const w1 = await seedWork({ title: `[BW] W1 ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: inW1 });

    await page.goto('/');
    await expect(page.locator(workIn(w1.id, 'complete'))).toBeVisible();
    // Before the drag: the loose session sits under UNASSIGNED.
    await expect(page.locator(`${unassignedZone('complete')} ${headerOf(loose)}`)).toBeVisible();

    expect(await dragTo(page, headerOf(loose), workIn(w1.id, 'complete'))).toBe(true);
    await expect.poll(() => linkedSessions(w1.id)).toContain(loose);
    await expect(page.locator(`${workIn(w1.id, 'complete')} [data-session-group-key="session:${loose}"]`)).toBeAttached();

    const notice = page.locator('.work-session-notice');
    await expect(notice).toContainText(w1.title);
    await notice.getByRole('button', { name: BOARD_WORKS_COPY.undo }).click();
    await expect.poll(() => linkedSessions(w1.id)).not.toContain(loose);
  });

  test('a session dragged onto another Work moves there, and 되돌리기 moves it back', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [a, a2, c] = [`bw-a-${run}`, `bw-a2-${run}`, `bw-c-${run}`];
    await seedSession(seedCardWithStatus, a, `[BW] Mover ${run}`);
    await seedSession(seedCardWithStatus, a2, `[BW] Stayer ${run}`);
    await seedSession(seedCardWithStatus, c, `[BW] Other ${run}`);
    const w1 = await seedWork({ title: `[BW] Source ${run}` });
    const w2 = await seedWork({ title: `[BW] Target ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: a });
    await apiAddWorkSession(w1.id, { sessionId: a2 });
    await apiAddWorkSession(w2.id, { sessionId: c });

    await page.goto('/');
    await expect(page.locator(workIn(w2.id, 'complete'))).toBeVisible();
    expect(await dragTo(page, headerOf(a), workIn(w2.id, 'complete'))).toBe(true);
    await expect.poll(() => linkedSessions(w2.id)).toContain(a);
    expect(await linkedSessions(w1.id)).not.toContain(a);

    await page.locator('.work-session-notice').getByRole('button', { name: BOARD_WORKS_COPY.undo }).click();
    await expect.poll(() => linkedSessions(w1.id)).toContain(a);
    expect(await linkedSessions(w2.id)).not.toContain(a);
  });

  test('its own Work and the same column UNASSIGNED zone: unlink on the zone, nothing on its own Work', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [a, a2] = [`bw-a-${run}`, `bw-a2-${run}`];
    await seedSession(seedCardWithStatus, a, `[BW] Leaver ${run}`);
    await seedSession(seedCardWithStatus, a2, `[BW] Keeper ${run}`);
    const w1 = await seedWork({ title: `[BW] Home ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: a });
    await apiAddWorkSession(w1.id, { sessionId: a2 });

    await page.goto('/');
    await expect(page.locator(workIn(w1.id, 'complete'))).toBeVisible();
    expect(await dragTo(page, headerOf(a), workIn(w1.id, 'complete'))).toBe(false);

    expect(await dragTo(page, headerOf(a), unassignedZone('complete'))).toBe(true);
    await expect.poll(() => linkedSessions(w1.id)).not.toContain(a);
    await expect(page.locator(`${unassignedZone('complete')} ${headerOf(a)}`)).toBeVisible();
  });

  test('a drop on another column is not a Works change — the session keeps its status and stays unassigned', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [inW1, doneLoose] = [`bw-a-${run}`, `bw-d-${run}`];
    await seedSession(seedCardWithStatus, inW1, `[BW] Review ${run}`);
    await seedSession(seedCardWithStatus, doneLoose, `[BW] Finished ${run}`, 'done');
    const w1 = await seedWork({ title: `[BW] Cross ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: inW1 });

    await page.goto('/');
    await expect(page.locator(workIn(w1.id, 'complete'))).toBeVisible();
    expect(await dragTo(page, headerOf(doneLoose), workIn(w1.id, 'complete'))).toBe(false);
    expect(await linkedSessions(w1.id)).not.toContain(doneLoose);
    const card = (await apiGetCards()).find((candidate) => candidate.sessionId === doneLoose);
    expect(card?.status).toBe('done');
  });

  test('the bottom tray takes an in-progress card into any Work and dims the current one', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [inW1, running] = [`bw-a-${run}`, `bw-p-${run}`];
    await seedSession(seedCardWithStatus, inW1, `[BW] Anchor ${run}`);
    await seedSession(seedCardWithStatus, running, `[BW] Running ${run}`, 'in_progress');
    const w1 = await seedWork({ title: `[BW] Tray ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: inW1 });

    await page.goto('/');
    const runningCard = page.locator('.kv2-column[data-status="in_progress"] .kv2-card', { hasText: `[BW] Running ${run}` });
    await expect(runningCard).toContainText(BOARD_WORKS_COPY.unassignedTag);
    const cardId = await runningCard.getAttribute('data-id');

    expect(await dragTo(page, `.kv2-card[data-id="${cardId}"]`, `[data-tray-work-id="${w1.id}"]`)).toBe(true);
    await expect.poll(() => linkedSessions(w1.id)).toContain(running);
    await expect(runningCard.locator('.kv2-card-work-tag')).toContainText(w1.title);
    await expect(page.locator('.kv2-work-tray')).toHaveCount(0);

    // Dragging it again: its Work is listed as (현재) and refuses the drop.
    const accepted = await page.evaluate(async ({ cardId, workId }) => {
      const dataTransfer = new DataTransfer();
      document.querySelector(`.kv2-card[data-id="${cardId}"]`)?.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = document.querySelector(`[data-tray-work-id="${workId}"]`);
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
      current?.dispatchEvent(over);
      const result = { dimmed: current?.classList.contains('is-current') ?? false, prevented: over.defaultPrevented };
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      return result;
    }, { cardId, workId: w1.id });
    expect(accepted).toEqual({ dimmed: true, prevented: false });
  });

  test('the tray ＋ 새 Work names a new Work and links the session', async ({ page, seedCardWithStatus, trackWork }) => {
    const run = Date.now();
    const loose = `bw-n-${run}`;
    await seedSession(seedCardWithStatus, loose, `[BW] Seed ${run}`);

    await page.goto('/');
    await expect(page.locator(headerOf(loose))).toBeVisible();
    expect(await dragTo(page, headerOf(loose), '[data-tray-new]')).toBe(true);

    const dialog = page.getByRole('dialog', { name: BOARD_WORKS_COPY.newWorkTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(BOARD_WORKS_COPY.newWorkLabel)).toHaveValue(`[BW] Seed ${run}`);
    await dialog.getByLabel(BOARD_WORKS_COPY.newWorkLabel).fill(`[BW] Fresh ${run}`);
    await dialog.getByRole('button', { name: BOARD_WORKS_COPY.newWorkSubmit }).click();

    await expect.poll(async () => (await apiGetWorks()).find((work) => work.title === `[BW] Fresh ${run}`)?.sessionLinks.map((l) => l.sessionId))
      .toEqual([loose]);
    const created = (await apiGetWorks()).find((work) => work.title === `[BW] Fresh ${run}`);
    if (created) trackWork(created.id);
  });

  test('⋯ → Work로 이동 is the keyboard path to the same move', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [inW1, loose] = [`bw-a-${run}`, `bw-m-${run}`];
    await seedSession(seedCardWithStatus, inW1, `[BW] Menu anchor ${run}`);
    await seedSession(seedCardWithStatus, loose, `[BW] Menu loose ${run}`);
    const w1 = await seedWork({ title: `[BW] Menu target ${run}` });
    await apiAddWorkSession(w1.id, { sessionId: inW1 });

    await page.goto('/');
    const trigger = page.getByRole('button', { name: BOARD_WORKS_COPY.moveMenuLabel(`[BW] Menu loose ${run}`), exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: BOARD_WORKS_COPY.moveMenuLabel(`[BW] Menu loose ${run}`) });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: BOARD_WORKS_COPY.moveTo(w1.title) }).click();
    await expect.poll(() => linkedSessions(w1.id)).toContain(loose);
    // No session dialog opened behind the menu.
    await expect(page.locator('.work-session-notice')).toContainText(w1.title);
  });
});

test.describe('Board GROUP: WORKS — filters', () => {
  test('unread-only and the WORK filter apply to Work containers', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [hot, cold, loose] = [`bw-h-${run}`, `bw-c-${run}`, `bw-l-${run}`];
    await seedSession(seedCardWithStatus, hot, `[BW] Hot ${run}`, 'complete', { unread: true });
    await seedSession(seedCardWithStatus, cold, `[BW] Cold ${run}`);
    await seedSession(seedCardWithStatus, loose, `[BW] Loose filter ${run}`);
    const wHot = await seedWork({ title: `[BW] Hot work ${run}` });
    const wCold = await seedWork({ title: `[BW] Cold work ${run}` });
    await apiAddWorkSession(wHot.id, { sessionId: hot });
    await apiAddWorkSession(wCold.id, { sessionId: cold });

    await page.goto('/');
    await expect(page.locator(workIn(wCold.id, 'complete'))).toBeVisible();

    const unreadToggle = page.locator('.kv2-unread-filter');
    await unreadToggle.click();
    await expect(page.locator(workIn(wHot.id, 'complete'))).toBeVisible();
    await expect(page.locator(workIn(wCold.id, 'complete'))).toHaveCount(0);
    await unreadToggle.click();

    await page.locator('.kv2-filter-trigger').click();
    const workOptions = page.locator('.kv2-filter-option');
    await workOptions.filter({ hasText: wCold.title }).click();
    await expect(page.locator(workIn(wCold.id, 'complete'))).toBeVisible();
    await expect(page.locator(workIn(wHot.id, 'complete'))).toHaveCount(0);
    await expect(page.locator(headerOf(loose))).toHaveCount(0);

    await workOptions.filter({ hasText: TOOLBAR_COPY.workFilterUnassigned }).click();
    await expect(page.locator(headerOf(loose))).toBeVisible();
    await expect(page.locator(workIn(wCold.id, 'complete'))).toHaveCount(0);
  });
});

test.describe('Board GROUP: WORKS — ⋯ 세션 접기', () => {
  test('folds a Work to header + meta, and opening it again shows the newest two before Show more', async ({ page, seedCardWithStatus, seedWork }) => {
    const run = Date.now();
    const [a, b, c] = [`bw-fold-a-${run}`, `bw-fold-b-${run}`, `bw-fold-c-${run}`];
    await seedSession(seedCardWithStatus, a, `[BW] Fold A ${run}`, 'complete', { unread: true });
    await seedSession(seedCardWithStatus, b, `[BW] Fold B ${run}`);
    await seedSession(seedCardWithStatus, c, `[BW] Fold C ${run}`);
    const w = await seedWork({ title: `[BW] Folding ${run}` });
    for (const sessionId of [a, b, c]) await apiAddWorkSession(w.id, { sessionId });

    await page.goto('/');
    const container = page.locator(workIn(w.id, 'complete'));
    const groups = container.locator('[data-session-group-key]');
    await expect(groups).toHaveCount(2);
    // Unread and the Work id sit on the meta line, not beside the title.
    await expect(container.locator('.kv2-work-head .kv2-work-unread')).toHaveCount(0);
    await expect(container.locator('.kv2-work-meta .kv2-work-unread')).toHaveText('● 1');

    const menu = container.getByRole('button', { name: BOARD_WORKS_COPY.menuLabel(w.title) });
    await menu.click();
    await page.getByRole('menuitem', { name: BOARD_WORKS_COPY.menuCollapseSessions }).click();
    await expect(container).toHaveClass(/kv2-work--collapsed/);
    await expect(groups).toHaveCount(0);
    await expect(container.locator('.kv2-work-meta')).toContainText('3 sessions');

    await menu.click();
    await page.getByRole('menuitem', { name: BOARD_WORKS_COPY.menuExpandSessions }).click();
    await expect(groups).toHaveCount(2);
    await container.getByRole('button', { name: new RegExp(BOARD_WORKS_COPY.showMore(1)) }).click();
    await expect(groups).toHaveCount(3);

    // Folding and opening again starts from the newest two once more.
    await menu.click();
    await page.getByRole('menuitem', { name: BOARD_WORKS_COPY.menuCollapseSessions }).click();
    await menu.click();
    await page.getByRole('menuitem', { name: BOARD_WORKS_COPY.menuExpandSessions }).click();
    await expect(groups).toHaveCount(2);
  });
});
