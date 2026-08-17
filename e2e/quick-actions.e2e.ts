import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/kanban';
import {
  apiGetCards,
  apiGetQuickActions,
  apiRunQuickAction,
  apiUpdateCard,
} from './helpers/api';

const PROJECT_DIR = process.cwd();

async function openQuickActions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Quick Actions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Quick Actions' })).toBeVisible();
}

async function waitForCard(title: string, status?: string) {
  return expect.poll(async () => {
    const cards = await apiGetCards();
    const card = cards.find((candidate) => candidate.title === title);
    if (!card) return null;
    return status && card.status !== status ? null : card;
  }, { timeout: 10_000 }).not.toBeNull();
}

async function getCard(title: string) {
  const card = (await apiGetCards()).find((candidate) => candidate.title === title);
  if (!card) throw new Error(`Card not found: ${title}`);
  return card;
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    localStorage.setItem('kanban-theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.dispatchEvent(new CustomEvent('kanban-theme-change'));
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('Quick Actions', () => {
  test('creates, edits, dispatches, tracks, and deletes the three-day MCP Prompt action', async ({
    page,
    trackCard,
    trackQuickAction,
  }) => {
    await page.goto('/');
    await openQuickActions(page);
    await page.getByRole('button', { name: 'Add Action' }).click();

    await page.getByLabel('Name').fill('MCP recent monitor');
    await page.getByLabel('Description').fill('Monitor MCP servers from the last three days');
    await page.getByLabel('Card title template').fill('MCP monitor {{days}} days');
    await page.getByLabel('Prompt template').fill('[hold-open] Monitor MCP servers from the last {{days}} days.');
    await page.getByLabel('Project directory *').fill(PROJECT_DIR);
    await page.getByRole('button', { name: 'Use directory', exact: true }).click();
    await page.getByRole('radio', { name: 'Codex', exact: true }).click();
    await page.getByLabel('Model', { exact: true }).selectOption('gpt-5.5');
    await page.getByLabel('Codex reasoning effort', { exact: true }).selectOption('high');
    await page.getByLabel('Codex sandbox', { exact: true }).selectOption('read-only');

    await page.getByRole('button', { name: 'Add Parameter' }).click();
    await page.getByLabel('Parameter 1 key').fill('days');
    await page.getByLabel('Parameter 1 label').fill('Days');
    await page.getByLabel('Parameter 1 type').selectOption('number');
    await page.getByLabel('Parameter 1 default').fill('3');
    await page.getByText('Required', { exact: true }).locator('..').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save Action' }).click();

    const created = (await apiGetQuickActions()).find((action) => action.name === 'MCP recent monitor');
    if (!created) throw new Error('Created Quick Action missing');
    trackQuickAction(created.id);

    const managed = page.locator('.kv2-quick-action-item--manage', { hasText: 'MCP recent monitor' });
    await managed.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Name').fill('MCP recent monitor edited');
    await page.getByRole('button', { name: 'Save Action' }).click();
    await expect(page.locator('.kv2-quick-action-item--manage', { hasText: 'MCP recent monitor edited' })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();

    await page.getByRole('button', { name: 'Run MCP recent monitor edited' }).click();
    const runDialog = page.getByRole('dialog', { name: 'Run MCP recent monitor edited' });
    await expect(runDialog.getByText('Prompt', { exact: true })).toBeVisible();
    await expect(runDialog.getByText(PROJECT_DIR, { exact: true })).toBeVisible();
    await expect(runDialog.getByText('{{days}}', { exact: true })).toBeVisible();
    await expect(runDialog.getByLabel('Days')).toHaveValue('3');
    await page.getByRole('button', { name: 'Run Action' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await expect(page.locator('.kv2-column[data-status="in_progress"] .kv2-card', { hasText: 'MCP monitor 3 days' })).toBeVisible();
    const card = await getCard('MCP monitor 3 days');
    trackCard(card.id);
    expect(card).toMatchObject({
      status: 'in_progress',
      description: '[hold-open] Monitor MCP servers from the last 3 days.',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      model: 'gpt-5.5',
      originChannel: 'quick_action',
      executionKind: 'agent',
      parameterSnapshot: { days: 3 },
      codexOptions: { reasoningEffort: 'high', sandbox: 'read-only' },
    });

    await apiUpdateCard(card.id, {
      status: 'complete',
      resolution: 'completed',
      result: 'MCP monitoring completed for the last three days.',
    });
    await page.reload();
    const completeCard = page.locator('.kv2-column[data-status="complete"] .kv2-card', { hasText: 'MCP monitor 3 days' });
    await expect(completeCard).toBeVisible();
    await expect(completeCard.getByText('Quick Action', { exact: true })).toBeVisible();
    await expect(completeCard.getByText('Agent', { exact: true })).toBeVisible();

    await openQuickActions(page);
    await page.getByRole('button', { name: 'Manage' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.kv2-quick-action-item--manage', { hasText: 'MCP recent monitor edited' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.kv2-quick-action-item--manage', { hasText: 'MCP recent monitor edited' })).not.toBeVisible();
    expect((await apiGetQuickActions()).some((action) => action.id === created.id)).toBe(false);
  });

  test('passes Script parameters as environment only and tracks success and failure cards', async ({
    page,
    seedQuickAction,
    seedScript,
    trackCard,
  }) => {
    const injectionMarker = join(PROJECT_DIR, '.e2e-data', 'quick-action-injection-marker');
    expect(existsSync(injectionMarker)).toBe(false);
    const deployment = await seedScript({
      name: 'E2E deployment',
      description: 'Deploy a selected service',
      language: 'bash',
      projectDir: PROJECT_DIR,
      content: 'sleep 2; printf "service=%s replicas=%s dry=%s region=%s token=%s\\n" "$AK_PARAM_SERVICE" "$AK_PARAM_REPLICAS" "$AK_PARAM_DRY_RUN" "$AK_PARAM_REGION" "$AK_PARAM_DEPLOY_TOKEN"',
    });
    await seedQuickAction({
      type: 'script',
      name: 'Deploy service',
      description: 'Deployment verification',
      enabled: true,
      pinned: true,
      scriptId: deployment.id,
      parameterDefinitions: [
        { key: 'service', label: 'Service', type: 'string', required: true },
        { key: 'replicas', label: 'Replicas', type: 'number', required: true, defaultValue: 3 },
        { key: 'dryRun', label: 'Dry run', type: 'boolean', required: true, defaultValue: false },
        { key: 'region', label: 'Region', type: 'select', required: true, options: ['ap-northeast-2', 'us-east-1'], defaultValue: 'ap-northeast-2' },
        { key: 'deployToken', label: 'Deploy token', type: 'secret', required: true },
      ],
    });

    const failing = await seedScript({
      name: 'E2E failing deployment',
      description: 'Fail a deployment',
      language: 'bash',
      projectDir: PROJECT_DIR,
      content: 'sleep 2; echo "deployment failed" >&2; exit 7',
    });
    const failingAction = await seedQuickAction({
      type: 'script',
      name: 'Fail deployment',
      description: 'Failure lifecycle verification',
      enabled: true,
      pinned: false,
      scriptId: failing.id,
      parameterDefinitions: [],
    });

    await page.goto('/');
    await openQuickActions(page);
    await page.getByRole('button', { name: 'Run Deploy service' }).click();
    await expect(page.getByText('E2E deployment', { exact: true })).toBeVisible();
    await expect(page.getByText('AK_PARAM_SERVICE', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Service *', exact: true }).fill(`$(touch ${injectionMarker})`);
    await page.getByLabel('Deploy token *', { exact: true }).fill('e2e-super-secret');
    await page.getByRole('button', { name: 'Run Action' }).click();

    const runningCard = page.locator('.kv2-column[data-status="in_progress"] .kv2-card', { hasText: 'Deploy service' });
    await expect(runningCard).toBeVisible();
    await expect(runningCard.getByText('Script', { exact: true })).toBeVisible();
    const running = await getCard('Deploy service');
    trackCard(running.id);
    expect(running).toMatchObject({
      status: 'in_progress',
      scriptName: 'E2E deployment',
      parameterSnapshot: {
        service: `$(touch ${injectionMarker})`,
        replicas: 3,
        dryRun: false,
        region: 'ap-northeast-2',
      },
    });
    expect(JSON.stringify(running)).not.toContain('e2e-super-secret');

    await waitForCard('Deploy service', 'complete');
    const completed = await getCard('Deploy service');
    expect(completed).toMatchObject({ status: 'complete', resolution: 'completed' });
    expect(completed.result).toContain('[REDACTED]');
    expect(completed.result).not.toContain('e2e-super-secret');
    expect(existsSync(injectionMarker)).toBe(false);

    await apiRunQuickAction(failingAction.id, { clientRequestId: 'e2e-failing-run', parameterValues: {} });
    const failedRunning = await getCard('Fail deployment');
    trackCard(failedRunning.id);
    expect(failedRunning.status).toBe('in_progress');
    await waitForCard('Fail deployment', 'complete');
    const failed = await getCard('Fail deployment');
    expect(failed).toMatchObject({ status: 'complete', resolution: 'failed' });

    await page.reload();
    const completedCard = page.locator('.kv2-column[data-status="complete"] .kv2-card', { hasText: 'Deploy service' });
    await expect(completedCard).toBeVisible();
    await completedCard.getByRole('button', { name: /Open details/ }).click();
    await expect(page.getByRole('heading', { name: 'Execution' })).toBeVisible();
    await expect(page.getByText('E2E deployment', { exact: true })).toBeVisible();
    await expect(page.getByText('completed', { exact: true })).toBeVisible();
    await expect(page.getByText(/Result captured/)).toBeVisible();
  });

  test('keeps the iPhone launcher and DialogSkeleton within the viewport without covering board controls', async ({
    page,
    seedQuickAction,
  }) => {
    await seedQuickAction({
      type: 'prompt',
      name: 'Mobile audit',
      description: 'Responsive parameter dialog',
      cardTitleTemplate: 'Mobile {{scope}}',
      promptTemplate: '[hold-open] Mobile {{scope}}',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      parameterDefinitions: [
        { key: 'scope', label: 'Scope', type: 'select', required: true, options: ['all'], defaultValue: 'all' },
      ],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const launcher = page.getByRole('button', { name: 'Quick Actions', exact: true });
    const header = page.locator('.app-header');
    const mobileNav = page.locator('.kv2-board-mobile-nav');
    await expect(launcher).toBeVisible();
    await expect(mobileNav).toBeVisible();

    const layout = await page.evaluate(() => {
      const launcherRect = document.querySelector('.kv2-quick-actions-launcher')?.getBoundingClientRect();
      const headerRect = document.querySelector('.app-header')?.getBoundingClientRect();
      const navRect = document.querySelector('.kv2-board-mobile-nav')?.getBoundingClientRect();
      const main = document.querySelector('.app-main');
      return {
        launcher: launcherRect ? { top: launcherRect.top, bottom: launcherRect.bottom, left: launcherRect.left, right: launcherRect.right, height: launcherRect.height } : null,
        headerBottom: headerRect?.bottom ?? null,
        navBottom: navRect?.bottom ?? null,
        mainPaddingBottom: main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    expect(layout.launcher).not.toBeNull();
    expect(layout.launcher!.top).toBeGreaterThan(layout.headerBottom ?? 0);
    expect(layout.launcher!.top).toBeGreaterThan(layout.navBottom ?? 0);
    expect(layout.launcher!.left).toBeGreaterThanOrEqual(0);
    expect(layout.launcher!.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.launcher!.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(layout.mainPaddingBottom).toBeGreaterThan(layout.launcher!.height);
    await page.screenshot({ path: 'e2e/results/quick-actions-report/mobile-launcher.png', fullPage: true });

    await openQuickActions(page);
    await page.getByRole('button', { name: 'Run Mobile audit' }).click();
    const dialogMetrics = await page.getByRole('dialog', { name: 'Run Mobile audit' }).evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, zIndex: getComputedStyle(dialog).zIndex };
    });
    expect(dialogMetrics.top).toBeGreaterThanOrEqual(0);
    expect(dialogMetrics.left).toBeGreaterThanOrEqual(0);
    expect(dialogMetrics.right).toBeLessThanOrEqual(390);
    expect(dialogMetrics.bottom).toBeLessThanOrEqual(844);
    await page.screenshot({ path: 'e2e/results/quick-actions-report/mobile-parameters.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(launcher).toBeFocused();
  });

  test('audits launcher, parameter Dialog, and execution cards in light and dark themes', async ({
    page,
    seedQuickAction,
    seedScript,
    trackCard,
  }) => {
    const script = await seedScript({
      name: 'Visual script',
      description: 'Visual script execution card',
      content: 'sleep 2; echo visual',
      language: 'bash',
      projectDir: PROJECT_DIR,
    });
    const scriptAction = await seedQuickAction({
      type: 'script',
      name: 'Deploy production',
      description: 'Production deployment visual audit',
      scriptId: script.id,
      parameterDefinitions: [{ key: 'target', label: 'Target', type: 'string', required: true, defaultValue: 'preview' }],
    });
    const agentAction = await seedQuickAction({
      type: 'prompt',
      name: 'Visual agent action',
      description: 'Visual prompt audit',
      cardTitleTemplate: 'Visual agent {{target}}',
      promptTemplate: '[hold-open] Visual agent {{target}}',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      model: 'gpt-5.5',
      command: 'prompts:verifier',
      argumentsTemplate: '--target={{target}}',
      codexOptions: {
        reasoningEffort: 'high',
        sandbox: 'read-only',
        skipGitRepoCheck: true,
        bypassApprovalsAndSandbox: false,
      },
      parameterDefinitions: [{ key: 'target', label: 'Target', type: 'string', required: true, defaultValue: 'preview' }],
    });
    const failingScript = await seedScript({
      name: 'Visual failing script',
      description: 'Visual failed execution card',
      content: 'echo visual failure >&2; exit 7',
      language: 'bash',
      projectDir: PROJECT_DIR,
    });
    const failingAction = await seedQuickAction({
      type: 'script',
      name: 'Visual failed action',
      description: 'Failure visual audit',
      scriptId: failingScript.id,
      parameterDefinitions: [],
    });

    const scriptRun = await apiRunQuickAction(scriptAction.id, {
      clientRequestId: 'visual-script-run',
      parameterValues: { target: 'preview' },
    });
    trackCard(scriptRun.cardId);
    const agentRun = await apiRunQuickAction(agentAction.id, {
      clientRequestId: 'visual-agent-run',
      parameterValues: { target: 'preview' },
    });
    trackCard(agentRun.cardId);
    const failedRun = await apiRunQuickAction(failingAction.id, {
      clientRequestId: 'visual-failed-run',
      parameterValues: {},
    });
    trackCard(failedRun.cardId);
    await waitForCard('Visual failed action', 'complete');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.locator('.kv2-card', { hasText: 'Deploy production' })).toBeVisible();
    await expect(page.locator('.kv2-card', { hasText: 'Visual agent preview' })).toBeVisible();
    await expect(page.locator('.kv2-card', { hasText: 'Visual failed action' })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await openQuickActions(page);
      await page.screenshot({ path: `e2e/results/quick-actions-report/launcher-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Manage', exact: true }).click();
      await page.screenshot({ path: `e2e/results/quick-actions-report/manage-${theme}.png`, fullPage: true });
      await page.locator('.kv2-quick-action-item--manage', { hasText: 'Visual agent action' }).getByRole('button', { name: 'Edit' }).click();
      await page.screenshot({ path: `e2e/results/quick-actions-report/prompt-editor-${theme}.png`, fullPage: true });
      const editorDialog = page.getByRole('dialog', { name: 'Edit Quick Action' });
      await editorDialog.getByText('Command', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `e2e/results/quick-actions-report/prompt-options-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      await page.getByRole('button', { name: 'Add Action', exact: true }).click();
      await page.getByLabel('Action type').selectOption('script');
      await page.getByLabel('Name').fill('Deploy service sample');
      await page.getByLabel('Script', { exact: true }).selectOption(script.id);
      await page.getByRole('button', { name: 'Add Parameter', exact: true }).click();
      await page.getByLabel('Parameter 1 key').fill('service');
      await page.getByLabel('Parameter 1 label').fill('Service');
      await page.getByText('Required', { exact: true }).locator('..').getByRole('checkbox').check();
      await page.screenshot({ path: `e2e/results/quick-actions-report/script-editor-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Run Visual agent action' }).click();
      await expect(page.getByRole('dialog', { name: 'Run Visual agent action' })).toBeVisible();
      await page.screenshot({ path: `e2e/results/quick-actions-report/prompt-parameters-${theme}.png`, fullPage: true });
      await page.keyboard.press('Escape');

      await openQuickActions(page);
      await page.getByRole('button', { name: 'Run Deploy production' }).click();
      await expect(page.getByText('I confirm this production or elevated-permission action.', { exact: true })).toBeVisible();
      await page.screenshot({ path: `e2e/results/quick-actions-report/script-production-${theme}.png`, fullPage: true });
      await page.keyboard.press('Escape');

      const palette = await page.evaluate(() => {
        const launcher = document.querySelector('.kv2-quick-actions-launcher');
        const card = document.querySelector('.kv2-card');
        return {
          launcherBackground: launcher ? getComputedStyle(launcher).backgroundColor : null,
          cardBackground: card ? getComputedStyle(card).backgroundColor : null,
          rootBackground: getComputedStyle(document.documentElement).getPropertyValue('--kv2-app-bg').trim(),
        };
      });
      expect(palette.launcherBackground).not.toBeNull();
      expect(palette.cardBackground).not.toBeNull();
      await page.screenshot({ path: `e2e/results/quick-actions-report/cards-${theme}.png`, fullPage: true });
    }
  });
});
