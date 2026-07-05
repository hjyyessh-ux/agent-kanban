import { test, expect } from './fixtures/kanban';
import { apiGetCards } from './helpers/api';

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
    await expect(doneColumn.getByText('Archive All')).toBeVisible();
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

    await doneColumn.getByText('Archive All').click();

    // Card should disappear from done column
    await expect(doneColumn.locator('.kv2-complete-session-card-title', { hasText: '[E2E] Archive Remove' })).not.toBeVisible({ timeout: 5_000 });
  });

  test('Archive All button not visible when done column empty', async ({ page }) => {
    // Ensure no done cards exist by checking the done column
    await page.goto('/');

    const doneColumn = page.locator('.kv2-column[data-status="done"]');
    // If count is 0, Archive All should not be visible
    const countText = await doneColumn.locator('.kv2-column-count').textContent();
    if (countText === '0') {
      await expect(doneColumn.getByText('Archive All')).not.toBeVisible();
    } else {
      // Archive all first, then check
      await doneColumn.getByText('Archive All').click();
      await expect(doneColumn.getByText('Archive All')).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
