import { test, expect } from './fixtures/kanban';

test.describe('Responsive Layout', () => {
  test('desktop: 4 columns side by side', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Responsive Desktop', description: 'Layout test' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');

    await expect(page.locator('.kv2-board')).toBeVisible();

    const columns = page.locator('.kv2-column');
    await expect(columns).toHaveCount(4);

    // Check that columns have different x positions (side by side)
    const boxes = await columns.evaluateAll(els =>
      els.map(el => el.getBoundingClientRect().x)
    );
    // All 4 columns should have distinct x positions
    const uniqueX = new Set(boxes);
    expect(uniqueX.size).toBe(4);
  });

  test('mobile: columns stacked vertically', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Responsive Mobile', description: 'Layout test' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(page.locator('.kv2-board')).toBeVisible();

    const columns = page.locator('.kv2-column');
    await expect(columns).toHaveCount(4);

    // Check that columns have the same x position (stacked vertically)
    const boxes = await columns.evaluateAll(els =>
      els.map(el => Math.round(el.getBoundingClientRect().x))
    );
    // All columns should share the same x position
    const uniqueX = new Set(boxes);
    expect(uniqueX.size).toBe(1);
  });
});
