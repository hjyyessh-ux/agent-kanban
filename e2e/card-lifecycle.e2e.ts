import { test, expect } from './fixtures/kanban';
import { apiUpdateCard } from './helpers/api';

test.describe('Card Lifecycle — Status Transitions', () => {
  test('Start button on TODO card triggers dispatch and shows error (no plugin)', async ({ page, seedCard }) => {
    const card = await seedCard({ title: '[E2E] Start Test', description: 'Testing start' });

    // Intercept dispatch to explicitly return 503 (simulates no plugin running)
    await page.route(`**/api/cards/${card.id}/dispatch`, async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Dispatch not available' }) });
    });

    await page.goto('/');

    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E] Start Test' });
    await expect(cardEl).toBeVisible();

    // Click Start — dispatch will fail with 503 (no plugin), error banner should appear
    await cardEl.locator('.kv2-card-action--start').click();
    await expect(page.locator('.error-banner')).toBeVisible({ timeout: 5_000 });
  });

  test('Finish button moves card from in_progress to complete', async ({ page, seedCardWithStatus }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E] Finish Test', description: 'Testing finish' },
      'in_progress'
    );
    await page.goto('/');

    const progressColumn = page.locator('.kv2-column[data-status="in_progress"]');
    const cardEl = progressColumn.locator('.kv2-card', { hasText: '[E2E] Finish Test' });
    await expect(cardEl).toBeVisible();

    await cardEl.locator('.kv2-card-action--finish').click();

    // Card should move to complete
    const completeColumn = page.locator('.kv2-column[data-status="complete"]');
    await expect(completeColumn.locator('.kv2-card-title', { hasText: '[E2E] Finish Test' })).toBeVisible({ timeout: 5_000 });
  });

  test('Verify button moves card from complete to done', async ({ page, seedCardWithStatus }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E] Verify Test', description: 'Testing verify' },
      'complete',
      { result: 'Some result' }
    );
    await page.goto('/');

    const completeColumn = page.locator('.kv2-column[data-status="complete"]');
    const cardEl = completeColumn.locator('.kv2-card', { hasText: '[E2E] Verify Test' });
    await expect(cardEl).toBeVisible();

    await cardEl.getByRole('button', { name: 'Done' }).click();

    // Card should move to done
    const doneColumn = page.locator('.kv2-column[data-status="done"]');
    await expect(doneColumn.locator('.kv2-card-title', { hasText: '[E2E] Verify Test' })).toBeVisible({ timeout: 5_000 });
  });

  test('full lifecycle via API', async ({ seedCard }) => {
    const { apiUpdateCard: update, apiGetCards } = await import('./helpers/api');

    const card = await seedCard({ title: '[E2E] Lifecycle API', description: 'Full lifecycle' });
    expect(card.status).toBe('todo');

    // todo → in_progress
    const ip = await update(card.id, { status: 'in_progress' });
    expect(ip.status).toBe('in_progress');

    // in_progress → complete
    const oc = await update(card.id, { status: 'complete', result: 'Done!' });
    expect(oc.status).toBe('complete');

    // complete → done
    const done = await update(card.id, { status: 'done' });
    expect(done.status).toBe('done');
  });
});
