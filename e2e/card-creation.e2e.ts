import { test, expect } from './fixtures/kanban';
import { apiUpdateCard, apiGetCards } from './helpers/api';

test.describe('Card Creation', () => {
  test('created card appears in TODO column', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] New Card Test', description: 'E2E test description' });
    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardTitle = todoColumn.locator('.kv2-card-title', { hasText: card.title });
    await expect(cardTitle).toBeVisible();
  });

  test('created card shows prompt summary', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] Phase Test', description: 'Testing prompt phase' });
    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: card.title });
    await expect(cardEl.locator('.kv2-card-section-label', { hasText: 'PROMPT' })).toBeVisible();
    await expect(cardEl.locator('.kv2-card-prompt')).toBeVisible();
  });

  test('create card with projectDir stores it via API', async ({ seedCard }) => {
    const card = await seedCard({ title: '[E2E] Dir Card', description: 'Directory test' });
    await apiUpdateCard(card.id, { projectDir: '/Users/test/project' });

    const cards = await apiGetCards();
    const updated = cards.find(c => c.id === card.id);
    expect(updated).toBeDefined();
    expect(updated!.projectDir).toBe('/Users/test/project');
  });

  test('create dialog shows inline alert before submit when required fields are missing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Create new card' }).click();
    await page.getByRole('button', { name: 'CREATE', exact: true }).click();

    const inlineAlert = page.locator('.kv2-create-alert');
    await expect(inlineAlert).toBeVisible();
    await expect(inlineAlert).toContainText('Missing required information');
    await expect(page.locator('#create-card-title-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#create-card-description-input')).toHaveAttribute('aria-invalid', 'true');
  });
});
