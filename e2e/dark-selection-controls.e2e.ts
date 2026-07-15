import { test, expect } from './fixtures/kanban';

function luminance([r, g, b]: number[]) {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: number[], background: number[]) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test.describe('Graphite dark selection controls', () => {
  test('model and directory menus stay legible and board metadata clears actions', async ({ page, seedCardWithStatus }) => {
    await page.addInitScript(() => {
      localStorage.setItem('kanban-theme', 'dark');
      localStorage.setItem('kanban-dir-history', JSON.stringify([
        '/Users/test/agent-kanban',
        '/Users/test/another-project',
      ]));
    });

    await seedCardWithStatus(
      { title: '[E2E] Dark selection controls', description: 'Audit selection surfaces and footer spacing.' },
      'todo',
      {
        agentRuntime: 'opencode',
        agentType: 'sisyphus',
        model: 'github-copilot/claude-opus-4.6',
        projectDir: '/Users/test/agent-kanban',
      },
    );

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const boardCard = page.locator('.kv2-card', { hasText: '[E2E] Dark selection controls' });
    const metadata = await boardCard.evaluate((card) => {
      const project = card.querySelector('.kv2-card-directory');
      const timestamp = card.querySelector('.kv2-card-timestamp');
      const timestamps = card.querySelector('.kv2-card-footer-meta');
      const actions = card.querySelector('.kv2-card-actions-wrapper');
      if (!project || !timestamp || !timestamps || !actions) throw new Error('Missing card footer elements');
      const projectBox = project.getBoundingClientRect();
      const timestampBox = timestamp.getBoundingClientRect();
      const timestampsBox = timestamps.getBoundingClientRect();
      const actionBox = actions.getBoundingClientRect();
      return {
        projectToTimestamps: timestampBox.top - projectBox.bottom,
        timestampsToActions: actionBox.top - timestampsBox.bottom,
      };
    });
    expect(metadata.projectToTimestamps).toBeGreaterThanOrEqual(8);
    expect(metadata.timestampsToActions).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: 'e2e/results/dark-board-footer-spacing.png', fullPage: true });

    await boardCard.click();
    const dialog = page.locator('.kv2-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Model' }).click();
    const modelMenu = page.getByRole('listbox', { name: 'Model' });
    await expect(modelMenu).toBeVisible();
    const selectedModel = modelMenu.getByRole('option', { selected: true });
    const modelColors = await selectedModel.evaluate((option) => {
      const style = getComputedStyle(option);
      const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return { foreground: parse(style.color), background: parse(style.backgroundColor) };
    });
    expect(contrast(modelColors.foreground, modelColors.background)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: 'e2e/results/dark-model-picker.png', fullPage: true });
    await modelMenu.getByRole('option', { name: /GPT-5.4/ }).click();
    await expect(dialog.getByRole('button', { name: 'Model' })).toContainText('GPT-5.4');

    await dialog.locator('.kv2-meta-card--directory.kv2-meta-editable').click();
    const directoryMenu = dialog.locator('.kv2-directory-popover');
    await expect(directoryMenu).toBeVisible();
    const selectedDirectory = directoryMenu.locator('.kv2-directory-option.is-selected');
    const directoryColors = await selectedDirectory.evaluate((option) => {
      const style = getComputedStyle(option);
      const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return { foreground: parse(style.color), background: parse(style.backgroundColor) };
    });
    expect(contrast(directoryColors.foreground, directoryColors.background)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: 'e2e/results/dark-directory-picker.png', fullPage: true });
    await dialog.locator('.kv2-directory-input').fill('');
    await directoryMenu.getByRole('button', { name: /another-project/ }).click();
    await expect(dialog.locator('.kv2-meta-card--directory .kv2-meta-value--mono')).toContainText('/Users/test/another-project');

    await page.screenshot({ path: 'e2e/results/dark-selection-controls.png', fullPage: true });
  });

  test('Codex detail keeps GPT-5.6 visible and exposes full-width runtime and command triggers', async ({ page, seedCardWithStatus }) => {
    await page.addInitScript(() => {
      localStorage.setItem('kanban-theme', 'dark');
      localStorage.setItem('kanban-enabled-models', JSON.stringify(['gpt-5.4']));
      localStorage.setItem('kanban-enabled-models-migrated-v2', '1');
    });

    await seedCardWithStatus(
      { title: '[E2E] Codex detail controls', description: 'Audit model persistence and picker hit areas.' },
      'todo',
      {
        agentRuntime: 'codex',
        model: 'gpt-5.6-sol',
        projectDir: '/Users/test/agent-kanban',
      },
    );

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.locator('.kv2-card', { hasText: '[E2E] Codex detail controls' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Model' })).toContainText('GPT-5.6-Sol');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('kanban-enabled-models'))).toContain('gpt-5.6-sol');

    const runtimeTrigger = dialog.locator('.kv2-runtime-trigger');
    const runtimeCard = dialog.locator('.kv2-meta-card--runtime');
    const hitArea = await Promise.all([runtimeTrigger.boundingBox(), runtimeCard.boundingBox()]);
    expect(hitArea[0]?.height ?? 0).toBeGreaterThanOrEqual(30);
    expect(hitArea[0]?.width ?? 0).toBeGreaterThanOrEqual((hitArea[1]?.width ?? 34) - 34);

    await runtimeTrigger.click();
    await expect(page.getByRole('listbox', { name: 'Runtime' })).toBeVisible();
    await runtimeTrigger.click();
    await expect(page.getByRole('listbox', { name: 'Runtime' })).not.toBeVisible();

    await dialog.getByRole('button', { name: /Command/ }).first().click();
    const commandMenu = dialog.getByRole('listbox', { name: /Codex command/ });
    await expect(commandMenu).toBeVisible();
    const firstCommand = commandMenu.getByRole('option').first();
    const hierarchy = await firstCommand.evaluate((option) => {
      const relativeLuminance = (rgb: number[]) => {
        const [red, green, blue] = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const parse = (selector: string) => {
        const node = option.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        return (getComputedStyle(node).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      };
      return {
        title: relativeLuminance(parse('.kv2-command-option-name')),
        description: relativeLuminance(parse('.kv2-command-option-desc')),
        params: relativeLuminance(parse('.kv2-command-option-params')),
      };
    });
    expect(hierarchy.title).toBeGreaterThan(hierarchy.description);
    expect(hierarchy.description).toBeGreaterThan(hierarchy.params);

    await firstCommand.click();
    const commandTrigger = dialog.locator('.kv2-command-trigger');
    await commandTrigger.click({ position: { x: 4, y: 4 } });
    await expect(commandMenu).toBeVisible();

    await page.screenshot({ path: 'e2e/results/dark-codex-detail-controls.png', fullPage: true });
  });
});
