import { test, expect } from './fixtures/kanban';

// Done cards always render as session groups (collapsed); expanding one shows the turns.
async function openDoneGroup(page: import('@playwright/test').Page) {
  const column = page.locator('.kv2-column[data-status="done"]');
  const group = column.locator('.kv2-complete-session-group').first();
  await expect(group).toBeVisible();
  await column.locator('.kv2-complete-session-toggle').first().click();
  return group;
}

test.describe('Session group turn limit', () => {
  test('shows the newest 5 turns and reveals the rest behind Show N more', async ({ page, seedCardWithStatus }) => {
    for (let turn = 1; turn <= 8; turn++) {
      await seedCardWithStatus(
        { title: `[E2E-TURN] turn ${turn}`, description: `prompt ${turn}` },
        'done',
        { sessionId: 'e2e-turn-limit-session', agentRuntime: 'claude', result: `result ${turn}` }
      );
    }

    await page.goto('/');
    const group = await openDoneGroup(page);

    // Scoped to the timeline: the group header names the session by its first card.
    const timeline = group.locator('.kv2-complete-session-timeline');
    const titles = timeline.locator('.kv2-complete-session-card-title');
    await expect(titles).toHaveCount(5);
    // Newest first: turns 8..4 are shown, the three oldest are folded away.
    await expect(titles.first()).toContainText('turn 8');
    await expect(timeline).not.toContainText('[E2E-TURN] turn 1');

    await group.getByRole('button', { name: 'Show 3 more' }).click();
    await expect(titles).toHaveCount(8);
    await expect(timeline).toContainText('[E2E-TURN] turn 1');
  });

  test('a feedback turn is summarized by its instruction, not the generated header', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      {
        title: '[E2E-TURN] feedback turn',
        description: [
          '[Feedback for: [E2E-TURN] parent]',
          '[Original Card ID: abc12345]',
          '---',
          'the actual follow-up ask',
        ].join('\n'),
      },
      'done',
      { sessionId: 'e2e-turn-feedback-session', agentRuntime: 'claude', result: 'done' }
    );

    await page.goto('/');
    const group = await openDoneGroup(page);
    const timeline = group.locator('.kv2-complete-session-timeline');
    await expect(timeline).toContainText('the actual follow-up ask');
    await expect(timeline).not.toContainText('Original Card ID');
  });

  test('a turn row summarizes the final result, not the interim output before it', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E-TURN] split result turn', description: 'prompt' },
      'done',
      {
        sessionId: 'e2e-turn-result-session',
        agentRuntime: 'claude',
        result: 'interim note\n\nthe deliverable',
        finalResult: 'the deliverable',
      }
    );

    await page.goto('/');
    const timeline = (await openDoneGroup(page)).locator('.kv2-complete-session-timeline');
    await expect(timeline).toContainText('the deliverable');
    await expect(timeline).not.toContainText('interim note');
  });

  test('keeps the newest 5 when the group is sorted oldest-first', async ({ page, seedCardWithStatus }) => {
    for (let turn = 1; turn <= 8; turn++) {
      await seedCardWithStatus(
        { title: `[E2E-SORT] turn ${turn}`, description: `prompt ${turn}` },
        'done',
        { sessionId: 'e2e-turn-sort-session', agentRuntime: 'claude', result: `result ${turn}` }
      );
    }

    await page.goto('/');
    const group = await openDoneGroup(page);
    await group.locator('.kv2-complete-session-sort-inline').click();

    const titles = group.locator('.kv2-complete-session-card-title');
    await expect(titles).toHaveCount(5);
    // Reversed for display, but the five kept are still the newest five.
    await expect(titles.first()).toContainText('turn 4');
    await expect(titles.last()).toContainText('turn 8');
  });
});
