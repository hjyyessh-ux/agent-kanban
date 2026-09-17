import { test, expect } from './fixtures/kanban';

test.describe('Progress & Result Phase Blocks', () => {
  test('card with progressSummary shows Progress phase in dialog', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] With Progress', description: 'test description' },
      'todo',
      { progressSummary: 'Test progress summary text' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] With Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--progress')).toBeVisible();
  });

  test('card without progressSummary does not show Progress phase in dialog', async ({ page, seedCard, trackCard }) => {
    const card = await seedCard({
      title: '[E2E-PHASE] No Progress',
      description: 'test description without progress',
    });
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] No Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--progress')).not.toBeVisible();
  });

  test('card with result shows Result phase in dialog', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] With Result', description: 'test description' },
      'todo',
      { result: 'Test result text' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] With Result' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-phase--result')).toBeVisible();
  });

  test('Result phase opens on finalResult and hides the earlier output behind a toggle', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] Split Result', description: 'test description' },
      'todo',
      { result: 'interim note\n\nthe deliverable', finalResult: 'the deliverable' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    await todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] Split Result' }).click();

    const resultPhase = page.locator('.kv2-dialog .kv2-phase--result');
    await expect(resultPhase).toContainText('the deliverable');
    await expect(resultPhase).not.toContainText('interim note');

    await resultPhase.locator('.kv2-phase-aside-toggle').click();
    await expect(resultPhase).toContainText('interim note');
  });

  test('Prompt phase is clamped on a finished card and expanded while it is open', async ({ page, seedCardWithStatus, seedCard, trackCard }) => {
    await seedCardWithStatus(
      { title: '[E2E-PHASE] Finished Prompt', description: 'a long prompt that should be clamped' },
      'complete',
      { result: 'done' }
    );
    await seedCard({ title: '[E2E-PHASE] Open Prompt', description: 'still being worked on' });
    void trackCard;

    await page.goto('/');
    await page.locator('.kv2-column[data-status="complete"] .kv2-card', {
      hasText: '[E2E-PHASE] Finished Prompt',
    }).click();
    const promptContent = page.locator('.kv2-dialog .kv2-phase--prompt .kv2-phase-content');
    await expect(promptContent).toHaveClass(/kv2-phase-content--collapsed/);
    await page.keyboard.press('Escape');

    await page.locator('.kv2-column[data-status="todo"] .kv2-card', {
      hasText: '[E2E-PHASE] Open Prompt',
    }).click();
    await expect(promptContent).toHaveClass(/kv2-phase-content--expanded/);
  });

  test('a feedback prompt leads with its body and folds the generated header', async ({ page, seedCardWithStatus, trackCard }) => {
    const description = [
      '[Feedback for: [E2E-PHASE] Parent]',
      '[Original Card ID: abc12345]',
      '[Original Result: parent result excerpt]',
      '---',
      'the actual feedback instruction',
    ].join('\n');
    await seedCardWithStatus(
      { title: '[E2E-PHASE] Feedback Prompt', description },
      'complete',
      { result: 'done' }
    );
    void trackCard;

    await page.goto('/');
    await page.locator('.kv2-column[data-status="complete"] .kv2-card', {
      hasText: '[E2E-PHASE] Feedback Prompt',
    }).click();

    const prompt = page.locator('.kv2-dialog .kv2-phase--prompt');
    await expect(prompt).toContainText('the actual feedback instruction');
    await expect(prompt).not.toContainText('Original Card ID');

    await prompt.locator('.kv2-phase-aside-toggle').click();
    await expect(prompt).toContainText('Original Card ID');
  });

  test('Show more appears only when the clamped prompt actually overflows', async ({ page, seedCardWithStatus, trackCard }) => {
    await seedCardWithStatus(
      {
        title: '[E2E-PHASE] Overflowing Prompt',
        description: Array.from({ length: 12 }, (_, i) => `paragraph ${i + 1} of a long prompt`).join('\n\n'),
      },
      'complete',
      { result: 'done' }
    );
    await seedCardWithStatus(
      { title: '[E2E-PHASE] Tiny Prompt', description: 'one line' },
      'complete',
      { result: 'done' }
    );
    void trackCard;

    await page.goto('/');
    await page.locator('.kv2-column[data-status="complete"] .kv2-card', {
      hasText: '[E2E-PHASE] Overflowing Prompt',
    }).click();
    const prompt = page.locator('.kv2-dialog .kv2-phase--prompt');
    await expect(prompt.locator('.kv2-phase-more')).toBeVisible();
    await expect(prompt.locator('.kv2-phase-content')).toHaveClass(/kv2-phase-content--clipped/);

    await prompt.locator('.kv2-phase-more').click();
    await expect(prompt.locator('.kv2-phase-more')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('.kv2-column[data-status="complete"] .kv2-card', {
      hasText: '[E2E-PHASE] Tiny Prompt',
    }).click();
    await expect(prompt.locator('.kv2-phase-content')).not.toHaveClass(/kv2-phase-content--clipped/);
    await expect(prompt.locator('.kv2-phase-more')).toHaveCount(0);
  });

  test('modal shows progressSummary in Progress phase when present', async ({ page, seedCardWithStatus, trackCard }) => {
    const card = await seedCardWithStatus(
      { title: '[E2E-PHASE] Modal Progress', description: 'test description' },
      'todo',
      { progressSummary: 'Detailed progress summary for modal' }
    );
    void trackCard;
    expect(card.id).toBeTruthy();

    await page.goto('/');
    const todoColumn = page.locator('.kv2-column[data-status="todo"]');
    const cardEl = todoColumn.locator('.kv2-card', { hasText: '[E2E-PHASE] Modal Progress' });
    await expect(cardEl).toBeVisible();

    await cardEl.click();
    await expect(page.locator('.kv2-dialog-overlay')).toBeVisible();

    const progressPhase = page.locator('.kv2-phase--progress');
    await expect(progressPhase).toBeVisible();
    await expect(progressPhase.locator('.kv2-phase-content')).toContainText('Detailed progress summary for modal');
  });
});
