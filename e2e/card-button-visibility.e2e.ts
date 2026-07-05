import { test, expect } from './fixtures/kanban';
import { apiUpdateCard } from './helpers/api';

test.describe('Card Button Visibility by Status', () => {
  test('TODO card shows start, dequeue, queue target chip, and delete when queued', async ({ page, seedCard, seedCardWithStatus }) => {
    const target = await seedCardWithStatus(
      { title: '[E2E] BtnVis Queue Target', description: 'Queue target' },
      'in_progress',
    );
    const queued = await seedCard({
      title: '[E2E] BtnVis TODO',
      description: 'Visibility test',
    });
    await apiUpdateCard(queued.id, {
      queuedAfterCardId: target.id,
      queuePosition: 1,
      queueSessionMode: 'new_session',
    });
    await page.goto('/');

    const col = page.locator('.kv2-column[data-status="todo"]');
    const card = col.locator('.kv2-card', { hasText: '[E2E] BtnVis TODO' });
    await expect(card).toBeVisible();

    await expect(card.getByRole('button', { name: '▶ Start' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Dequeue' })).toBeVisible();
    await expect(card.locator('.kv2-card-queue-target')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Delete card' })).toBeVisible();
    await expect(card.locator('.kv2-card-section-label')).toHaveText('Prompt');
    await expect(card.locator('.kv2-card-divider')).toBeVisible();

    await expect(card.getByRole('button', { name: '✓ Finish' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: 'Reopen' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Done' })).not.toBeVisible();
  });

  test('IN_PROGRESS card shows finish and reopen on board', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] BtnVis Progress', description: 'Visibility test' },
      'in_progress',
    );
    await page.goto('/');

    const col = page.locator('.kv2-column[data-status="in_progress"]');
    const card = col.locator('.kv2-card', { hasText: '[E2E] BtnVis Progress' });
    await expect(card).toBeVisible();

    await expect(card.getByRole('button', { name: '✓ Finish' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Reopen' })).toBeVisible();

    await expect(card.getByRole('button', { name: '▶ Start' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Done' })).not.toBeVisible();
  });

  test('OPENCODE_COMPLETE card shows done and reopen on board', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] BtnVis OC', description: 'Visibility test' },
      'complete',
      { result: 'Some result' },
    );
    await page.goto('/');

    const col = page.locator('.kv2-column[data-status="complete"]');
    const card = col.locator('.kv2-card', { hasText: '[E2E] BtnVis OC' });
    await expect(card).toBeVisible();

    await expect(card.getByRole('button', { name: '✓ Done' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Reopen' })).toBeVisible();

    await expect(card.getByRole('button', { name: '▶ Start' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Finish' })).not.toBeVisible();
  });

  test('DONE card shows reopen on board', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] BtnVis Done', description: 'Visibility test' },
      'done',
      { result: 'Completed work' },
    );
    await page.goto('/');

    const col = page.locator('.kv2-column[data-status="done"]');
    const card = col.locator('.kv2-card', { hasText: '[E2E] BtnVis Done' });
    await expect(card).toBeVisible();

    await expect(card.getByRole('button', { name: 'Reopen' })).toBeVisible();

    await expect(card.getByRole('button', { name: '▶ Start' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Finish' })).not.toBeVisible();
    await expect(card.getByRole('button', { name: '✓ Done' })).not.toBeVisible();
  });
});
