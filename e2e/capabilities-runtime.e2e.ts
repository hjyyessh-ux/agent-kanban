import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures/kanban';

async function goToCapabilities(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('#app-tab-capabilities').click();
  await expect(page.locator('#app-panel-capabilities')).toBeVisible();
}

async function chooseTarget(dialog: import('@playwright/test').Locator, label: string) {
  const select = dialog.locator('select[aria-label="Target placement"]');
  const option = select.locator('option').filter({ hasText: label });
  await select.selectOption(await option.getAttribute('value') ?? '');
}

test.describe('Capabilities runtime MCP isolated user flow', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('filters complete Claude/Codex/OpenCode inventory and keeps same-name MCP separate', async ({ page }) => {
    await goToCapabilities(page);
    const inventory = page.locator('.inv-view');
    const runtimeFilter = inventory.getByRole('group', { name: 'Filter by runtime' });
    await expect(runtimeFilter.getByRole('button', { name: /All \(10\)/ })).toBeVisible();
    await expect(runtimeFilter.getByRole('button', { name: /Claude \(4\)/ })).toBeVisible();
    await expect(runtimeFilter.getByRole('button', { name: /Codex \(5\)/ })).toBeVisible();
    await expect(runtimeFilter.getByRole('button', { name: /OpenCode \(1\)/ })).toBeVisible();

    await expect(page.locator('button[aria-label="Open claude MCP details for shared"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Open codex MCP details for shared"]')).toBeVisible();
    await expect(inventory.locator('.kv2-runtime-badge--claude').first()).toBeVisible();
    await expect(inventory.locator('.kv2-runtime-badge--codex').first()).toBeVisible();
    await expect(inventory.locator('.kv2-runtime-badge--opencode').first()).toBeVisible();

    await runtimeFilter.getByRole('button', { name: /Codex \(5\)/ }).click();
    await expect(page.locator('button[aria-label="Open codex MCP details for shared"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Open claude MCP details for shared"]')).not.toBeVisible();
    await expect(inventory.getByText('$e2e-codex-skill', { exact: true })).toBeVisible();
    await expect(inventory.getByText('/e2e-sample-skill', { exact: true })).not.toBeVisible();

    await runtimeFilter.getByRole('button', { name: /OpenCode \(1\)/ }).click();
    await expect(inventory.getByText('/e2e-opencode-skill', { exact: true })).toBeVisible();
    await expect(inventory.locator('.inv-item--mcp')).toHaveCount(0);

    await runtimeFilter.getByRole('button', { name: /All \(10\)/ }).click();
    await expect(inventory.locator('.inv-item--mcp')).toHaveCount(7);
    await expect(inventory.locator('.inv-item--skill')).toHaveCount(3);
  });

  test('registers a Codex directory target with the actual config path hint', async ({ page }) => {
    await goToCapabilities(page);
    const panel = page.locator('.ptp-panel');
    await panel.getByRole('button', { name: '+ Add Target' }).click();
    await panel.getByLabel('Target label').fill('E2E UI Codex target');
    await panel.getByLabel('Target runtime').selectOption('codex');
    await panel.getByLabel('Target kind').selectOption('local');
    const targetDir = resolve(process.cwd(), '.e2e-home', 'workspace', 'codex-ui-target');
    await panel.locator('#ptp-target-dir').fill(targetDir);
    await expect(panel).toContainText(`${targetDir}/.codex/config.toml`);
    await panel.getByRole('button', { name: '+ Add', exact: true }).click();
    const row = panel.locator('.ptp-item', { hasText: 'E2E UI Codex target' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${targetDir}/.codex/config.toml`);
    await expect(row.locator('.cap-badge--codex')).toBeVisible();
  });

  test('previews Codex copy/move/remove and preserves runtime-specific UI', async ({ page }) => {
    await goToCapabilities(page);
    await page.locator('button[aria-label="Open codex MCP details for shared"]').click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await expect(dialog.locator('.kv2-runtime-badge--codex')).toBeVisible();
    await expect(dialog).toContainText('.codex/config.toml');
    await expect(dialog).toContainText('effective');
    await expect(dialog).toContainText('Codex는 enabled / tool allow·deny 설정을 사용합니다.');

    await dialog.getByRole('button', { name: 'Copy' }).click();
    await chooseTarget(dialog, 'E2E Codex destination');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const diff = dialog.locator('.diff-preview');
    await expect(diff).toContainText('apps = false');
    await expect(diff).toContainText('[mcp_servers."shared"]');
    await diff.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toContainText('Copied successfully');
    const destinationConfig = readFileSync(
      resolve(process.cwd(), '.e2e-home', 'workspace', 'codex-destination', '.codex', 'config.toml'),
      'utf8',
    );
    expect(destinationConfig).toContain('model = "gpt-5.4-mini" # preserve destination');
    expect(destinationConfig).toContain('[features]\napps = false');

    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await chooseTarget(dialog, 'E2E UI Codex target');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Cancel' }).click();

    const destinationPlacement = dialog.locator('.inv-placement-row', { hasText: 'codex-destination/.codex/config.toml' });
    await destinationPlacement.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    page.once('dialog', (confirm) => confirm.accept());
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toContainText('Removed');
    await page.keyboard.press('Escape');
  });

  test('blocks a team-shared Codex secret until confirmation', async ({ page }) => {
    await goToCapabilities(page);
    await page.locator('button[aria-label="Open codex MCP details for secret_team"]').click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await chooseTarget(dialog, 'E2E Codex destination');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog).toContainText('Secret 경고');
    await dialog.getByRole('button', { name: '위험 감수하고 진행' }).click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Escape');
  });

  test('freezes and restores a Codex user MCP through DiffPreview', async ({ page }) => {
    await goToCapabilities(page);
    await page.locator('button[aria-label="Open codex MCP details for codex_user"]').click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await dialog.getByRole('button', { name: /Freeze/ }).first().click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    const userConfigPath = resolve(process.cwd(), '.e2e-home', '.codex', 'config.toml');
    await expect.poll(() => readFileSync(userConfigPath, 'utf8')).not.toContain('[mcp_servers.codex_user]');

    await page.locator('.cap-viewnav-btn', { hasText: 'Cold Storage' }).click();
    const cold = page.locator('.cold-item', { hasText: 'codex/codex_user' });
    await expect(cold).toBeVisible();
    const coldSelect = cold.locator('select');
    const coldOption = coldSelect.locator('option').filter({ hasText: 'E2E Codex destination' });
    await coldSelect.selectOption(await coldOption.getAttribute('value') ?? '');
    await cold.getByRole('button', { name: 'Preview' }).click();
    await expect(cold.locator('.diff-preview')).toBeVisible();
    await cold.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    await expect(cold).not.toBeVisible();
  });

  test('keeps Claude alwaysLoad and mutation preview controls intact', async ({ page }) => {
    await goToCapabilities(page);
    await page.locator('button[aria-label="Open claude MCP details for shared"]').click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await expect(dialog.locator('.kv2-runtime-badge--claude')).toBeVisible();
    await expect(dialog.locator('.vis-alwaysload-label')).toBeVisible();
    await expect(dialog.locator('input[type="checkbox"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await chooseTarget(dialog, 'E2E Claude project');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.diff-preview')).toContainText('.mcp.json');
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toContainText('Copied successfully');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await chooseTarget(dialog, 'E2E Claude project');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Cancel' }).click();

    const projectPlacement = dialog.locator('.inv-placement-row', { hasText: 'claude-project/.mcp.json' });
    await projectPlacement.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    page.once('dialog', (confirm) => confirm.accept());
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toContainText('Removed');

    await dialog.getByRole('button', { name: /Freeze/ }).first().click();
    await expect(dialog.locator('.diff-preview')).toBeVisible();
    await dialog.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    const claudeConfigPath = resolve(process.cwd(), '.e2e-home', '.claude.json');
    await expect.poll(() => readFileSync(claudeConfigPath, 'utf8')).not.toContain('"shared"');

    await page.locator('.cap-viewnav-btn', { hasText: 'Cold Storage' }).click();
    const cold = page.locator('.cold-item', { hasText: 'shared' });
    await expect(cold).toBeVisible();
    const coldSelect = cold.locator('select');
    const coldOption = coldSelect.locator('option').filter({ hasText: 'Global (user)' });
    await coldSelect.selectOption(await coldOption.getAttribute('value') ?? '');
    await cold.getByRole('button', { name: 'Preview' }).click();
    await cold.locator('.diff-preview').getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => readFileSync(claudeConfigPath, 'utf8')).toContain('"shared"');
  });
});
