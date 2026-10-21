import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import { apiGetCards } from './helpers/api';
import { COLUMN_MENU_COPY, STATUS_LABELS } from '../web/src/constants/copy';

const DONE_COLUMN_ACTIONS = `${STATUS_LABELS.done} column actions`;

/** Column bulk actions live behind the header's `⋯` menu (portaled to body). */
async function openColumnMenu(column: Locator) {
  await column.getByRole('button', { name: DONE_COLUMN_ACTIONS }).click();
  return column.page().getByRole('menu', { name: DONE_COLUMN_ACTIONS });
}

test.describe('Archive', () => {
  test('done card shows Archive All button', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Archive Visible', description: 'Test archive button visibility' },
      'done'
    );
    await page.goto('/');

    // Done cards render as collapsed session groups; expand to see card titles.
    const doneColumn = page.locator('.kv2-column[data-status="done"]');
    await expect(doneColumn.locator('.kv2-complete-session-group').first()).toBeVisible();
    await doneColumn.locator('.kv2-complete-session-toggle').first().click();
    await expect(doneColumn.locator('.kv2-complete-session-card-title', { hasText: '[E2E] Archive Visible' })).toBeVisible();
    const menu = await openColumnMenu(doneColumn);
    await expect(menu.getByRole('menuitem', { name: COLUMN_MENU_COPY.archiveAll })).toBeVisible();
  });

  test('click Archive All removes card from done column', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Archive Remove', description: 'Test archive removes card' },
      'done'
    );
    await page.goto('/');

    const doneColumn = page.locator('.kv2-column[data-status="done"]');
    await expect(doneColumn.locator('.kv2-complete-session-group').first()).toBeVisible();
    await doneColumn.locator('.kv2-complete-session-toggle').first().click();
    await expect(doneColumn.locator('.kv2-complete-session-card-title', { hasText: '[E2E] Archive Remove' })).toBeVisible();

    const menu = await openColumnMenu(doneColumn);
    await menu.getByRole('menuitem', { name: COLUMN_MENU_COPY.archiveAll }).click();

    // Card should disappear from done column
    await expect(doneColumn.locator('.kv2-complete-session-card-title', { hasText: '[E2E] Archive Remove' })).not.toBeVisible({ timeout: 5_000 });
  });

  test('Archive All button not visible when done column empty', async ({ page }) => {
    // Ensure no done cards exist by checking the done column
    await page.goto('/');

    const doneColumn = page.locator('.kv2-column[data-status="done"]');
    // If count is 0, the column menu (and Archive All in it) should not exist
    const menuTrigger = doneColumn.getByRole('button', { name: DONE_COLUMN_ACTIONS });
    const countText = await doneColumn.locator('.kv2-column-count').textContent();
    if (countText === '0') {
      await expect(menuTrigger).not.toBeVisible();
    } else {
      // Archive all first, then check
      const menu = await openColumnMenu(doneColumn);
      await menu.getByRole('menuitem', { name: COLUMN_MENU_COPY.archiveAll }).click();
      await expect(menuTrigger).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
