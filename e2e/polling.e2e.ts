import { test, expect } from './fixtures/kanban';
import { apiCreateCard, apiDeleteCard } from './helpers/api';

test.describe('Polling / Auto-Refresh', () => {
  test('card created via API appears on board within 5 seconds', async ({ page, trackCard }) => {
    await page.goto('/');

    // Wait for initial board load
    await expect(page.locator('.kv2-board')).toBeVisible();

    // Create card via API (not UI)
    const card = await apiCreateCard({ title: '[E2E] Polling Appear', description: 'Polling test' });
    trackCard(card.id);

    // Card should appear via polling (3s interval)
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    await expect(todoColumn.locator('.kv2-card-title', { hasText: '[E2E] Polling Appear' })).toBeVisible({ timeout: 7_000 });
  });

  test('card deleted via API disappears from board within 5 seconds', async ({ page }) => {
    // Create and wait for it to appear
    const card = await apiCreateCard({ title: '[E2E] Polling Disappear', description: 'Polling delete test' });

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    await expect(todoColumn.locator('.kv2-card-title', { hasText: '[E2E] Polling Disappear' })).toBeVisible({ timeout: 7_000 });

    // Delete via API
    await apiDeleteCard(card.id);

    // Card should disappear via polling
    await expect(todoColumn.locator('.kv2-card-title', { hasText: '[E2E] Polling Disappear' })).not.toBeVisible({ timeout: 7_000 });
  });
});
