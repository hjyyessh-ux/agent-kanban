import { test, expect } from './fixtures/kanban';

test.describe('Dialog Positioning', () => {
  test('dialog overlay uses position:fixed and centers the dialog', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Dialog Position', description: 'Verify dialog is fixed overlay, not inline' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Dialog Position' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const overlay = document.querySelector('.kv2-dialog-overlay');
      const dialog = document.querySelector('.kv2-dialog');
      const backdrop = document.querySelector('.kv2-dialog-backdrop');
      if (!overlay || !dialog || !backdrop) return null;

      const overlayStyle = getComputedStyle(overlay);
      const overlayRect = overlay.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const backdropStyle = getComputedStyle(backdrop);

      return {
        overlayPosition: overlayStyle.position,
        overlayTop: overlayRect.top,
        overlayLeft: overlayRect.left,
        overlayWidth: Math.round(overlayRect.width),
        overlayHeight: Math.round(overlayRect.height),
        dialogTop: Math.round(dialogRect.top),
        dialogLeft: Math.round(dialogRect.left),
        dialogWidth: Math.round(dialogRect.width),
        dialogHeight: Math.round(dialogRect.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        backdropPosition: backdropStyle.position,
        scrollY: window.scrollY,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.overlayPosition).toBe('fixed');
    expect(metrics!.overlayTop).toBe(0);
    expect(metrics!.overlayLeft).toBe(0);
    expect(metrics!.overlayWidth).toBe(metrics!.viewportWidth);
    expect(metrics!.overlayHeight).toBe(metrics!.viewportHeight);

    expect(metrics!.backdropPosition).toBe('absolute');

    expect(metrics!.dialogTop).toBeGreaterThanOrEqual(0);
    expect(metrics!.dialogLeft).toBeGreaterThan(0);

    const dialogCenterY = metrics!.dialogTop + metrics!.dialogHeight / 2;
    const viewportCenterY = metrics!.viewportHeight / 2;
    expect(Math.abs(dialogCenterY - viewportCenterY)).toBeLessThan(metrics!.viewportHeight * 0.15);
  });

  test('dialog does not scroll the page when opened', async ({ page, seedCard }) => {
    for (let i = 0; i < 8; i++) {
      await seedCard({ title: `[E2E] Filler Card ${i}`, description: `Filler card ${i} to add height` });
    }
    await seedCard({ title: '[E2E] Dialog No Scroll', description: 'This card tests scroll behavior' });
    await page.goto('/');

    const scrollBefore = await page.evaluate(() => window.scrollY);

    await page.locator('.kv2-card', { hasText: '[E2E] Dialog No Scroll' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBe(scrollBefore);

    const overlayPosition = await page.evaluate(() => {
      const overlay = document.querySelector('.kv2-dialog-overlay');
      return overlay ? getComputedStyle(overlay).position : null;
    });
    expect(overlayPosition).toBe('fixed');
  });

  test('dialog backdrop covers full viewport', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Backdrop Coverage', description: 'Test that backdrop covers viewport' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Backdrop Coverage' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    const coverage = await page.evaluate(() => {
      const backdrop = document.querySelector('.kv2-dialog-backdrop');
      const overlay = document.querySelector('.kv2-dialog-overlay');
      if (!backdrop || !overlay) return null;

      const backdropRect = backdrop.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();

      return {
        backdropCoversOverlay:
          backdropRect.top <= overlayRect.top &&
          backdropRect.left <= overlayRect.left &&
          backdropRect.right >= overlayRect.right &&
          backdropRect.bottom >= overlayRect.bottom,
        backdropWidth: Math.round(backdropRect.width),
        backdropHeight: Math.round(backdropRect.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });

    expect(coverage).not.toBeNull();
    expect(coverage!.backdropCoversOverlay).toBe(true);
    expect(coverage!.backdropWidth).toBeGreaterThanOrEqual(coverage!.viewportWidth);
    expect(coverage!.backdropHeight).toBeGreaterThanOrEqual(coverage!.viewportHeight);
  });
});
