import { test, expect } from './fixtures/kanban';

test.describe('Card Detail Start', () => {
  test('start from modal dispatches without a preceding status patch', async ({ page, seedCardWithStatus }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E] Modal Start', description: 'Start flow should dispatch directly from todo' },
      'todo',
    );

    const events: string[] = [];

    await page.route(`**/api/cards/${card.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }

      events.push('patch');
      await route.continue();
    });

    await page.route(`**/api/cards/${card.id}/dispatch`, async (route) => {
      events.push('dispatch');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: 'start-session' }),
      });
    });

    await page.goto('/');
    await page.locator('.kv2-card', { hasText: '[E2E] Modal Start' }).click();

    const dialog = page.locator('.kv2-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'START TASK', exact: true }).click();

    await expect.poll(() => events).toEqual(['dispatch']);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.error-banner')).not.toBeVisible();
  });
});
