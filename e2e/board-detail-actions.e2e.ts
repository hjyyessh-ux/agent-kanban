import { test, expect } from './fixtures/kanban';
import { apiGetCards } from './helpers/api';

test.describe('Board Detail Actions', () => {
  test('todo board keeps queue and delete actions while modal can edit queue state', async ({ page, seedCardWithStatus }) => {
    const parent = await seedCardWithStatus(
      { title: '[E2E-DETAIL] Queue Parent', description: 'Parent for queue target' },
      'in_progress',
    );

    await seedCardWithStatus(
      { title: '[E2E-DETAIL] Todo Detail Actions', description: 'Open modal for queue and delete actions' },
      'todo',
    );

    await page.goto('/');

    const todoCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', {
      hasText: '[E2E-DETAIL] Todo Detail Actions',
    });
    await expect(todoCard).toBeVisible();
    await expect(todoCard.locator('.kv2-card-action--start')).toBeVisible();
    await expect(todoCard.locator('.kv2-card-action--queue')).toHaveText('Queue');
    await expect(todoCard.locator('.kv2-card-icon-action--danger')).toBeVisible();

    await todoCard.click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await expect(page.locator('.kv2-dialog .kv2-btn--subtle-danger', { hasText: 'DELETE' })).toBeVisible();

    const queuePicker = page.locator('#detail-queue-select');
    await expect(queuePicker).toBeVisible();
    await queuePicker.click();
    await expect(page.locator('.kv2-queue-target-popover')).toBeVisible();
    await page.getByRole('option', { name: /After: \[E2E-DETAIL\] Queue Parent/ }).click();
    await expect(queuePicker).toContainText('After: [E2E-DETAIL] Queue Parent');
    await page.getByText('SAVE QUEUE SETTINGS').click();

    await expect(page.getByText('Remove from Queue')).toBeVisible();
    const cards = await apiGetCards();
    const queued = cards.find((card) => card.title === '[E2E-DETAIL] Todo Detail Actions');
    expect(queued?.queuedAfterCardId).toBe(parent.id);
    expect(queued?.queueSessionMode).toBe('new_session');
  });

  test('todo detail queue popup saves continue-after-session mode', async ({ page, seedCardWithStatus }) => {
    const parent = await seedCardWithStatus(
      { title: '[E2E-DETAIL] Continue Queue Parent', description: 'Parent for continue session mode' },
      'in_progress',
    );

    await seedCardWithStatus(
      { title: '[E2E-DETAIL] Continue Queue Source', description: 'Open modal for continue mode' },
      'todo',
    );

    await page.goto('/');

    const todoCard = page.locator('.kv2-column[data-status="todo"] .kv2-card', {
      hasText: '[E2E-DETAIL] Continue Queue Source',
    });
    await expect(todoCard).toBeVisible();
    await todoCard.click();

    const queuePicker = page.locator('#detail-queue-select');
    await expect(queuePicker).toBeVisible();
    await queuePicker.click();
    await page.getByRole('option', { name: /After: \[E2E-DETAIL\] Continue Queue Parent/ }).click();
    await page.getByLabel('Continue After Session').check();
    await page.getByText('SAVE QUEUE SETTINGS').click();

    await expect(page.getByText('Remove from Queue')).toBeVisible();
    const cards = await apiGetCards();
    const queued = cards.find((card) => card.title === '[E2E-DETAIL] Continue Queue Source');
    expect(queued?.queuedAfterCardId).toBe(parent.id);
    expect(queued?.queueSessionMode).toBe('continue_queued_after_session');
  });

  test('in-progress board and modal both expose reopen in rebalance pass', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E-DETAIL] Progress Detail Actions', description: 'Open modal for reopen action' },
      'in_progress',
    );

    await page.goto('/');

    const progressCard = page.locator('.kv2-column[data-status="in_progress"] .kv2-card', {
      hasText: '[E2E-DETAIL] Progress Detail Actions',
    });
    await expect(progressCard).toBeVisible();
    await expect(progressCard.locator('.kv2-card-action--finish')).toBeVisible();
    await expect(progressCard.locator('.kv2-card-action--secondary')).toHaveText('Reopen');

    await progressCard.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /REOPEN/i })).toBeVisible();
  });

  test('modal queue draft resets when navigating to another card', async ({ page, seedCardWithStatus }) => {
    const queueParent = await seedCardWithStatus(
      { title: '[E2E-DETAIL] Queue Reset Parent', description: 'Parent used for draft queue selection' },
      'in_progress',
    );

    const sourceCard = await seedCardWithStatus(
      { title: '[E2E-DETAIL] Queue Reset Source', description: 'Source card for queue draft state' },
      'todo',
    );

    await seedCardWithStatus(
      { title: '[E2E-DETAIL] Queue Reset Target', description: 'Second card should not inherit draft queue state' },
      'todo',
      { feedbackForCardId: sourceCard.id },
    );

    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E-DETAIL] Queue Reset Source' }).click();
    const queuePicker = page.locator('#detail-queue-select');
    await expect(queuePicker).toBeVisible();
    await queuePicker.click();
    await page.getByRole('option', { name: /After: \[E2E-DETAIL\] Queue Reset Parent/ }).click();
    await expect(queuePicker).toContainText('After: [E2E-DETAIL] Queue Reset Parent');
    await expect(page.getByText('SAVE QUEUE SETTINGS')).toBeVisible();

    await page.locator('.kv2-child-link', { hasText: '[E2E-DETAIL] Queue Reset Target' }).click();
    await expect(page.locator('.kv2-title-text')).toContainText('[E2E-DETAIL] Queue Reset Target');
    await expect(queuePicker).toContainText('Start independently');
    await expect(page.getByText('SAVE QUEUE SETTINGS')).not.toBeVisible();
  });
});
