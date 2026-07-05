import { test, expect } from './fixtures/kanban';

test.describe('Board Structure', () => {
  test('renders with 4 columns', async ({ page }) => {
    await page.goto('/');
    const columns = page.locator('.kv2-column[data-status]');
    await expect(columns).toHaveCount(4);

    await expect(page.locator('.kv2-column[data-status="todo"]')).toBeVisible();
    await expect(page.locator('.kv2-column[data-status="in_progress"]')).toBeVisible();
    await expect(page.locator('.kv2-column[data-status="complete"]')).toBeVisible();
    await expect(page.locator('.kv2-column[data-status="done"]')).toBeVisible();
  });

  test('header shows Agent Kanban title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app-title')).toHaveText('Agent Kanban');
  });

  test('footer shows version', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app-footer')).toContainText('v0.1.0');
  });

  test('column headers show correct labels', async ({ page }) => {
    await page.goto('/');
    const todoCol = page.locator('.kv2-column[data-status="todo"] .kv2-column-header');
    const progressCol = page.locator('.kv2-column[data-status="in_progress"] .kv2-column-header');
    const completeCol = page.locator('.kv2-column[data-status="complete"] .kv2-column-header');
    const doneCol = page.locator('.kv2-column[data-status="done"] .kv2-column-header');

    await expect(todoCol).toContainText('To Do');
    await expect(progressCol).toContainText('In Progress');
    await expect(completeCol).toContainText('Complete');
    await expect(doneCol).toContainText('Done');
  });

  test('column counts show card numbers', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Count Test', description: 'Testing column count' });
    await page.goto('/');

    const todoCount = page.locator('.kv2-column[data-status="todo"] .kv2-column-count');
    await expect(todoCount).toBeVisible();
    const text = await todoCount.textContent();
    const countMatch = text?.match(/\d+/);
    expect(countMatch).toBeTruthy();
    expect(Number(countMatch![0])).toBeGreaterThanOrEqual(1);
  });
});
