import { test, expect } from './fixtures/kanban';

const VIEWPORTS = {
  desktop: { width: 1440, height: 1400 },
  tablet: { width: 1024, height: 1366 },
  mobile: { width: 390, height: 844 },
} as const;

test.describe('v2 visual audit', () => {
  test('captures board parity states on desktop', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Todo audit',
        description: 'Prompt block for desktop visual audit.',
      },
      'todo',
      {
        agentType: 'sisyphus',
        model: 'github-copilot/claude-opus-4.6',
      },
    );

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Progress audit',
        description: 'Prompt block for progress visual audit.',
      },
      'in_progress',
      {
        progressSummary: 'Progress block for desktop visual audit.',
        result: 'Result block preview to match Penpot information density.',
        projectDir: '/Users/user/workspace/agent-kanban',
      },
    );

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Complete audit',
        description: 'Prompt block for opencode complete visual audit.',
      },
      'complete',
      {
        progressSummary: 'Progress block for complete state.',
        result: 'Result block for complete state.',
      },
    );

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Done audit',
        description: 'Prompt block for done visual audit.',
      },
      'done',
      {
        progressSummary: 'Progress block for done state.',
        result: 'Result block for done state.',
      },
    );

    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');

    await expect(page.locator('.kv2-column')).toHaveCount(4);
    await expect(page.locator('.kv2-create-btn')).toBeVisible();
    await expect(page.locator('.kv2-column[data-status="in_progress"] .kv2-card-summary').first()).toContainText('Prompt block for progress visual audit.');
    await expect(page.locator('.kv2-column[data-status="complete"] .kv2-card-summary').first()).toContainText('Prompt block for opencode complete visual audit.');
    await expect(page.locator('.kv2-column[data-status="todo"] .kv2-card-section-label').first()).toHaveText('Prompt');
    await expect(page.locator('.kv2-column[data-status="todo"] .kv2-card-divider').first()).toBeVisible();

    const metrics = await page.evaluate(() => {
      const create = document.querySelector('.kv2-create-btn');
      const progressActions = document.querySelector('.kv2-column[data-status="in_progress"] .kv2-card-actions');
      const board = document.querySelector('.kv2-board');
      const summary = document.querySelector('.kv2-column[data-status="in_progress"] .kv2-card-summary');
      const card = document.querySelector('.kv2-column[data-status="todo"] .kv2-card');
      const prompt = document.querySelector('.kv2-column[data-status="todo"] .kv2-card-prompt-shell');
      return {
        boardGap: board ? getComputedStyle(board).gap : null,
        createHeight: create ? Math.round(create.getBoundingClientRect().height) : null,
        actionCount: progressActions?.querySelectorAll('button').length ?? 0,
        summaryMinHeight: summary ? getComputedStyle(summary).minHeight : null,
        cardRadius: card ? getComputedStyle(card).borderRadius : null,
        promptColumns: prompt ? getComputedStyle(prompt).gridTemplateColumns : null,
      };
    });

    expect(metrics.boardGap).toBe('20px');
    expect(metrics.createHeight).toBeGreaterThanOrEqual(34);
    expect(metrics.actionCount).toBe(2);
    expect(metrics.summaryMinHeight).toBe('38px');
    expect(metrics.cardRadius).toBe('2px');
    expect(metrics.promptColumns).toContain('3px');

    await page.screenshot({ path: 'e2e/results/v2-visual-board-desktop.png', fullPage: true });
  });

  test('captures detail modals for in_progress, complete, and done', async ({ page, seedCardWithStatus }) => {
    await page.setViewportSize(VIEWPORTS.desktop);

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Modal Progress',
        description: 'Prompt text for the in-progress modal.',
      },
      'in_progress',
      {
        progressSummary: 'Progress block for in-progress modal.',
        result: 'Result block for in-progress modal.',
        projectDir: '/Users/user/workspace/agent-kanban',
      },
    );

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Modal Complete',
        description: 'Prompt text for the complete modal.',
      },
      'complete',
      {
        progressSummary: 'Progress block for complete modal.',
        result: 'Result block for complete modal.',
      },
    );

    await seedCardWithStatus(
      {
        title: '[V2 VISUAL] Modal Done',
        description: 'Prompt text for the done modal.',
      },
      'done',
      {
        progressSummary: 'Progress block for done modal.',
        result: 'Result block for done modal.',
      },
    );

    await page.goto('/');

    const openAndCapture = async (title: string, screenshotPath: string, expectedAction: string) => {
      await page.locator('.kv2-card', { hasText: title }).click();
      await expect(page.locator('.kv2-dialog')).toBeVisible();
      await expect(page.locator('.kv2-title-text')).toContainText(title);
      await expect(page.locator('.kv2-detail-sidebar .kv2-screenshot-panel')).toBeVisible();
      await expect(page.locator('.kv2-dialog .kv2-screenshot-thumb')).toHaveCount(0);
      await expect(page.locator('.kv2-dialog-actions')).toContainText(expectedAction);

      const dialogMetrics = await page.evaluate(() => {
        const dialog = document.querySelector('.kv2-dialog');
        const title = document.querySelector('.kv2-title-text');
        const actions = [...document.querySelectorAll('.kv2-dialog-actions button')].map((button) => button.textContent?.trim());
        return {
          dialogWidth: dialog ? Math.round(dialog.getBoundingClientRect().width) : null,
          titleSize: title ? getComputedStyle(title).fontSize : null,
          actions,
        };
      });

      expect(dialogMetrics.dialogWidth).toBeGreaterThanOrEqual(820);
      expect(Number.parseFloat(dialogMetrics.titleSize ?? '0')).toBeGreaterThanOrEqual(24);
      expect(dialogMetrics.actions).toContain(expectedAction);

      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.keyboard.press('Escape');
      await expect(page.locator('.kv2-dialog')).not.toBeVisible();
    };

    await openAndCapture('[V2 VISUAL] Modal Progress', 'e2e/results/v2-visual-modal-progress.png', 'REOPEN');
    await openAndCapture('[V2 VISUAL] Modal Complete', 'e2e/results/v2-visual-modal-complete.png', 'DONE');
    await openAndCapture('[V2 VISUAL] Modal Done', 'e2e/results/v2-visual-modal-done.png', 'REOPEN');
  });

  test('captures create modal and responsive board states', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');

    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await expect(page.locator('.kv2-dialog--create')).toBeVisible();
    await expect(page.locator('.kv2-create-agent-chip')).toHaveCount(4);
    await page.screenshot({ path: 'e2e/results/v2-visual-create-modal.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('.kv2-dialog')).not.toBeVisible();

    await page.setViewportSize(VIEWPORTS.tablet);
    await page.goto('/');
    const tabletColumns = await page.locator('.kv2-column').evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
      }),
    );
    const tabletRows = new Set(tabletColumns.map((column) => column.y));
    expect(tabletRows.size).toBeGreaterThan(1);
    await page.screenshot({ path: 'e2e/results/v2-visual-board-tablet.png', fullPage: true });

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/');
    const mobileColumns = await page.locator('.kv2-column').evaluateAll((elements) =>
      elements.map((el) => Math.round(el.getBoundingClientRect().x)),
    );
    expect(new Set(mobileColumns).size).toBe(1);
    await page.screenshot({ path: 'e2e/results/v2-visual-board-mobile.png', fullPage: true });
  });
});
