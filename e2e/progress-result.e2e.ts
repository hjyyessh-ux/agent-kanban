import { test, expect } from './fixtures/kanban';

test.describe('Progress & Result Phase Blocks', () => {
  test('card with progressSummary shows Progress phase in dialog', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] With Progress', description: 'test description' },
      'todo',
      { progressSummary: 'Test progress summary text' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] With Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--progress')).toBeVisible();
  });

  test('card without progressSummary does not show Progress phase in dialog', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-PHASE] No Progress',
      description: 'test description without progress',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] No Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--progress')).not.toBeVisible();
  });

  test('card with result shows Result phase in dialog', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] With Result', description: 'test description' },
      'todo',
      { result: 'Test result text' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] With Result' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--result')).toBeVisible();
  });

  test('modal shows progressSummary in Progress phase when present', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] Modal Progress', description: 'test description' },
      'todo',
      { progressSummary: 'Detailed progress summary for modal' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] Modal Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.locator('.kv2-card-title').click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    const progressPhase = page.locator('.kv2-phase--progress');
    await expect(progressPhase).toBeVisible();
    await expect(progressPhase.locator('.kv2-phase-content')).toContainText('Detailed progress summary for modal');
  });
});
