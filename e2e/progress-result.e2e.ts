import { test, expect } from './fixtures/kanban';
import type { CardRunProgress, RunProgressStep } from '../src/core/types';
import { PROGRESS_COMMAND_TIME_COPY } from '../web/src/constants/copy';

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

test.describe('Command start times', () => {
  test.use({ timezoneId: 'UTC', viewport: { width: 1280, height: 900 } });

  test('shows live KST starts and keeps full command bodies across polls, reload and mobile', async ({
    page, seedCardWithStatus,
  }, testInfo) => {
    const card = await seedCardWithStatus({
      title: '[E2E] Command starts',
      description: 'Synthetic progress fixture',
      agentRuntime: 'codex',
    }, 'in_progress', { progressSummary: 'Existing progress log fixture' });
    const longCommand = `printf '%s\\n' '${'synthetic command '.repeat(18).trim()}' && sleep 30`;
    const command = (body: string, commandStartedAt?: string): RunProgressStep => ({
      kind: 'command', label: 'Shell', detail: body, body, commandStartedAt,
    });
    const progress: CardRunProgress = {
      source: 'run', runtime: 'codex', runId: 'synthetic-run', runStatus: 'running',
      startedAt: '2026-07-03T14:55:00.000Z', totalSteps: 3,
      summary: { tools: ['Shell'], agents: [], skills: [], mcpServers: [], memory: [] },
      steps: [
        command('printf legacy'),
        command('printf midnight', '2026-07-03T14:59:59.000Z'),
        command(longCommand, '2026-07-03T15:00:02.000Z'),
      ],
    };
    let releaseStale = () => {};
    const stale = new Promise<void>(resolve => { releaseStale = resolve; });
    let requestCount = 0;
    await page.route(`**/api/cards/${card.id}/progress`, async route => {
      if (++requestCount !== 1) return route.fulfill({ json: progress });
      await stale;
      return route.fulfill({
        headers: { 'x-fixture-stale': 'true' },
        json: { ...progress, totalSteps: 2, steps: progress.steps.slice(0, 2) },
      });
    });
    await page.goto(`/?card=${card.id}`);

    const dialog = page.getByRole('dialog');
    const phase = dialog.locator('.kv2-phase--progress');
    const rows = phase.locator('.kv2-progress-step--command');
    const times = rows.locator('.kv2-progress-time');
    await expect(dialog.locator('.kv2-progress-timezone')).toHaveText(PROGRESS_COMMAND_TIME_COPY.timezone);
    await expect(phase).toContainText('Existing progress log fixture');
    await expect(times).toHaveText(['—', '23:59:59', '00:00:02']);
    const staleResponse = page.waitForResponse(response => response.headers()['x-fixture-stale'] === 'true');
    releaseStale();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(times).toHaveText(['—', '23:59:59', '00:00:02'], { timeout: 1_000 });
    const desktopTimeWidth = (await times.last().boundingBox())?.width;
    const wrapper = phase.locator('..');
    await wrapper.screenshot({ path: testInfo.outputPath('progress-desktop.png') });

    const fullCommand = longCommand + ' && printf done';
    progress.steps[2] = command(fullCommand, progress.steps[2].commandStartedAt);
    const row = rows.last().getByRole('button');
    await expect(row.locator('.kv2-progress-detail')).toHaveAttribute('title', fullCommand);
    await expect(times).toHaveText(['—', '23:59:59', '00:00:02']);
    await page.reload();
    await expect(times).toHaveText(['—', '23:59:59', '00:00:02']);

    await page.setViewportSize({ width: 390, height: 844 });
    const detail = row.locator('.kv2-progress-detail');
    await expect(detail).toBeVisible();
    expect(await detail.evaluate(node => node.clientWidth >= 55 && node.scrollWidth > node.clientWidth)).toBe(true);
    expect((await times.last().boundingBox())?.width).toBeCloseTo(desktopTimeWidth ?? 0);
    await wrapper.screenshot({ path: testInfo.outputPath('progress-mobile.png') });
    await row.press('Enter');
    await expect(rows.last().locator('.kv2-progress-body')).toHaveText(fullCommand);
    await row.press('Enter');
    await expect(rows.last().locator('.kv2-progress-body')).toHaveCount(0);
  });
});
