import { test, expect } from './fixtures/kanban';

test.describe('Foldable UI — Board Card Phase Blocks', () => {
  test('board card shows prompt summary text', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] Collapsed Default',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] Collapsed Default' });
    await expect(cardEl).toBeVisible();

    const promptSummary = cardEl.locator('.kv2-card-prompt');
    await expect(promptSummary).toBeVisible();
    await expect(promptSummary).toContainText('This is a long description that exceeds fifty characters');
  });

  test('clicking board card opens detail dialog with phase blocks', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] Expand Test',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] Expand Test' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();

    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();

    const promptPhase = dialog.locator('.kv2-phase--prompt');
    await expect(promptPhase).toBeVisible();
    await expect(promptPhase.locator('.kv2-phase-content')).toBeVisible();
    // Prompt is always expanded by default in every status.
    await expect(promptPhase.locator('.kv2-phase-content')).toHaveClass(/kv2-phase-content--expanded/);
  });

  test('dialog phase toggle expands and collapses', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] Collapse Test',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] Collapse Test' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();

    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();

    const promptPhase = dialog.locator('.kv2-phase--prompt');
    const promptContent = promptPhase.locator('.kv2-phase-content');
    const toggleBtn = dialog.locator('.kv2-phase-action[aria-expanded]').first();

    // Prompt starts expanded; toggle collapses then re-expands.
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(promptContent).toHaveClass(/kv2-phase-content--expanded/);

    await toggleBtn.click();
    await expect(promptContent).toHaveClass(/kv2-phase-content--collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    await toggleBtn.click();
    await expect(promptContent).toHaveClass(/kv2-phase-content--expanded/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
  });

  test('board card click opens dialog (no separate toggle)', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] No Modal Test',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] No Modal Test' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
  });

  test('modal prompt phase is expanded by default', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] Modal Expanded',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] Modal Expanded' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    const modalPhaseText = page.locator('.kv2-phase-content').first();
    await expect(modalPhaseText).toHaveClass(/kv2-phase-content--expanded/);

    const modalToggleBtn = page.locator('.kv2-phase-card-wrapper .kv2-phase-action[aria-expanded]').first();
    await expect(modalToggleBtn).toHaveAttribute('aria-expanded', 'true');
  });

  test('modal toggle collapses and re-expands prompt phase', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-FOLD] Modal Collapse',
      description: 'This is a long description that exceeds fifty characters to ensure we have meaningful content to collapse and expand in the phase block.',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-FOLD] Modal Collapse' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    const modalToggleBtn = page.locator('.kv2-phase-card-wrapper .kv2-phase-action[aria-expanded]').first();
    const modalPhaseText = page.locator('.kv2-phase-content').first();

    await modalToggleBtn.click();
    await expect(modalPhaseText).toHaveClass(/kv2-phase-content--collapsed/);
    await expect(modalToggleBtn).toHaveAttribute('aria-expanded', 'false');

    await modalToggleBtn.click();
    await expect(modalPhaseText).toHaveClass(/kv2-phase-content--expanded/);
    await expect(modalToggleBtn).toHaveAttribute('aria-expanded', 'true');
  });
});
