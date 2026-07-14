import { test, expect } from './fixtures/kanban';

test.describe('Theme toggle', () => {
  // Each Playwright test gets a fresh browser context, so localStorage
  // already starts empty (`system`) — no explicit reset needed.

  test('toggling to dark sets data-theme and persists across reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('tab', { name: 'Settings' }).click();
    const themeGroup = page.getByRole('group', { name: 'Theme' });
    await themeGroup.getByRole('button', { name: /Dark/ }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeGroup.getByRole('button', { name: /Dark/ })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('kanban-theme'))).toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: /Dark/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('toggling back to light updates data-theme and localStorage', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Settings' }).click();
    const themeGroup = page.getByRole('group', { name: 'Theme' });

    await themeGroup.getByRole('button', { name: /Dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await themeGroup.getByRole('button', { name: /Light/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('kanban-theme'))).toBe('light');
  });

  test('system preference resolves data-theme without an explicit choice', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: /System/ })).toHaveAttribute('aria-pressed', 'true');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
