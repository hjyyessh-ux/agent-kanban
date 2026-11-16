import { test, expect } from './fixtures/kanban';
import { apiGetCards, type Card } from './helpers/api';

/**
 * Covers the `requestedBy` feature end-to-end: the two UI paths that stamp
 * `user` (new-card form, feedback form), and the Dots badge's visibility
 * rules — shown only for `requestedBy === 'dots'`, next to the Telegram
 * badge; user and unspecified cards show no new badge at all.
 */

async function waitForCardByTitle(title: string): Promise<Card> {
  await expect.poll(async () => {
    const cards = await apiGetCards();
    return cards.some((c) => c.title === title);
  }).toBe(true);
  const cards = await apiGetCards();
  return cards.find((c) => c.title === title)!;
}

function openCard(page: import('@playwright/test').Page, title: string) {
  const card = page.locator('.kv2-card').filter({
    has: page.locator('.kv2-card-title', { hasText: title }),
  });
  return card.locator('.kv2-card-click-layer').click();
}

test.describe('Card requester (requestedBy)', () => {
  test('the new-card form stamps requestedBy=user', async ({ page, trackCard }) => {
    const title = `[E2E] New card requester ${Date.now()}`;
    await page.goto('/');
    await page.getByRole('button', { name: 'Create new card' }).click();
    await page.locator('#create-card-title-input').fill(title);
    await page.locator('#create-card-description-input').fill('Verifying requestedBy on direct creation');
    await page.getByRole('button', { name: 'CREATE', exact: true }).click();

    await expect(page.locator('.kv2-column[data-status="todo"] .kv2-card-title', { hasText: title })).toBeVisible();

    const created = await waitForCardByTitle(title);
    trackCard(created.id);
    expect(created.requestedBy).toBe('user');

    // user gets no new badge — the board card keeps its original appearance.
    const boardCard = page.locator('.kv2-card').filter({ has: page.locator('.kv2-card-title', { hasText: title }) });
    await expect(boardCard.locator('.kv2-dots-badge')).toHaveCount(0);
  });

  test('the feedback form stamps requestedBy=user on the new feedback card', async ({ page, seedCardWithStatus, trackCard }) => {
    const original = await seedCardWithStatus(
      { title: `[E2E] Feedback source ${Date.now()}`, description: 'Original prompt' },
      'complete',
      { result: 'Original result' },
    );

    await page.goto('/');
    await openCard(page, original.title);
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Describe what needs additional work...').fill('Please also check the group chat flow');
    await dialog.getByRole('button', { name: 'CREATE FEEDBACK', exact: true }).click();

    const feedbackTitle = `Feedback #1: ${original.title}`;
    await expect(page.locator('.kv2-card-title', { hasText: feedbackTitle })).toBeVisible();

    const feedbackCard = await waitForCardByTitle(feedbackTitle);
    trackCard(feedbackCard.id);
    expect(feedbackCard.requestedBy).toBe('user');
    expect(feedbackCard.feedbackForCardId).toBe(original.id);
  });

  test('Dots badge shows for dots, hides for unspecified, and stays distinct from origin/runtime badges', async ({ seedCard, page }) => {
    const dotTitle = `[E2E] Dot requester ${Date.now()}`;
    const unspecifiedTitle = `[E2E] Unspecified requester ${Date.now()}`;

    await seedCard({
      title: dotTitle,
      description: 'Registered by Dot',
      agentRuntime: 'codex',
      requestedBy: 'dots',
    });
    await seedCard({
      title: unspecifiedTitle,
      description: 'No requester set',
      agentRuntime: 'codex',
    });

    await page.goto('/');

    const dotCard = page.locator('.kv2-card').filter({ has: page.locator('.kv2-card-title', { hasText: dotTitle }) });
    await expect(dotCard.locator('.kv2-dots-badge')).toBeVisible();
    await expect(dotCard.getByText('CODEX')).toBeVisible();

    const unspecifiedCard = page.locator('.kv2-card').filter({ has: page.locator('.kv2-card-title', { hasText: unspecifiedTitle }) });
    await expect(unspecifiedCard.locator('.kv2-dots-badge')).toHaveCount(0);
    await expect(unspecifiedCard.getByText('CODEX')).toBeVisible();
  });
});
