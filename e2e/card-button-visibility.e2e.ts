import { test, expect } from './fixtures/kanban';
import { apiUpdateCard } from './helpers/api';
import { CARD_ACTION_COPY } from '../web/src/constants/copy';

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

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.start, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.dequeue, exact: true })).toBeVisible();
    await expect(card.locator('.kv2-card-queue-target')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Delete card' })).toBeVisible();
    await expect(card.locator('.kv2-card-prompt')).toBeVisible();
    await expect(card.locator('.kv2-card-section-label')).toHaveCount(0);
    await expect(card.locator('.kv2-card-divider')).toBeVisible();

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.finish, exact: true })).not.toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.reopen, exact: true })).not.toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.done, exact: true })).not.toBeVisible();
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

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.finish, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.reopen, exact: true })).toBeVisible();

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.start, exact: true })).not.toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.done, exact: true })).not.toBeVisible();
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

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.done, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.reopen, exact: true })).toBeVisible();

    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.start, exact: true })).not.toBeVisible();
    await expect(card.getByRole('button', { name: CARD_ACTION_COPY.finish, exact: true })).not.toBeVisible();
  });

  test('DONE card exposes archive on board and reopen in detail dialog', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] BtnVis Done', description: 'Visibility test' },
      'done',
      { result: 'Completed work' },
    );
    await page.goto('/');

    // Done cards render as collapsed session groups: the board exposes a
    // group-level ARCHIVE action, and per-card Reopen lives in the detail dialog.
    const col = page.locator('.kv2-column[data-status="done"]');
    const group = col.locator('.kv2-complete-session-group').first();
    await expect(group).toBeVisible();
    await expect(group.getByRole('button', { name: CARD_ACTION_COPY.archive, exact: true })).toBeVisible();
    await expect(col.getByRole('button', { name: CARD_ACTION_COPY.start, exact: true })).not.toBeVisible();
    await expect(col.getByRole('button', { name: CARD_ACTION_COPY.finish, exact: true })).not.toBeVisible();
    await expect(col.getByRole('button', { name: CARD_ACTION_COPY.done, exact: true })).not.toBeVisible();

    await col.locator('.kv2-complete-session-toggle').first().click();
    await col.locator('.kv2-complete-session-card-title', { hasText: '[E2E] BtnVis Done' }).click();
    const dialog = page.locator('.kv2-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: CARD_ACTION_COPY.reopen, exact: true })).toBeVisible();
  });
});
