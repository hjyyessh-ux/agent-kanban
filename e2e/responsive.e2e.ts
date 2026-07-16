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

  test('mobile: header stays compact and board tools expand on demand', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const header = page.locator('.app-header');
    const toolsToggle = page.getByRole('button', { name: '☰ Board 도구' });
    await expect(toolsToggle).toBeVisible();
    await expect(page.locator('.app-board-view-controls')).not.toBeVisible();
    await expect(page.locator('.kv2-board-mobile-nav')).toBeVisible();

    const headerHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThan(180);

    await toolsToggle.click();
    await expect(page.locator('.app-board-view-controls')).toBeVisible();
    await expect(page.locator('.app-project-switcher')).toBeVisible();
  });

  test('mobile: settings and capabilities stay within the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.locator('#app-tab-settings').click();
    await expect(page.locator('.settings-model-search')).toBeAttached();
    await expect(page.locator('.settings-model-group-toggle')).toHaveCount(3);

    await page.locator('#app-tab-capabilities').click();
    await expect(page.locator('.diag-bar')).toBeVisible();

    const overflow = await page.locator('#app-panel-capabilities').evaluate((panel) => {
      return Array.from(panel.querySelectorAll<HTMLElement>('*')).some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > window.innerWidth + 1;
      });
    });
    expect(overflow).toBe(false);
  });
});
