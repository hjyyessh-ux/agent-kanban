import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';

const VIEWPORTS = {
  desktop: { width: 1440, height: 1400 },
  tablet: { width: 1024, height: 1366 },
  mobile: { width: 390, height: 844 },
} as const;

// Flips the already-rendered page to dark (so this pass reuses the light
// pass's seeded state) and persists the choice so later `page.goto()` calls
// in the same test resolve dark via the FOUC script too.
async function setDarkTheme(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('kanban-theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
  });
}

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

    // Dark variant reuses the same seeded board; light assertions above
    // already ran unaffected, confirming no light-mode regression.
    await setDarkTheme(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const darkPalette = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const parseRgb = (value: string): [number, number, number] => {
        const rgb = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/);
        if (rgb) return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];

        const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (srgb) return [
          Math.round(Number(srgb[1]) * 255),
          Math.round(Number(srgb[2]) * 255),
          Math.round(Number(srgb[3]) * 255),
        ];

        throw new Error(`Unsupported computed color: ${value}`);
      };
      const luminance = ([r, g, b]: [number, number, number]) => {
        const linear = [r, g, b].map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const contrast = (foreground: [number, number, number], background: [number, number, number]) => {
        const foregroundLuminance = luminance(foreground);
        const backgroundLuminance = luminance(background);
        return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
      };
      const headers = ['todo', 'in_progress', 'complete', 'done'].map((status) => {
        const element = document.querySelector(`.kv2-column-header[data-status="${status}"]`);
        if (!element) throw new Error(`Missing ${status} column header`);
        const style = getComputedStyle(element);
        const background = parseRgb(style.backgroundColor);
        const foreground = parseRgb(style.color);
        return { status, background, foreground, contrast: contrast(foreground, background) };
      });
      const createButton = document.querySelector('.kv2-create-btn');
      if (!createButton) throw new Error('Missing create button');
      const createStyle = getComputedStyle(createButton);
      const createBackground = parseRgb(createStyle.backgroundColor);
      const createForeground = parseRgb(createStyle.color);
      const todoCard = document.querySelector('.kv2-column[data-status="todo"] .kv2-card');
      const todoAccent = todoCard?.querySelector('.kv2-card-accent');
      const runtimeBadge = todoCard?.querySelector('.kv2-runtime-badge');
      const startAction = todoCard?.querySelector('.kv2-card-action--start');
      const queueAction = todoCard?.querySelector('.kv2-card-action--queue');
      if (!todoAccent || !runtimeBadge || !startAction || !queueAction) {
        throw new Error('Missing Graphite audit controls');
      }

      return {
        tokens: {
          appBg: rootStyle.getPropertyValue('--kv2-app-bg').trim(),
          surface: rootStyle.getPropertyValue('--kv2-surface').trim(),
          textPrimary: rootStyle.getPropertyValue('--kv2-text-primary').trim(),
          borderStrong: rootStyle.getPropertyValue('--kv2-border-strong').trim(),
          cardBorder: rootStyle.getPropertyValue('--kv2-card-border-color').trim(),
          shadow: rootStyle.getPropertyValue('--kv2-shadow-color').trim(),
        },
        headers,
        createButton: {
          background: createBackground,
          foreground: createForeground,
          contrast: contrast(createForeground, createBackground),
        },
        graphiteChrome: {
          cardAccentWidth: getComputedStyle(todoAccent).width,
          cardAccent: parseRgb(getComputedStyle(todoAccent).backgroundColor),
          runtimeBadge: parseRgb(getComputedStyle(runtimeBadge).backgroundColor),
          startAction: parseRgb(getComputedStyle(startAction).backgroundColor),
          queueAction: parseRgb(getComputedStyle(queueAction).backgroundColor),
        },
      };
    });

    expect(darkPalette.tokens).toEqual({
      appBg: '#1b1d20',
      surface: '#272a2e',
      textPrimary: '#d4d7db',
      borderStrong: '#454a50',
      cardBorder: '#3c4146',
      shadow: 'rgba(8, 10, 12, .55)',
    });
    expect(darkPalette.headers.map(({ background }) => background)).toEqual([
      [37, 40, 44],
      [37, 40, 44],
      [37, 40, 44],
      [37, 40, 44],
    ]);
    expect(darkPalette.headers.every(({ contrast }) => contrast >= 4.5)).toBe(true);
    expect(darkPalette.createButton.foreground).toEqual([212, 215, 219]);
    expect(darkPalette.createButton.contrast).toBeGreaterThanOrEqual(4.5);
    expect(darkPalette.graphiteChrome).toEqual({
      cardAccentWidth: '3px',
      cardAccent: [111, 137, 173],
      runtimeBadge: [45, 49, 53],
      startAction: [58, 74, 93],
      queueAction: [45, 49, 53],
    });
    await page.screenshot({ path: 'e2e/results/v2-visual-board-desktop-dark.png', fullPage: true });
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

    const openAndCapture = async (title: string, screenshotPath: string, expectedAction: string, fromDoneGroup = false) => {
      if (fromDoneGroup) {
        // Done cards render inside collapsed session groups. Only expand if
        // a prior call (e.g. the light pass) hasn't already left it open.
        const doneColumn = page.locator('.kv2-column[data-status="done"]');
        const groupTitle = doneColumn.locator('.kv2-complete-session-card-title', { hasText: title });
        if (!(await groupTitle.isVisible())) {
          await doneColumn.locator('.kv2-complete-session-toggle').first().click();
        }
        await groupTitle.click();
      } else {
        await page.locator('.kv2-card', { hasText: title }).click();
      }
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

      if (await page.locator('html').getAttribute('data-theme') === 'dark') {
        const darkDialogColors = await page.evaluate(() => {
          const dialog = document.querySelector('.kv2-dialog');
          const title = document.querySelector('.kv2-title-text');
          return {
            background: dialog ? getComputedStyle(dialog).backgroundColor : null,
            shadow: dialog ? getComputedStyle(dialog).boxShadow : null,
            title: title ? getComputedStyle(title).color : null,
          };
        });
        expect(darkDialogColors.background).toBe('rgb(39, 42, 46)');
        expect(darkDialogColors.title).toBe('rgb(212, 215, 219)');
        expect(darkDialogColors.shadow).toContain('rgb(13, 15, 16)');
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.keyboard.press('Escape');
      await expect(page.locator('.kv2-dialog')).not.toBeVisible();
    };

    await openAndCapture('[V2 VISUAL] Modal Progress', 'e2e/results/v2-visual-modal-progress.png', 'REOPEN');
    await openAndCapture('[V2 VISUAL] Modal Complete', 'e2e/results/v2-visual-modal-complete.png', 'DONE');
    await openAndCapture('[V2 VISUAL] Modal Done', 'e2e/results/v2-visual-modal-done.png', 'REOPEN', true);

    // Dark variant: same cards, same assertions inside openAndCapture, just re-themed.
    await setDarkTheme(page);
    await openAndCapture('[V2 VISUAL] Modal Progress', 'e2e/results/v2-visual-modal-progress-dark.png', 'REOPEN');
    await openAndCapture('[V2 VISUAL] Modal Complete', 'e2e/results/v2-visual-modal-complete-dark.png', 'DONE');
    await openAndCapture('[V2 VISUAL] Modal Done', 'e2e/results/v2-visual-modal-done-dark.png', 'REOPEN', true);
  });

  test('captures create modal and responsive board states', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');

    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await expect(page.locator('.kv2-dialog--create')).toBeVisible();
    // 3 runtime chips (Opencode/Codex/Claude) + 4 opencode agent presets
    await expect(page.locator('[class*="kv2-create-agent-chip--runtime-"]')).toHaveCount(3);
    await expect(page.locator('.kv2-create-agent-chip:not([class*="--runtime-"])')).toHaveCount(4);
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

    // Dark variant pass: all light assertions above already ran unaffected.
    // localStorage persists the dark choice, so the FOUC script applies it
    // before first paint on each fresh navigation below.
    await setDarkTheme(page);

    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('.kv2-create-btn').click();
    await expect(page.locator('.kv2-dialog--create')).toBeVisible();
    const darkCreateColors = await page.evaluate(() => {
      const title = document.querySelector('.kv2-create-header-title');
      const claude = document.querySelector('.kv2-create-agent-chip--runtime-claude');
      return {
        title: title ? getComputedStyle(title).color : null,
        claudeBackground: claude ? getComputedStyle(claude).backgroundColor : null,
        claudeForeground: claude ? getComputedStyle(claude).color : null,
      };
    });
    expect(darkCreateColors.title).toBe('rgb(212, 215, 219)');
    expect(darkCreateColors.claudeBackground).not.toBe('rgb(217, 119, 87)');
    expect(darkCreateColors.claudeForeground).toBe('rgb(212, 215, 219)');
    await page.screenshot({ path: 'e2e/results/v2-visual-create-modal-dark.png', fullPage: true });
    await page.keyboard.press('Escape');

    await page.setViewportSize(VIEWPORTS.tablet);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'e2e/results/v2-visual-board-tablet-dark.png', fullPage: true });

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'e2e/results/v2-visual-board-mobile-dark.png', fullPage: true });
  });

  test('keeps legacy board, feedback, session, and wiki chrome legible in Graphite dark', async ({ page, seedCardWithStatus }) => {
    const original = await seedCardWithStatus(
      {
        title: '[GRAPHITE] Original session',
        description: 'Original prompt for Graphite coverage.',
      },
      'complete',
      {
        sessionId: 'graphite-session',
        result: 'Original result for Graphite coverage.',
      },
    );
    await seedCardWithStatus(
      {
        title: '[GRAPHITE] Feedback follow-up',
        description: 'Feedback prompt for Graphite coverage.',
      },
      'complete',
      {
        sessionId: 'graphite-session',
        feedbackForCardId: original.id,
        result: 'Feedback result for Graphite coverage.',
      },
    );

    await page.addInitScript(() => {
      localStorage.setItem('kanban-theme', 'dark');
      localStorage.setItem('kanban-complete-session-view', 'true');
    });
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/');

    const columnAction = page.locator('.kv2-column[data-status="complete"] .kv2-column-action').first();
    const sessionCount = page.locator('.kv2-complete-session-count').first();
    await expect(columnAction).toBeVisible();
    await expect(sessionCount).toBeVisible();
    await expect(columnAction).toHaveCSS('color', 'rgb(207, 211, 215)');
    await expect(sessionCount).toHaveCSS('color', 'rgb(194, 198, 202)');
    await page.screenshot({ path: 'e2e/results/v2-visual-legacy-controls-dark.png', fullPage: true });

    const group = page.locator('.kv2-complete-session-group', { hasText: '[GRAPHITE]' }).first();
    const toggle = group.locator('.kv2-complete-session-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await group.locator('.kv2-complete-session-card-title', { hasText: 'Feedback follow-up' }).click();
    const feedbackNav = page.locator('.kv2-back-btn');
    await expect(feedbackNav).toBeVisible();
    await expect(feedbackNav).toHaveCSS('background-color', 'rgb(81, 74, 50)');
    await expect(feedbackNav).toHaveCSS('color', 'rgb(212, 215, 219)');
    await page.keyboard.press('Escape');

    await group.locator('.kv2-complete-session-header').click();
    const conversation = page.locator('.session-conversation-dialog');
    await expect(conversation).toBeVisible();
    await expect(conversation.locator('.session-conversation-turnLabel').first()).toHaveCSS('background-color', 'rgb(166, 107, 123)');
    await page.screenshot({ path: 'e2e/results/v2-visual-session-conversation-dark.png', fullPage: true });
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: 'Wiki' }).click();
    const wikiHero = page.locator('.wiki-hero');
    await expect(wikiHero).toBeVisible();
    await expect(wikiHero.locator('.wiki-hero-kicker')).toHaveCSS('background-color', 'rgb(81, 74, 50)');
    const wikiOptions = wikiHero.locator('.wiki-options-trigger');
    if (await wikiOptions.evaluate((element) => element.classList.contains('is-active'))) await wikiOptions.click();
    await expect(wikiOptions).toHaveCSS('background-color', 'rgb(58, 74, 93)');
    await page.screenshot({ path: 'e2e/results/v2-visual-wiki-dark.png', fullPage: true });
  });
});
