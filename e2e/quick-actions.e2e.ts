import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { RUNTIME_MODEL_PREFERENCE_KEY } from '../src/core/runtime-config';
import { test, expect } from './fixtures/kanban';
import {
  apiGetCards,
  apiGetQuickActions,
  apiRunQuickAction,
  apiUpdateCard,
} from './helpers/api';

const PROJECT_DIR = process.cwd();
const QUICK_ACTIONS_PATH = join(PROJECT_DIR, '.e2e-data', 'quick-actions.json');

async function removePersistedIcon(actionId: string): Promise<void> {
  const registry = JSON.parse(await readFile(QUICK_ACTIONS_PATH, 'utf8')) as {
    entries?: Array<Record<string, unknown>>;
  };
  const entry = registry.entries?.find((candidate) => candidate.id === actionId);
  if (!entry) throw new Error(`Quick Action fixture missing: ${actionId}`);
  delete entry.icon;
  await writeFile(QUICK_ACTIONS_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

async function openQuickActions(page: Page): Promise<void> {
  const rail = page.getByRole('button', { name: 'Open Quick Actions', exact: true });
  await expect(page.getByRole('complementary', { name: 'Quick Actions' })).toBeVisible();
  await expect(rail).toHaveAttribute('aria-controls', 'quick-actions-drawer-panel');
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await rail.click();
  const panel = page.getByRole('dialog', { name: 'Quick Actions', exact: true });
  const close = panel.getByRole('button', { name: 'Close dialog', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('id', 'quick-actions-drawer-panel');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(panel).toHaveAttribute('aria-labelledby', /quick-actions-drawer-panel-title/);
  await expect(page.getByRole('button', { name: 'Close dialog backdrop', exact: true })).toBeVisible();
  await expect(close).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add Action', exact: true })).toBeFocused();
}

async function openActionMenu(page: Page, actionName: string) {
  const row = page.locator('.kv2-quick-action-drawer-row', { hasText: actionName });
  const summary = row.locator(`summary[aria-label="More actions for ${actionName}"]`);
  await summary.click();
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  return { row, more: summary };
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
  test('assigns unique defaults, renders a legacy fallback, and completes custom emoji CRUD', async ({
    page,
    seedQuickAction,
    trackQuickAction,
  }) => {
    const first = await seedQuickAction({
      type: 'prompt',
      name: 'Default icon one',
      description: 'First automatically assigned icon',
      cardTitleTemplate: 'Default icon one',
      promptTemplate: '[hold-open] Default icon one',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      pinned: true,
      parameterDefinitions: [],
    });
    const second = await seedQuickAction({
      type: 'prompt',
      name: 'Default icon two',
      description: 'Second automatically assigned icon',
      cardTitleTemplate: 'Default icon two',
      promptTemplate: '[hold-open] Default icon two',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      parameterDefinitions: [],
    });
    expect(first.icon).toBeTruthy();
    expect(second.icon).toBeTruthy();
    expect(second.icon).not.toBe(first.icon);

    const legacy = await seedQuickAction({
      type: 'prompt',
      name: 'Legacy icon action',
      description: 'Persisted without an icon',
      cardTitleTemplate: 'Legacy icon action',
      promptTemplate: '[hold-open] Legacy icon action',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      parameterDefinitions: [],
    });
    await removePersistedIcon(legacy.id);
    const legacyView = (await apiGetQuickActions()).find((action) => action.id === legacy.id);
    expect(legacyView?.icon).toBeTruthy();
    expect(legacyView?.icon).not.toBe(first.icon);
    expect(legacyView?.icon).not.toBe(second.icon);

    await page.goto('/');
    await openQuickActions(page);
    const firstRow = page.locator('.kv2-quick-action-drawer-row', { hasText: first.name });
    const secondRow = page.locator('.kv2-quick-action-drawer-row', { hasText: second.name });
    const legacyRow = page.locator('.kv2-quick-action-drawer-row', { hasText: legacy.name });
    await expect(firstRow.locator('.kv2-quick-action-item-icon')).toHaveText(first.icon);
    await expect(secondRow.locator('.kv2-quick-action-item-icon')).toHaveText(second.icon);
    await expect(legacyRow.locator('.kv2-quick-action-item-icon')).toHaveText(legacyView!.icon);
    await expect(firstRow.locator('.kv2-quick-action-item-title')).toHaveText(first.name);
    await expect(firstRow.getByText('Pinned', { exact: true })).toBeVisible();
    const rowAlignment = await firstRow.evaluate((row) => {
      const left = (selector: string) => row.querySelector(selector)?.getBoundingClientRect().left ?? null;
      return {
        title: left('.kv2-quick-action-item-title'),
        meta: left('.kv2-quick-action-drawer-meta'),
        description: left('.kv2-quick-action-item-description'),
      };
    });
    expect(rowAlignment.title).not.toBeNull();
    expect(rowAlignment.meta).toBe(rowAlignment.title);
    expect(rowAlignment.description).toBe(rowAlignment.title);

    await page.getByRole('button', { name: 'Add Action', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add Quick Action' });
    await expect(editor).toHaveAttribute('aria-modal', 'true');
    await editor.getByLabel('Name').fill('Custom emoji action');
    await editor.getByLabel('Custom emoji').fill('🧑‍💻');
    await editor.getByLabel('Card title template').fill('Custom emoji action');
    await editor.getByLabel('Prompt template').fill('[hold-open] Custom emoji action');
    await editor.getByLabel('Project directory *').fill(PROJECT_DIR);
    await editor.getByRole('button', { name: 'Use directory', exact: true }).click();
    await editor.getByRole('button', { name: 'Save Action', exact: true }).click();

    const custom = (await apiGetQuickActions()).find((action) => action.name === 'Custom emoji action');
    if (!custom) throw new Error('Custom emoji Quick Action missing');
    trackQuickAction(custom.id);
    expect(custom.icon).toBe('🧑‍💻');
    const customRow = page.locator('.kv2-quick-action-drawer-row', { hasText: custom.name });
    await expect(customRow.locator('.kv2-quick-action-item-icon')).toHaveText('🧑‍💻');

    await openActionMenu(page, custom.name);
    await customRow.getByRole('button', { name: `Edit ${custom.name}` }).click();
    await page.getByRole('dialog', { name: 'Edit Quick Action' }).getByLabel('Custom emoji').fill('🛰️');
    await page.getByRole('button', { name: 'Save Action', exact: true }).click();
    await expect(customRow.locator('.kv2-quick-action-item-icon')).toHaveText('🛰️');
    expect((await apiGetQuickActions()).find((action) => action.id === custom.id)?.icon).toBe('🛰️');

    await openActionMenu(page, custom.name);
    page.once('dialog', (dialog) => dialog.accept());
    await customRow.getByRole('button', { name: `Delete ${custom.name}` }).click();
    await expect(customRow).not.toBeVisible();
    expect((await apiGetQuickActions()).some((action) => action.id === custom.id)).toBe(false);
  });

  test('keeps Parameter Key focused while typing and explains run and pin behavior', async ({ page }) => {
    await page.goto('/');
    await openQuickActions(page);
    await page.getByRole('button', { name: 'Add Action', exact: true }).click();

    const editor = page.getByRole('dialog', { name: 'Add Quick Action' });
    const enabled = editor.getByRole('checkbox', { name: /Allow this action to run/ });
    const pinned = editor.getByRole('checkbox', { name: /Pin to top of list/ });
    await expect(enabled).toBeChecked();
    await expect(pinned).not.toBeChecked();
    await expect(editor.getByText('Turn this off to keep the action saved while preventing new runs.')).toBeVisible();
    await expect(editor.getByText('Show this action before Quick Actions that are not pinned.')).toBeVisible();

    await editor.getByRole('button', { name: 'Add Parameter', exact: true }).click();
    const parameterKey = editor.getByLabel('Parameter 1 key');
    await parameterKey.click();
    await parameterKey.pressSequentially('service_name');
    await expect(parameterKey).toBeFocused();
    await expect(parameterKey).toHaveValue('service_name');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('uses the Create Card Runtime and Model defaults for a new Prompt action', async ({ page }) => {
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({ runtime: 'codex', codex: 'gpt-5.5' }));
    }, { key: RUNTIME_MODEL_PREFERENCE_KEY });
    await page.goto('/');

    await page.getByRole('button', { name: 'Create new card' }).click();
    const createDialog = page.locator('.kv2-dialog--create');
    await expect(createDialog.getByRole('radio', { name: 'Codex', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(createDialog.locator('#create-card-model-select')).toHaveValue('gpt-5.5');
    const createRuntime = await createDialog.getByRole('radio', { checked: true }).textContent();
    const createModel = await createDialog.locator('#create-card-model-select').inputValue();
    await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openQuickActions(page);
    await page.getByRole('button', { name: 'Add Action', exact: true }).click();
    const quickActionDialog = page.getByRole('dialog', { name: 'Add Quick Action' });
    await expect(quickActionDialog.getByRole('radio', { name: 'Codex', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(quickActionDialog.locator('#quick-action-model')).toHaveValue(createModel);
    expect(await quickActionDialog.getByRole('radio', { checked: true }).textContent()).toBe(createRuntime);
    await quickActionDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

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

    const managed = page.locator('.kv2-quick-action-drawer-row', { hasText: 'MCP recent monitor' });
    const menu = await openActionMenu(page, 'MCP recent monitor');
    const editButton = managed.getByRole('button', { name: 'Edit MCP recent monitor' });
    await editButton.click();
    await expect(page.getByRole('dialog', { name: 'Edit Quick Action' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Edit Quick Action' })).not.toBeVisible();
    await expect(page.locator('#quick-actions-drawer-panel')).toBeVisible();
    await expect(menu.more).toBeFocused();
    await openActionMenu(page, 'MCP recent monitor');
    await managed.getByRole('button', { name: 'Edit MCP recent monitor' }).click();
    await page.getByLabel('Name').fill('MCP recent monitor edited');
    await page.getByRole('button', { name: 'Save Action' }).click();
    await expect(page.locator('.kv2-quick-action-drawer-row', { hasText: 'MCP recent monitor edited' })).toBeVisible();

    await page.getByRole('button', { name: 'Run MCP recent monitor edited' }).click();
    const runPanel = page.locator('#quick-actions-drawer-panel');
    await expect(runPanel.getByRole('heading', { name: 'Run MCP recent monitor edited' })).toBeVisible();
    await expect(runPanel.getByText('Prompt', { exact: true })).toBeVisible();
    await expect(runPanel.getByText(PROJECT_DIR, { exact: true })).toBeVisible();
    await expect(runPanel.getByText('{{days}}', { exact: true })).toBeVisible();
    await expect(runPanel.getByLabel('Days')).toHaveValue('3');
    await page.getByRole('button', { name: 'Run Action' }).click();
    await expect(runPanel).not.toBeVisible();

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
    await expect(completeCard.getByText('CODEX', { exact: true })).toBeVisible();

    await openQuickActions(page);
    await openActionMenu(page, 'MCP recent monitor edited');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.kv2-quick-action-drawer-row', { hasText: 'MCP recent monitor edited' }).getByRole('button', { name: 'Delete MCP recent monitor edited' }).click();
    await expect(page.locator('.kv2-quick-action-drawer-row', { hasText: 'MCP recent monitor edited' })).not.toBeVisible();
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
    await expect(completedCard.getByText('SCRIPT', { exact: true })).toBeVisible();
    await expect(completedCard.getByText('OPENCODE', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'List', exact: true }).click();
    const completedRow = page.locator('.kv2-list-table-row', { hasText: 'Deploy service' });
    await expect(completedRow).toBeVisible();
    await expect(completedRow.getByText('SCRIPT', { exact: true })).toBeVisible();
    await expect(completedRow.getByText('OPENCODE', { exact: true })).toHaveCount(0);
    await completedRow.locator('.kv2-list-title-open').click();
    const detail = page.locator('.kv2-dialog--detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByText('SCRIPT', { exact: true })).toBeVisible();
    await expect(detail.getByText('OPENCODE', { exact: true })).toHaveCount(0);
    await expect(detail.getByText('Type', { exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Execution' })).toBeVisible();
    await expect(detail.getByText('E2E deployment', { exact: true })).toBeVisible();
    await expect(detail.getByText('completed', { exact: true })).toBeVisible();
    await expect(detail.getByText(/Result captured/)).toBeVisible();
  });

  test('keeps Board and List geometry stable behind an inert desktop side sheet', async ({
    page,
    seedQuickAction,
  }) => {
    await seedQuickAction({
      type: 'prompt',
      name: 'Desktop sheet audit',
      description: 'Modal side-sheet layout verification',
      cardTitleTemplate: 'Desktop sheet audit',
      promptTemplate: '[hold-open] Verify the side-sheet layout.',
      projectDir: PROJECT_DIR,
      agentRuntime: 'codex',
      parameterDefinitions: [],
    });

    for (const width of [954, 1286, 1920, 2048]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto('/');
      await expect(page.locator('.kv2-board')).toBeVisible();
      const before = await page.evaluate(() => {
        const content = document.querySelector('.kv2-board-workspace-content')?.getBoundingClientRect();
        const launcher = document.querySelector('.kv2-quick-actions-rail')?.getBoundingClientRect();
        const launcherShell = document.querySelector<HTMLElement>('.kv2-quick-actions-drawer');
        const launcherLabel = document.querySelector<HTMLElement>('.kv2-quick-actions-rail-label');
        const launcherCue = document.querySelector<HTMLElement>('.kv2-quick-actions-rail-cue');
        const firstColumnHeader = document.querySelector('.kv2-column-header')?.getBoundingClientRect();
        const columns = Array.from(document.querySelectorAll('.kv2-column')).map((column) => {
          const rect = column.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width };
        });
        return {
          content: content ? { x: content.x, width: content.width } : null,
          launcher: launcher ? { x: launcher.x, right: launcher.right, width: launcher.width, height: launcher.height } : null,
          launcherPosition: launcherShell ? getComputedStyle(launcherShell).position : null,
          launcherLabelDisplay: launcherLabel ? getComputedStyle(launcherLabel).display : null,
          launcherCueDisplay: launcherCue ? getComputedStyle(launcherCue).display : null,
          launcherWritingMode: launcher ? getComputedStyle(document.querySelector('.kv2-quick-actions-rail')!).writingMode : null,
          firstColumnHeaderX: firstColumnHeader?.x ?? null,
          columns,
        };
      });
      expect(await page.locator('.kv2-quick-actions-launcher').count()).toBe(0);
      expect(before.launcher).not.toBeNull();
      expect(before.launcherPosition).toBe('absolute');
      expect(before.launcher!.width).toBeGreaterThan(before.launcher!.height);
      expect(before.launcher!.width).toBeGreaterThanOrEqual(70);
      expect(before.launcher!.width).toBeLessThanOrEqual(110);
      expect(before.firstColumnHeaderX).not.toBeNull();
      expect(before.launcher!.right).toBeLessThanOrEqual(before.firstColumnHeaderX!);
      expect(before.launcherLabelDisplay).not.toBe('none');
      expect(before.launcherCueDisplay).not.toBe('none');
      expect(before.launcherWritingMode).toBe('horizontal-tb');
      await page.screenshot({ path: `e2e/results/quick-actions-report/desktop-launcher-${width}.png` });

      await openQuickActions(page);
      const panel = page.locator('#quick-actions-drawer-panel');
      const audit = await page.evaluate(() => {
        const drawer = document.querySelector('#quick-actions-drawer-panel')?.getBoundingClientRect();
        const backdrop = document.querySelector<HTMLElement>('.kv2-dialog-backdrop');
        const boardContent = document.querySelector<HTMLElement>('.kv2-board-workspace-content');
        const appHeader = document.querySelector<HTMLElement>('.app-header');
        const content = boardContent?.getBoundingClientRect();
        const title = document.querySelector('#quick-actions-drawer-panel .kv2-dialog-title')?.getBoundingClientRect();
        const close = document.querySelector('#quick-actions-drawer-panel .kv2-dialog-close')?.getBoundingClientRect();
        const add = document.querySelector('#quick-actions-drawer-panel .kv2-quick-actions-add')?.getBoundingClientRect();
        const columns = Array.from(document.querySelectorAll('.kv2-column')).map((column) => {
          const rect = column.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width };
        });
        return {
          drawer: drawer ? { left: drawer.left, top: drawer.top, right: drawer.right, width: drawer.width, height: drawer.height } : null,
          content: content ? { x: content.x, width: content.width } : null,
          columns,
          backdropBackground: backdrop ? getComputedStyle(backdrop).backgroundColor : null,
          inert: boardContent?.hasAttribute('inert') ?? false,
          ariaHidden: boardContent?.getAttribute('aria-hidden'),
          headerInert: appHeader?.hasAttribute('inert') ?? false,
          headerAriaHidden: appHeader?.getAttribute('aria-hidden'),
          titleCenterY: title ? title.y + title.height / 2 : null,
          closeCenterY: close ? close.y + close.height / 2 : null,
          addRight: add?.right ?? null,
        };
      });
      expect(audit.drawer).not.toBeNull();
      expect(audit.drawer!.left).toBe(0);
      expect(audit.drawer!.top).toBe(0);
      expect(audit.drawer!.width).toBeGreaterThanOrEqual(420);
      expect(audit.drawer!.width).toBeLessThanOrEqual(480);
      expect(audit.drawer!.height).toBe(1080);
      expect(audit.drawer!.right).toBeLessThan(width / 2);
      expect(audit.backdropBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(audit.inert).toBe(true);
      expect(audit.ariaHidden).toBe('true');
      expect(audit.headerInert).toBe(true);
      expect(audit.headerAriaHidden).toBe('true');
      expect(audit.content).toEqual(before.content);
      expect(audit.columns).toEqual(before.columns);
      expect(Math.abs((audit.titleCenterY ?? 0) - (audit.closeCenterY ?? 0))).toBeLessThan(2);
      expect(audit.addRight).toBeLessThanOrEqual(audit.drawer!.right);
      await page.screenshot({ path: `e2e/results/quick-actions-report/desktop-sheet-${width}.png` });

      if (width === 1920) await page.keyboard.press('Escape');
      else await page.mouse.click(width - 1, 1);
      await expect(panel).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Open Quick Actions', exact: true })).toBeFocused();
    }

    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.locator('.kv2-board-list')).toBeVisible();
    const listBefore = await page.locator('.kv2-board-list').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    });
    await openQuickActions(page);
    const listAfter = await page.evaluate(() => {
      const list = document.querySelector('.kv2-board-list')?.getBoundingClientRect();
      return list ? { x: list.x, width: list.width } : null;
    });
    expect(listAfter).toEqual(listBefore);
    await page.getByRole('dialog', { name: 'Quick Actions' }).getByRole('button', { name: 'Close dialog' }).click();
  });

  test('uses a full-screen mobile sheet with Escape and focus return', async ({
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
    const rail = page.getByRole('button', { name: 'Open Quick Actions', exact: true });
    const mobileNav = page.locator('.kv2-board-mobile-nav');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-expanded', 'false');
    await expect(mobileNav).toBeVisible();

    const layout = await page.evaluate(() => {
      const railElement = document.querySelector('.kv2-quick-actions-rail');
      const railShell = document.querySelector('.kv2-quick-actions-drawer');
      const railLabel = document.querySelector<HTMLElement>('.kv2-quick-actions-rail-label');
      const railRect = railElement?.getBoundingClientRect();
      const main = document.querySelector('.app-main');
      return {
        fixedLauncherMissing: document.querySelector('.kv2-quick-actions-launcher') === null,
        rail: railRect ? { left: railRect.left, right: railRect.right, width: railRect.width } : null,
        railPosition: railElement ? getComputedStyle(railElement).position : null,
        railShellPosition: railShell ? getComputedStyle(railShell).position : null,
        railLabelDisplay: railLabel ? getComputedStyle(railLabel).display : null,
        railWritingMode: railElement ? getComputedStyle(railElement).writingMode : null,
        mainPaddingBottom: main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    expect(layout.fixedLauncherMissing).toBe(true);
    expect(layout.rail).not.toBeNull();
    expect(layout.rail!.left).toBeGreaterThanOrEqual(0);
    expect(layout.rail!.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.rail!.width).toBeGreaterThanOrEqual(70);
    expect(layout.rail!.width).toBeLessThanOrEqual(140);
    expect(layout.railPosition).not.toBe('fixed');
    expect(layout.railShellPosition).toBe('static');
    expect(layout.railLabelDisplay).not.toBe('none');
    expect(layout.railWritingMode).toBe('horizontal-tb');
    expect(layout.mainPaddingBottom).toBeLessThanOrEqual(24);
    await page.screenshot({ path: 'e2e/results/quick-actions-report/mobile-rail.png', fullPage: true });

    await openQuickActions(page);
    await expect(page.locator('.kv2-board-workspace-content')).toHaveAttribute('inert', '');
    await expect(page.locator('.kv2-board-workspace-content')).toHaveAttribute('aria-hidden', 'true');
    const drawer = page.locator('#quick-actions-drawer-panel');
    const drawerMetrics = await drawer.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const body = panel.querySelector('.kv2-quick-actions-drawer-body');
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        top: rect.top,
        height: rect.height,
        bodyPaddingBottom: body ? Number.parseFloat(getComputedStyle(body).paddingBottom) : 0,
      };
    });
    expect(drawerMetrics.left).toBe(0);
    expect(drawerMetrics.right).toBe(390);
    expect(drawerMetrics.width).toBe(390);
    expect(drawerMetrics.top).toBe(0);
    expect(drawerMetrics.height).toBe(844);
    expect(drawerMetrics.bodyPaddingBottom).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Run Mobile audit' }).click();
    await expect(drawer.getByRole('heading', { name: 'Run Mobile audit' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Quick Actions' })).toHaveCount(1);
    await page.screenshot({ path: 'e2e/results/quick-actions-report/mobile-parameters.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-expanded', 'false');
    await expect(rail).toBeFocused();
    await expect(mobileNav).toBeVisible();
  });

  test('audits drawer, editor Dialog, parameters, and execution cards in light and dark themes', async ({
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
      await page.screenshot({ path: `e2e/results/quick-actions-report/drawer-${theme}.png`, fullPage: true });
      await openActionMenu(page, 'Visual agent action');
      await page.locator('.kv2-quick-action-drawer-row', { hasText: 'Visual agent action' }).getByRole('button', { name: 'Edit Visual agent action' }).click();
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
      await page.getByRole('button', { name: 'Run Visual agent action' }).click();
      await expect(page.locator('#quick-actions-drawer-panel').getByRole('heading', { name: 'Run Visual agent action' })).toBeVisible();
      await page.screenshot({ path: `e2e/results/quick-actions-report/prompt-parameters-${theme}.png`, fullPage: true });
      await page.keyboard.press('Escape');

      await openQuickActions(page);
      await page.getByRole('button', { name: 'Run Deploy production' }).click();
      const confirmation = page.getByRole('checkbox', {
        name: 'I confirm this production or elevated-permission action.',
      });
      const productionRun = page.getByRole('button', { name: 'Run Action', exact: true });
      await expect(confirmation).toBeVisible();
      await expect(productionRun).toBeDisabled();
      await confirmation.check();
      await expect(productionRun).toBeEnabled();
      await page.screenshot({ path: `e2e/results/quick-actions-report/script-production-${theme}.png`, fullPage: true });
      await page.keyboard.press('Escape');

      const palette = await page.evaluate(() => {
        const rail = document.querySelector('.kv2-quick-actions-rail');
        const card = document.querySelector('.kv2-card');
        return {
          railBackground: rail ? getComputedStyle(rail).backgroundColor : null,
          cardBackground: card ? getComputedStyle(card).backgroundColor : null,
          rootBackground: getComputedStyle(document.documentElement).getPropertyValue('--kv2-app-bg').trim(),
        };
      });
      expect(palette.railBackground).not.toBeNull();
      expect(palette.cardBackground).not.toBeNull();
      await page.screenshot({ path: `e2e/results/quick-actions-report/cards-${theme}.png`, fullPage: true });
    }
  });
});
