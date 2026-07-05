import { test, expect } from './fixtures/kanban';
import { apiGetCards } from './helpers/api';

function modelVisibilitySection(page: import('@playwright/test').Page) {
  return page
    .locator('.settings-model-filter')
    .filter({ has: page.locator('.settings-network-title', { hasText: 'Model Visibility' }) })
    .first();
}

async function expectAgentBadge(page: import('@playwright/test').Page, label: string, subtitle?: string) {
  const badge = page.locator('.kv2-dialog .kv2-meta-card--agent');
  await expect(badge).toBeVisible();
  await expect(badge.locator('.kv2-meta-value')).toContainText(label);
  if (subtitle) {
    await expect(badge.locator('.kv2-meta-subtitle')).toHaveText(subtitle);
  }
}

test.describe('Agent Type Display & Editing', () => {
  test('create modal keeps selected agent even after changing model and persists on created card', async ({ page, trackCard }) => {
    const title = `[E2E] Create Agent Persist ${Date.now()}`;

    await page.goto('/');
    await page.locator('.kv2-create-btn').click();
    const dialog = page.locator('.kv2-dialog--create');
    await expect(dialog).toBeVisible();

    await dialog.locator('#create-card-title-input').fill(title);
    await dialog.locator('#create-card-description-input').fill('Ensure agent persists across model change on create');

    await dialog.locator('.kv2-create-agent-chip', { hasText: 'Hephaestus' }).click();

    const modelSelect = dialog.locator('#create-card-model-select');
    const options = await modelSelect.locator('option').allTextContents();
    const optionValues = await modelSelect.locator('option').evaluateAll(nodes =>
      nodes.map(node => (node as HTMLOptionElement).value)
    );
    const selectableModel = optionValues.find(v => v !== '' && v !== 'github-copilot/claude-opus-4.6');
    expect(selectableModel, `Expected non-default model option. Options: ${options.join(', ')}`).toBeTruthy();
    await modelSelect.selectOption(selectableModel!);

    await dialog.getByRole('button', { name: 'CREATE', exact: true }).click();
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible({ timeout: 10_000 });

    const cards = await apiGetCards();
    const created = cards.find(c => c.title === title);
    expect(created).toBeDefined();
    trackCard(created!.id);
    expect(created!.agentType).toBe('hephaestus');

    await page.locator('.kv2-card', { hasText: title }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await expectAgentBadge(page, 'Hephaestus');
  });

  test('card modal shows agent type when set', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Agent Display', description: 'Test agent display' },
      'todo',
      { agentType: 'sisyphus' }
    );
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Agent Display' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await expectAgentBadge(page, 'Sisyphus');
  });

  test('card modal shows "no agent" when agentType is not set', async ({ page, seedCard }) => {
    await seedCard({ title: '[E2E] No Agent', description: 'Test no agent' });
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] No Agent' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // TODO cards with no agent should show "No agent selected"
    await expect(page.locator('.kv2-dialog').getByText('No agent selected')).toBeVisible();
  });

  test('TODO card agent type is clickable and opens agent selector', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Agent Edit', description: 'Test agent editing' },
      'todo',
      { agentType: 'sisyphus' }
    );
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Agent Edit' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Click the editable agent badge to open selector
    const agentBadge = page.locator('.kv2-meta-editable', { hasText: 'Sisyphus' });
    await expect(agentBadge).toBeVisible();
    await agentBadge.click();

    // Agent selector should appear with all agent buttons
    const selector = page.locator('.kv2-detail-agent-selector');
    await expect(selector).toBeVisible();
    await expect(selector.locator('.kv2-create-agent-chip', { hasText: 'Sisyphus' })).toBeVisible();
    await expect(selector.locator('.kv2-create-agent-chip', { hasText: 'Hephaestus' })).toBeVisible();
    await expect(selector.locator('.kv2-create-agent-chip', { hasText: 'Prometheus' })).toBeVisible();
    await expect(selector.locator('.kv2-create-agent-chip', { hasText: 'Atlas' })).toBeVisible();
  });

  test('TODO card agent type can be changed via selector', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Agent Change', description: 'Test agent change' },
      'todo',
      { agentType: 'sisyphus' }
    );
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Agent Change' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    // Click agent badge to open selector
    await page.locator('.kv2-meta-editable', { hasText: 'Sisyphus' }).click();
    const selector = page.locator('.kv2-detail-agent-selector');
    await expect(selector).toBeVisible();

    // Click Hephaestus to change agent
    await selector.locator('.kv2-create-agent-chip', { hasText: 'Hephaestus' }).click();

    // Selector should close and badge should update
    await expect(page.locator('.kv2-detail-agent-selector')).toHaveCount(0);
    await expectAgentBadge(page, 'Hephaestus');
  });

  test('non-TODO card agent type is NOT editable', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Agent Static', description: 'Test agent static' },
      'in_progress',
      { agentType: 'prometheus' }
    );
    await page.goto('/');

    await page.locator('.kv2-card', { hasText: '[E2E] Agent Static' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await expectAgentBadge(page, 'Prometheus', 'Plan Builder');

    // Should NOT have editable class
    const editableBadge = page.locator('.kv2-meta-editable', { hasText: 'Prometheus' });
    await expect(editableBadge).not.toBeVisible();
  });

  test('agent change persists after modal close and reopen', async ({ page, seedCardWithStatus }) => {
    await seedCardWithStatus(
      { title: '[E2E] Agent Persist', description: 'Test agent persist' },
      'todo',
      { agentType: 'sisyphus' }
    );
    await page.goto('/');

    // Open modal and change agent
    await page.locator('.kv2-card', { hasText: '[E2E] Agent Persist' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();

    await page.locator('.kv2-meta-editable', { hasText: 'Sisyphus' }).click();
    await page.locator('.kv2-detail-agent-selector .kv2-create-agent-chip', { hasText: 'Atlas' }).click();
    await expectAgentBadge(page, 'Atlas');

    // Close modal
    await page.keyboard.press('Escape');
    await expect(page.locator('.kv2-dialog-overlay')).not.toBeVisible();

    // Reopen modal — agent should still be Atlas
    await page.locator('.kv2-card', { hasText: '[E2E] Agent Persist' }).click();
    await expect(page.locator('.kv2-dialog')).toBeVisible();
    await expectAgentBadge(page, 'Atlas');
  });
});

test.describe('Settings - Model Visibility Filter', () => {
  test('Settings tab shows model visibility section', async ({ page }) => {
    await page.goto('/');

    // Navigate to Settings tab
    const settingsTab = page.locator('button.app-tab', { hasText: 'Settings' });
    await settingsTab.click();

    // Model Visibility section should be visible (if models are loaded)
    const section = modelVisibilitySection(page);
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section.locator('.settings-network-title', { hasText: 'Model Visibility' })).toBeVisible();
  });

  test('model checkboxes can be toggled', async ({ page }) => {
    await page.goto('/');

    // Navigate to Settings tab
    await page.locator('button.app-tab', { hasText: 'Settings' }).click();
    const section = modelVisibilitySection(page);
    await expect(section).toBeVisible({ timeout: 10_000 });

    // Get the first model checkbox
    const firstCheckbox = section.locator('.settings-model-checkbox').first();
    await expect(firstCheckbox).toBeVisible();

    const initialState = await firstCheckbox.isChecked();

    // Toggle it
    await firstCheckbox.click();
    const newState = await firstCheckbox.isChecked();
    expect(newState).toBe(!initialState);

    // Toggle it back
    await firstCheckbox.click();
    const restoredState = await firstCheckbox.isChecked();
    expect(restoredState).toBe(initialState);
  });

  test('Select All / Deselect All button works', async ({ page }) => {
    await page.goto('/');

    // Navigate to Settings tab
    await page.locator('button.app-tab', { hasText: 'Settings' }).click();
    const section = modelVisibilitySection(page);
    await expect(section).toBeVisible({ timeout: 10_000 });

    // Find the toggle all button (the header also has a "Sync models" button)
    const toggleBtn = section.getByRole('button', { name: /Select All|Deselect All/ });

    // If currently "Deselect All", click it to deselect all
    const btnText = await toggleBtn.textContent();
    if (btnText?.includes('Deselect All')) {
      await toggleBtn.click();
      // All checkboxes should be unchecked
      const checkboxes = section.locator('.settings-model-checkbox');
      const count = await checkboxes.count();
      for (let i = 0; i < count; i++) {
        await expect(checkboxes.nth(i)).not.toBeChecked();
      }
      // Button should now say "Select All"
      await expect(toggleBtn).toContainText('Select All');
    }

    // Click "Select All"
    await toggleBtn.click();
    // All checkboxes should be checked
    const checkboxes = section.locator('.settings-model-checkbox');
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toBeChecked();
    }
    await expect(toggleBtn).toContainText('Deselect All');
  });

  test('model filter persists in localStorage', async ({ page }) => {
    await page.goto('/');

    // Navigate to Settings tab
    await page.locator('button.app-tab', { hasText: 'Settings' }).click();
    const section = modelVisibilitySection(page);
    await expect(section).toBeVisible({ timeout: 10_000 });

    // Click "Deselect All" first to start clean, then "Select All"
    const toggleBtn = section.getByRole('button', { name: /Select All|Deselect All/ });
    const btnText = await toggleBtn.textContent();
    if (btnText?.includes('Deselect All')) {
      await toggleBtn.click();
    }
    // Now click "Select All"
    await toggleBtn.click();

    // Check localStorage has saved value
    const storedValue = await page.evaluate(() => localStorage.getItem('kanban-enabled-models'));
    expect(storedValue).not.toBeNull();
    const parsed = JSON.parse(storedValue!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    // Reload page and verify persistence
    await page.reload();
    await page.locator('button.app-tab', { hasText: 'Settings' }).click();
    const refreshedSection = modelVisibilitySection(page);
    await expect(refreshedSection).toBeVisible({ timeout: 10_000 });

    // Checkboxes should still be checked (persisted)
    const firstCheckbox = refreshedSection.locator('.settings-model-checkbox').first();
    await expect(firstCheckbox).toBeChecked();
  });
});
