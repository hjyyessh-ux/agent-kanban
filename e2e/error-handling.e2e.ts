import { test, expect } from './fixtures/kanban';

test.describe('Error Handling', () => {
  test('API error shows prominent alert banner with refresh action', async ({ page }) => {
    // Intercept GET /api/cards to return 500
    await page.route('**/api/cards', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal Server Error' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/');

    await expect(page.locator('.error-banner')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.error-banner')).toContainText('Board unavailable');
    await expect(page.locator('.error-banner')).toContainText('Refresh board');
  });

  test('clicking refresh action recovers from error', async ({ page }) => {
    let shouldFail = true;

    await page.route('**/api/cards', async (route) => {
      if (route.request().method() === 'GET' && shouldFail) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal Server Error' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await expect(page.locator('.error-banner')).toBeVisible({ timeout: 5_000 });

    shouldFail = false;

    await page.getByRole('button', { name: 'Refresh board' }).click();

    // Error banner should disappear and board should load
    await expect(page.locator('.error-banner')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kv2-board')).toBeVisible();
  });
});
