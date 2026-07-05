import { test, expect } from './fixtures/kanban';

test.describe('Sorting — Newest First', () => {
  test('cards in TODO column are sorted newest first', async ({ page, seedCard, trackCard }) => {
    // Create 3 cards in sequence — cardA first (oldest), cardC last (newest)
    const cardA = await seedCard({ title: '[E2E-SORT] Alpha', description: 'First card created' });
    const cardB = await seedCard({ title: '[E2E-SORT] Beta', description: 'Second card created' });
    const cardC = await seedCard({ title: '[E2E-SORT] Gamma', description: 'Third card created' });

    await page.goto('/');

    // Get all card titles in the TODO column in DOM order
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const allTitles = todoColumn.locator('.kv2-card-title');
    await expect(allTitles.first()).toBeVisible();

    // Collect all title texts
    const titleTexts = await allTitles.allTextContents();

    // Filter to just our E2E-SORT cards
    const sortCards = titleTexts.filter(t => t.includes('[E2E-SORT]'));

    // Newest (Gamma) should appear before oldest (Alpha) in DOM order
    expect(sortCards.length).toBe(3);
    expect(sortCards[0]).toBe('[E2E-SORT] Gamma');
    expect(sortCards[1]).toBe('[E2E-SORT] Beta');
    expect(sortCards[2]).toBe('[E2E-SORT] Alpha');
  });
});
