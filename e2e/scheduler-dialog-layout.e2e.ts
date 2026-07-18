import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/kanban';

const RESULTS_DIR = path.join('e2e', 'results');
const VIEWPORTS = [
  { width: 1440, height: 1000, expectedRows: 1 },
  { width: 1024, height: 768, expectedRows: 1 },
  { width: 768, height: 1024, expectedRows: 3 },
  { width: 390, height: 844, expectedRows: 3 },
] as const;

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/\d+(\.\d+)?/g);
  if (!match || match.length < 3) {
    throw new Error(`Unable to parse color: ${color}`);
  }
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseRgb(foreground));
  const bg = relativeLuminance(parseRgb(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

async function preparePage(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/');
  await page.evaluate((nextTheme) => {
    localStorage.removeItem('kanban-scheduler-modal-size');
    localStorage.setItem('kanban-theme', nextTheme);
  }, theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function openSchedulerPromptModal(page: Page, theme: 'light' | 'dark' = 'light') {
  await preparePage(page, theme);
  await page.getByRole('tab', { name: 'Scheduler' }).click();
  await page.getByRole('button', { name: '새 Scheduler' }).click();
  await page.locator('#scheduler-name-input').fill('Layout audit');
  await page.getByRole('radio', { name: /Agent prompt/i }).click();
  await page.locator('#scheduler-prompt-input').fill('Verify scheduler modal layout and selector contrast.');
  await expect(page.locator('.kv2-dialog')).toBeVisible();
}

test.describe('Scheduler dialog layout', () => {
  test('간편 설정과 Cron 직접 입력이 왕복되며 KST preview와 invalid 안내를 유지한다', async ({ page }) => {
    await preparePage(page);
    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await page.getByRole('button', { name: '새 Scheduler' }).click();

    await expect(page.getByRole('radio', { name: /간편 설정/ })).toHaveAttribute('aria-checked', 'true');
    await page.locator('#scheduler-simple-repeat').selectOption('weekdays');
    await page.locator('#scheduler-simple-hour').selectOption('11');
    await page.locator('#scheduler-simple-minute').selectOption('30');
    await expect(page.locator('.scheduler-readonly-cron')).toContainText('30 11 * * 1-5');
    await expect(page.locator('.scheduler-cron-preview')).toContainText('KST 실행: 평일 11:30');

    await page.getByRole('radio', { name: /Cron 직접 입력/ }).click();
    const cronInput = page.locator('#scheduler-cron-input');
    await expect(cronInput).toHaveValue('30 11 * * 1-5');
    await expect(page.locator('.scheduler-cron-preview')).toContainText('Every weekday at 11:30');

    await cronInput.fill('invalid cron');
    await expect(page.locator('.scheduler-cron-preview')).toContainText('확인 필요');
    await expect(page.locator('.scheduler-cron-preview')).toContainText('5개 필드');

    await cronInput.fill('30 11 * * 1-5');
    await page.getByRole('radio', { name: /간편 설정/ }).click();
    await expect(page.locator('#scheduler-simple-repeat')).toHaveValue('weekdays');
    await expect(page.locator('#scheduler-simple-hour')).toHaveValue('11');
    await expect(page.locator('#scheduler-simple-minute')).toHaveValue('30');
  });

  test('selected action/runtime cards keep readable contrast in light and dark themes', async ({ page }) => {
    await openSchedulerPromptModal(page);

    const lightContrast = await page.evaluate(() => {
      const actionLabel = document.querySelector('.scheduler-action-toggle-btn.is-active .scheduler-action-toggle-title');
      const actionCard = document.querySelector('.scheduler-action-toggle-btn.is-active');
      const runtimeLabel = document.querySelector('.runtime-model-fields--scheduler .kv2-create-agent-chip--active .kv2-create-agent-chip-label');
      const runtimeCard = document.querySelector('.runtime-model-fields--scheduler .kv2-create-agent-chip--active');
      if (!actionLabel || !actionCard || !runtimeLabel || !runtimeCard) {
        return null;
      }
      return {
        actionText: getComputedStyle(actionLabel).color,
        actionBg: getComputedStyle(actionCard).backgroundColor,
        runtimeText: getComputedStyle(runtimeLabel).color,
        runtimeBg: getComputedStyle(runtimeCard).backgroundColor,
      };
    });

    expect(lightContrast).not.toBeNull();
    expect(contrastRatio(lightContrast!.actionText, lightContrast!.actionBg)).toBeGreaterThan(4.5);
    expect(contrastRatio(lightContrast!.runtimeText, lightContrast!.runtimeBg)).toBeGreaterThan(4.5);

    await openSchedulerPromptModal(page, 'dark');

    const darkContrast = await page.evaluate(() => {
      const actionLabel = document.querySelector('.scheduler-action-toggle-btn.is-active .scheduler-action-toggle-title');
      const actionCard = document.querySelector('.scheduler-action-toggle-btn.is-active');
      const runtimeLabel = document.querySelector('.runtime-model-fields--scheduler .kv2-create-agent-chip--active .kv2-create-agent-chip-label');
      const runtimeCard = document.querySelector('.runtime-model-fields--scheduler .kv2-create-agent-chip--active');
      if (!actionLabel || !actionCard || !runtimeLabel || !runtimeCard) {
        return null;
      }
      return {
        actionText: getComputedStyle(actionLabel).color,
        actionBg: getComputedStyle(actionCard).backgroundColor,
        runtimeText: getComputedStyle(runtimeLabel).color,
        runtimeBg: getComputedStyle(runtimeCard).backgroundColor,
      };
    });

    expect(darkContrast).not.toBeNull();
    expect(contrastRatio(darkContrast!.actionText, darkContrast!.actionBg)).toBeGreaterThan(4.5);
    expect(contrastRatio(darkContrast!.runtimeText, darkContrast!.runtimeBg)).toBeGreaterThan(4.5);

    await page.locator('.kv2-dialog').screenshot({
      path: path.join(RESULTS_DIR, 'scheduler-dialog-dark-1440.png'),
    });
  });

  for (const viewport of VIEWPORTS) {
    test(`runtime selector avoids accidental wrap at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSchedulerPromptModal(page);

      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('.kv2-dialog');
        const runtimeGrid = document.querySelector('.runtime-model-fields--scheduler .runtime-model-fields__runtime-grid');
        const modelSelect = document.querySelector('#scheduler-model-select');
        const footer = document.querySelector('.kv2-dialog-footer');
        const items = Array.from(document.querySelectorAll('.runtime-model-fields--scheduler .kv2-create-agent-chip'));
        if (!dialog || !runtimeGrid || !modelSelect || !footer || items.length === 0) {
          return null;
        }

        const dialogRect = dialog.getBoundingClientRect();
        const runtimeGridRect = runtimeGrid.getBoundingClientRect();
        const modelRect = modelSelect.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const itemRects = items.map((item) => {
          const rect = item.getBoundingClientRect();
          return {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
          };
        });

        return {
          dialogWidth: Math.round(dialogRect.width),
          runtimeGridWidth: Math.round(runtimeGridRect.width),
          modelTop: Math.round(modelRect.top),
          runtimeBottom: Math.round(runtimeGridRect.bottom),
          footerBottomDelta: Math.round(dialogRect.bottom - footerRect.bottom),
          overflowX: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
          rows: Array.from(new Set(itemRects.map((rect) => rect.top))).length,
          itemRects,
        };
      });

      expect(metrics).not.toBeNull();
      expect(metrics!.rows).toBe(viewport.expectedRows);
      expect(metrics!.overflowX).toBe(0);
      expect(metrics!.modelTop).toBeGreaterThan(metrics!.runtimeBottom);
      expect(metrics!.footerBottomDelta).toBeGreaterThanOrEqual(0);
      expect(metrics!.footerBottomDelta).toBeLessThanOrEqual(24);

      for (const rect of metrics!.itemRects) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(viewport.width);
      }

      if (viewport.width >= 1024) {
        expect(metrics!.dialogWidth).toBeGreaterThanOrEqual(880);
        expect(metrics!.dialogWidth).toBeLessThanOrEqual(920);
      }

      await page.locator('.kv2-dialog').screenshot({
        path: path.join(RESULTS_DIR, `scheduler-dialog-light-${viewport.width}x${viewport.height}.png`),
      });
    });
  }

  test('captures scheduler prompt dialog in light and dark for the required viewports', async ({ page }) => {
    test.setTimeout(120000);

    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openSchedulerPromptModal(page, theme);
        await page.locator('.kv2-dialog').screenshot({
          path: path.join(RESULTS_DIR, `scheduler-dialog-${theme}-${viewport.width}x${viewport.height}.png`),
        });
        await page.keyboard.press('Escape');
        await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();
      }
    }
  });

  test('captures the scheduler runtime and model section in light and dark', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openSchedulerPromptModal(page, theme);
      await page.locator('#scheduler-model-select').scrollIntoViewIfNeeded();
      const runtimeGrid = page.locator('.runtime-model-fields--scheduler .runtime-model-fields__runtime-grid');
      await expect(runtimeGrid).toBeVisible();
      await expect(page.locator('#scheduler-model-select')).toBeVisible();
      await page.locator('.kv2-dialog').screenshot({
        path: path.join(RESULTS_DIR, `scheduler-dialog-runtime-${theme}-1440x1000.png`),
      });
      await page.keyboard.press('Escape');
    }
  });
});
