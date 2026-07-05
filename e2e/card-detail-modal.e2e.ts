import { test, expect } from './fixtures/kanban';

test.describe('Card Detail Modal', () => {
  test('clicking card opens modal overlay', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Modal Open', description: 'Test modal opening' });
    await page.goto('/');

    const card = page.locator('.kv2-card', { hasText: '[E2E] Modal Open' });
    await expect(card).toBeVisible();
    await card.click();

    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
  });

  test('modal shows card title', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Modal Title', description: 'Test modal title' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Modal Title' }).click();
    await expect(page.locator('.kv2-title-text')).toContainText('[E2E] Modal Title');
  });

  test('modal shows phase sections when data exists', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Modal Phases', description: 'Phase content here' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Modal Phases' }).click();

    const phase = page.locator('.kv2-phase--prompt');
    const phaseWrapper = page.locator('.kv2-phase-card-wrapper').filter({ has: phase }).first();
    await expect(phase).toBeVisible();
    await expect(phaseWrapper.locator('.kv2-phase-header span')).toContainText('Prompt');
    await expect(phase.locator('.kv2-phase-content')).toContainText('Phase content here');
  });

  test('close via × button', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Modal Close X', description: 'Test close button' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Modal Close X' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await page.locator('.kv2-dialog button[aria-label="Close dialog"]').last().click();
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
  });

  test('close via Escape key', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] Modal Escape', description: 'Test escape key' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Modal Escape' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
  });

  test('modal shows project directory when present', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Modal Dir', description: 'Test directory display' },
      'todo',
      { projectDir: '/Users/test/e2e-project' }
    );
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Modal Dir' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await expect(page.locator('.kv2-dialog .kv2-meta-card--directory .kv2-meta-value--mono')).toContainText('/Users/test/e2e-project');
  });
});
