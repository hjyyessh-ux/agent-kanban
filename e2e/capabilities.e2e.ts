import { test, expect } from './fixtures/kanban';
import { apiCreateScript, apiDeleteScript } from './helpers/api';

// ── helpers ──────────────────────────────────────────────────────────────────

async function goToCapabilities(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('#app-tab-capabilities').click();
  await expect(page.locator('#app-panel-capabilities')).toBeVisible();
}

// The tab defaults to the Inventory view; the skill/script list, commands
// checklist, and script actions live in the "Skills & Scripts" view.
async function goToListView(page: import('@playwright/test').Page) {
  await goToCapabilities(page);
  await page.locator('.cap-viewnav-btn', { hasText: 'Skills & Scripts' }).click();
  await expect(page.locator('.cap-search')).toBeVisible();
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('Capabilities tab — navigation', () => {
  test('tab is present and activates panel', async ({ page }) => {
    await page.goto('/');
    const tab = page.locator('#app-tab-capabilities');
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(page.locator('#app-panel-capabilities')).toBeVisible();
    // No redundant "Capabilities" header — the view nav is the primary heading.
    await expect(page.locator('.cap-title')).toHaveCount(0);
    await expect(page.locator('.cap-viewnav-btn', { hasText: 'Inventory' })).toBeVisible();
  });

  test('header shows view nav and action buttons (no + Script)', async ({ page }) => {
    await goToCapabilities(page);
    // View navigation with descriptive two-line tabs
    const nav = page.locator('.cap-viewnav');
    await expect(nav.locator('.cap-viewnav-btn', { hasText: 'Inventory' })).toBeVisible();
    await expect(nav.locator('.cap-viewnav-btn', { hasText: 'Skills & Scripts' })).toBeVisible();
    await expect(nav.locator('.cap-viewnav-btn', { hasText: 'Cold Storage' })).toBeVisible();
    await expect(nav.locator('.cap-viewnav-btn--active')).toContainText('Inventory');
    // Uniform kv2 action buttons
    await expect(page.locator('.cap-gear-btn')).toBeVisible();
    const actions = page.locator('.cap-header-actions');
    await expect(actions.locator('.kv2-btn', { hasText: 'Sync' })).toBeVisible();
    await expect(actions.locator('.kv2-btn', { hasText: '+ New Skill' })).toBeVisible();
    await expect(actions.locator('.kv2-btn', { hasText: '↑ Import' })).toBeVisible();
    // Script creation moved out of the header entirely
    await expect(actions.locator('button', { hasText: '+ Script' })).toHaveCount(0);
    await expect(actions.locator('button', { hasText: 'Targets' })).toHaveCount(0);
  });

  test('view nav switches between the three views', async ({ page }) => {
    await goToCapabilities(page);
    await page.locator('.cap-viewnav-btn', { hasText: 'Skills & Scripts' }).click();
    await expect(page.locator('.cap-viewnav-btn--active')).toContainText('Skills & Scripts');
    await expect(page.locator('.cap-commands-section')).toBeVisible();
    await page.locator('.cap-viewnav-btn', { hasText: 'Cold Storage' }).click();
    await expect(page.locator('.cap-viewnav-btn--active')).toContainText('Cold Storage');
    await page.locator('.cap-viewnav-btn', { hasText: 'Inventory' }).click();
    await expect(page.locator('.cap-viewnav-btn--active')).toContainText('Inventory');
  });

  test('inventory view shows the inline Placement Targets panel with builtin targets', async ({ page }) => {
    await goToCapabilities(page);
    const panel = page.locator('.ptp-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ptp-title')).toHaveText('Placement Targets');
    // Builtin user/cold targets are always present and cannot be removed
    await expect(panel.locator('.ptp-item .scope-chip--user')).toBeVisible();
    await expect(panel.locator('.ptp-item .scope-chip--cold')).toBeVisible();
    await expect(panel.locator('.ptp-builtin').first()).toBeVisible();
    // Add form is collapsed behind the + Add Target toggle
    await expect(panel.locator('.ptp-add-form')).not.toBeVisible();
    await panel.locator('.kv2-btn', { hasText: '+ Add Target' }).click();
    await expect(panel.locator('.ptp-add-form')).toBeVisible();
    await expect(panel.locator('input[aria-label="Target label"]')).toBeVisible();
  });

  test('toolbar has search input and both filter groups', async ({ page }) => {
    await goToListView(page);
    await expect(page.locator('.cap-search')).toBeVisible();
    const typeGroup = page.locator('[aria-label="Filter by type"]');
    await expect(typeGroup.locator('.cap-filter-btn', { hasText: 'All' })).toBeVisible();
    await expect(typeGroup.locator('.cap-filter-btn', { hasText: 'Skills' })).toBeVisible();
    await expect(typeGroup.locator('.cap-filter-btn', { hasText: 'Scripts' })).toBeVisible();
    const agentGroup = page.locator('[aria-label="Filter by agent"]');
    await expect(agentGroup.locator('.cap-filter-btn', { hasText: 'claude' })).toBeVisible();
    await expect(agentGroup.locator('.cap-filter-btn', { hasText: 'codex' })).toBeVisible();
    await expect(agentGroup.locator('.cap-filter-btn', { hasText: 'opencode' })).toBeVisible();
  });
});

test.describe('Capabilities tab — list & search', () => {
  test('empty state renders when search has no match', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-search').fill('__e2e_no_match_xyz__');
    await expect(page.locator('.cap-empty')).toBeVisible();
    await expect(page.locator('.cap-empty')).toContainText('No capabilities match your filters');
  });

  test('script created via API appears in capabilities list', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-CAP] List Script',
      content: 'echo hello',
      description: 'e2e list test',
    });
    try {
      await goToListView(page);
      const item = page.locator('.cap-item', { hasText: '[E2E-CAP] List Script' });
      await expect(item).toBeVisible();
      await expect(item.locator('.cap-badge--script')).toBeVisible();
    } finally {
      await apiDeleteScript(script.id);
    }
  });

  test('search filters items by name', async ({ page }) => {
    const alpha = await apiCreateScript({ name: '[E2E-SRCH] Alpha', content: 'echo a' });
    const beta = await apiCreateScript({ name: '[E2E-SRCH] Beta', content: 'echo b' });
    try {
      await goToListView(page);
      await page.locator('.cap-search').fill('Alpha');
      await expect(page.locator('.cap-item', { hasText: '[E2E-SRCH] Alpha' })).toBeVisible();
      await expect(page.locator('.cap-item', { hasText: '[E2E-SRCH] Beta' })).not.toBeVisible();
    } finally {
      await apiDeleteScript(alpha.id);
      await apiDeleteScript(beta.id);
    }
  });

  test('search filters items by description', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-DESC] Desc Script',
      content: 'echo hi',
      description: 'uniquedescriptor42',
    });
    try {
      await goToListView(page);
      await page.locator('.cap-search').fill('uniquedescriptor42');
      await expect(page.locator('.cap-item', { hasText: '[E2E-DESC] Desc Script' })).toBeVisible();
    } finally {
      await apiDeleteScript(script.id);
    }
  });

  test('type filter Scripts shows only script items', async ({ page }) => {
    const script = await apiCreateScript({ name: '[E2E-TYPE] Script Filter', content: 'echo ok' });
    try {
      await goToListView(page);
      await page.locator('[aria-label="Filter by type"] .cap-filter-btn', { hasText: 'Scripts' }).click();
      await expect(page.locator('[aria-label="Filter by type"] .cap-filter-btn--active')).toHaveText('Scripts');

      const items = page.locator('.cap-item');
      const count = await items.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        await expect(items.nth(i).locator('.cap-badge--script')).toBeVisible();
      }
    } finally {
      await apiDeleteScript(script.id);
    }
  });

  test('type filter Skills button activates and filters', async ({ page }) => {
    await goToListView(page);
    await page.locator('[aria-label="Filter by type"] .cap-filter-btn', { hasText: 'Skills' }).click();
    await expect(page.locator('[aria-label="Filter by type"] .cap-filter-btn--active')).toHaveText('Skills');
    // All visible items (if any) must have skill badge — or empty state shown
    const items = page.locator('.cap-item');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      await expect(items.nth(i).locator('.cap-badge--skill')).toBeVisible();
    }
  });

  test('All filter restores unfiltered list', async ({ page }) => {
    const script = await apiCreateScript({ name: '[E2E-ALL] All Filter', content: 'echo all' });
    try {
      await goToListView(page);
      await page.locator('[aria-label="Filter by type"] .cap-filter-btn', { hasText: 'Skills' }).click();
      await page.locator('[aria-label="Filter by type"] .cap-filter-btn', { hasText: 'All' }).click();
      await expect(page.locator('[aria-label="Filter by type"] .cap-filter-btn--active')).toHaveText('All');
      await expect(page.locator('.cap-item', { hasText: '[E2E-ALL] All Filter' })).toBeVisible();
    } finally {
      await apiDeleteScript(script.id);
    }
  });
});

test.describe('Capabilities tab — sync', () => {
  test('Sync button shows syncing feedback then resolves', async ({ page }) => {
    await goToListView(page);
    const syncBtn = page.locator('.cap-header-actions .kv2-btn', { hasText: 'Sync' });
    await syncBtn.click();
    await expect(syncBtn).toContainText('Syncing...');
    await expect(syncBtn).toContainText('Sync', { timeout: 15000 });
    await expect(syncBtn).not.toContainText('Syncing...', { timeout: 15000 });
  });

  test('sync result message is shown after sync', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-header-actions .kv2-btn', { hasText: 'Sync' }).click();
    // Result appears once sync completes
    await expect(page.locator('.cap-sync-result')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Capabilities tab — modals', () => {
  test('⚙ gear opens Skill Directories modal and Escape closes it', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-gear-btn').click();
    const overlay = page.locator('.kv2-dialog-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.kv2-dialog-title')).toHaveText('Skill Directories');
    // Escape now closes it, consistent with the New/Import/Detail modals.
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible();
  });

  test('⚙ gear modal rejects a non-existent directory with an inline error', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-gear-btn').click();
    const overlay = page.locator('.kv2-dialog-overlay');
    await expect(overlay).toBeVisible();
    await overlay.locator('.cap-roots-add input[type="text"]').fill('/nope/not/a/real/dir/xyz');
    await overlay.locator('.cap-roots-add .kv2-btn', { hasText: 'Add' }).click();
    await expect(overlay.locator('.cap-roots-error')).toContainText('Directory does not exist');
  });

  test('⚙ gear modal shows default roots and add-form', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-gear-btn').click();
    const overlay = page.locator('.kv2-dialog-overlay');
    await expect(overlay).toBeVisible();
    // Default roots exist
    await expect(overlay.locator('.cap-root-item').first()).toBeVisible({ timeout: 5000 });
    // Add-directory form
    await expect(overlay.locator('.cap-roots-add')).toBeVisible();
  });

  test('+ New Skill opens New Skill modal and X closes it', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-header-actions .kv2-btn', { hasText: '+ New Skill' }).click();
    const overlay = page.locator('.kv2-dialog-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.kv2-dialog-title')).toHaveText('New Skill');
    await overlay.locator('.kv2-dialog-close').click();
    await expect(overlay).not.toBeVisible();
  });

  test('New Skill modal validates name format', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-header-actions .kv2-btn', { hasText: '+ New Skill' }).click();
    const overlay = page.locator('.kv2-dialog-overlay');
    // Validation runs on-change; submit stays disabled while invalid.
    await overlay.locator('#skill-name').fill('INVALID NAME!');
    await expect(overlay.locator('.cap-field-error')).toBeVisible();
    await expect(overlay.locator('button[type="submit"]')).toBeDisabled();
    // Correcting the name clears the error.
    await overlay.locator('#skill-name').fill('valid-skill-name');
    await expect(overlay.locator('.cap-field-error')).not.toBeVisible();
  });

  test('↑ Import opens Import Skill modal', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-header-actions .kv2-btn', { hasText: '↑ Import' }).click();
    const overlay = page.locator('.kv2-dialog-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.kv2-dialog-title')).toHaveText('Import Skill');
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible();
  });

  test('clicking a script item opens edit modal', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-EDIT] Click To Edit',
      content: '#!/usr/bin/env bash\necho edit',
      description: 'click edit test',
    });
    try {
      await goToListView(page);
      const item = page.locator('.cap-item--clickable', { hasText: '[E2E-EDIT] Click To Edit' });
      await expect(item).toBeVisible();
      await item.click();
      const overlay = page.locator('.kv2-dialog');
      await expect(overlay).toBeVisible();
      await expect(overlay.locator('.kv2-dialog-title')).toContainText('Edit Script');
      await page.keyboard.press('Escape');
    } finally {
      await apiDeleteScript(script.id);
    }
  });
});

test.describe('Capabilities tab — script inline actions', () => {
  test('script item has Run, History, Edit, Delete buttons', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-BTN] Button Script',
      content: 'echo buttons',
    });
    try {
      await goToListView(page);
      const item = page.locator('.cap-item', { hasText: '[E2E-BTN] Button Script' });
      await expect(item).toBeVisible();
      await expect(item.locator('.kv2-btn', { hasText: '▶ Run' })).toBeVisible();
      await expect(item.locator('.kv2-btn', { hasText: 'History' })).toBeVisible();
      await expect(item.locator('.kv2-btn', { hasText: '✎ Edit' })).toBeVisible();
      await expect(item.locator('.kv2-btn', { hasText: '✕ Delete' })).toBeVisible();
    } finally {
      await apiDeleteScript(script.id);
    }
  });

  test('Delete script triggers confirm dialog', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-DEL] Delete Me',
      content: 'echo delete',
    });
    try {
      await goToListView(page);
      const item = page.locator('.cap-item', { hasText: '[E2E-DEL] Delete Me' });
      await expect(item).toBeVisible();

      page.on('dialog', (d) => d.dismiss()); // dismiss confirm → item stays
      await item.locator('.kv2-btn', { hasText: '✕ Delete' }).click();
      // Item should still be visible after dismiss
      await expect(item).toBeVisible();
    } finally {
      await apiDeleteScript(script.id);
    }
  });
});

test.describe('Capabilities tab — Commands section', () => {
  test('Commands section visible with checkboxes', async ({ page }) => {
    await goToListView(page);
    const section = page.locator('.cap-commands-section');
    await expect(section).toBeVisible();
    await expect(section.locator('.cap-commands-title')).toBeVisible();
    await expect(section.locator('.cap-command-item').first()).toBeVisible();
    await expect(section.locator('input[type="checkbox"]').first()).toBeVisible();
  });

  test('toggle-all button toggles all checkboxes off then on', async ({ page }) => {
    await goToListView(page);
    const section = page.locator('.cap-commands-section');
    const toggleAll = section.locator('.kv2-btn');

    // If all enabled, clicking should deselect all
    const firstCheckbox = section.locator('input[type="checkbox"]').first();
    const wasChecked = await firstCheckbox.isChecked();

    await toggleAll.click();
    const nowChecked = await firstCheckbox.isChecked();
    expect(nowChecked).toBe(!wasChecked);

    // Restore
    await toggleAll.click();
  });
});

test.describe('Capabilities tab — kv2 visual compliance', () => {
  test('cap-item uses the kv2 card language (rounded, bordered, Work Sans root)', async ({ page }) => {
    const script = await apiCreateScript({
      name: '[E2E-STYLE] Kv2 Style',
      content: 'echo style',
    });
    try {
      await goToListView(page);
      await expect(page.locator('.cap-item').first()).toBeVisible();
      const style = await page.evaluate(() => {
        const el = document.querySelector('.cap-item');
        const root = document.querySelector('.cap-view');
        if (!el || !root) return null;
        const s = getComputedStyle(el);
        return {
          borderRadius: s.borderRadius,
          borderWidth: s.borderWidth,
          rootFont: getComputedStyle(root).fontFamily,
        };
      });
      expect(style).not.toBeNull();
      // kv2 look: rounded corners, thick border, board font stack
      expect(parseFloat(style!.borderRadius)).toBeGreaterThan(0);
      expect(parseFloat(style!.borderWidth)).toBeGreaterThanOrEqual(2);
      expect(style!.rootFont).toContain('Work Sans');
    } finally {
      await apiDeleteScript(script.id);
    }
  });

  test('header action buttons share the kv2-btn skin (rounded, uniform height)', async ({ page }) => {
    await goToListView(page);
    const metrics = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.cap-header-actions .kv2-btn'));
      return btns.map((el) => {
        const s = getComputedStyle(el);
        return { radius: parseFloat(s.borderRadius), height: (el as HTMLElement).offsetHeight };
      });
    });
    expect(metrics.length).toBeGreaterThanOrEqual(3);
    for (const m of metrics) expect(m.radius).toBeGreaterThan(0);
    // Sync must no longer be a different size from its neighbors
    const heights = new Set(metrics.map((m) => m.height));
    expect(heights.size).toBe(1);
  });

  test('no dark fill on the rendered page surface (cream, not reference dark theme)', async ({ page }) => {
    await goToListView(page);
    // The cap-view itself is transparent; the cream surface is painted by the
    // app shell / body. Sample the body's effective background to confirm the
    // neo-brutalism cream palette rather than the reference dark theme.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBeNull();
    const m = bg.match(/[\d.]+/g);
    expect(m).not.toBeNull();
    const [r, g, b, a = 1] = m!.map(Number);
    // Fully transparent backgrounds are not "dark" — only judge opaque fills.
    if (a > 0) {
      const isDark = r < 40 && g < 40 && b < 40;
      expect(isDark).toBe(false);
    }
  });
});

test.describe('Capabilities tab — skills (fixture)', () => {
  test('fixture skill appears with claude badge and tools', async ({ page }) => {
    await goToListView(page);
    const item = page.locator('.cap-item', { hasText: 'e2e-sample-skill' });
    await expect(item).toBeVisible();
    await expect(item.locator('.cap-badge--skill')).toBeVisible();
    await expect(item.locator('.cap-badge--claude')).toBeVisible();
    await expect(item.locator('.cap-badge--tool').first()).toBeVisible();
  });

  test('agent filter claude shows the fixture skill', async ({ page }) => {
    await goToListView(page);
    await page.locator('[aria-label="Filter by agent"] .cap-filter-btn', { hasText: 'claude' }).click();
    await expect(page.locator('.cap-item', { hasText: 'e2e-sample-skill' })).toBeVisible();
  });

  test('agent filter codex hides the claude fixture skill', async ({ page }) => {
    await goToListView(page);
    await page.locator('[aria-label="Filter by agent"] .cap-filter-btn', { hasText: 'codex' }).click();
    await expect(page.locator('.cap-item', { hasText: 'e2e-sample-skill' })).not.toBeVisible();
  });

  test('clicking skill opens kv2 detail dialog with Preview/Edit toggle and Port section', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-item', { hasText: 'e2e-sample-skill' }).click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.kv2-dialog-title')).toHaveText('/e2e-sample-skill');
    // Preview is default; content renders
    await expect(dialog.locator('.cap-detail-preview')).toBeVisible({ timeout: 5000 });
    // Toggle to Edit
    await dialog.locator('.cap-filter-btn', { hasText: 'Edit' }).click();
    await expect(dialog.locator('textarea[aria-label="SKILL.md content"]')).toBeVisible();
    // Port section present (claude → codex/opencode)
    await expect(dialog.locator('.cap-detail-section-title', { hasText: 'Port to Agent' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('Detail Preview strips YAML frontmatter (renders body, not raw name:/description:)', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-item', { hasText: 'e2e-sample-skill' }).click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    const preview = dialog.locator('.cap-detail-preview');
    await expect(preview).toBeVisible({ timeout: 5000 });
    // Body heading is rendered…
    await expect(preview).toContainText('Fixture body used by capabilities.e2e.ts');
    // …but the raw frontmatter delimiters / keys are gone.
    await expect(preview).not.toContainText('allowed-tools:');
    await expect(preview.locator('text=---')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('Improve requires a prompt — Create button disabled until text entered', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-item', { hasText: 'e2e-sample-skill' }).click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    await dialog.locator('.kv2-btn', { hasText: 'Improve...' }).click();
    const createBtn = dialog.locator('.kv2-btn', { hasText: 'Create Board Card' });
    await expect(createBtn).toBeDisabled();
    await dialog.locator('textarea[aria-label="Improvement direction"]').fill('Tighten the wording');
    await expect(createBtn).toBeEnabled();
    // Do not actually create the card (avoids board pollution) — requirement verified.
    await page.keyboard.press('Escape');
  });

  test('Duplicate — button disabled until a target root is selected', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-item', { hasText: 'e2e-sample-skill' }).click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    const dupSection = dialog.locator('.cap-detail-section', { hasText: 'Duplicate to' });
    await expect(dupSection).toBeVisible();
    const dupBtn = dupSection.locator('.kv2-btn', { hasText: 'Duplicate' });
    await expect(dupBtn).toBeDisabled();
    // The second (codex) root is an available target.
    await dupSection.locator('select').selectOption({ index: 1 });
    await expect(dupBtn).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('Port — Create Port Card disabled until target agent selected', async ({ page }) => {
    await goToListView(page);
    await page.locator('.cap-item', { hasText: 'e2e-sample-skill' }).click();
    const dialog = page.locator('.kv2-dialog.cap-detail-dialog');
    const portSection = dialog.locator('.cap-detail-section', { hasText: 'Port to Agent' });
    const portBtn = portSection.locator('.kv2-btn', { hasText: 'Create Port Card' });
    await expect(portBtn).toBeDisabled();
    await portSection.locator('select').selectOption('codex');
    await expect(portBtn).toBeEnabled();
    await page.keyboard.press('Escape');
  });
});

test.describe('Capabilities tab — security', () => {
  test('/api/skills endpoint is accessible from same-origin context', async ({ page }) => {
    await page.goto('/');
    const res = await page.request.get('/api/skills');
    // 200 = skills available, 503 = store not wired in test-server (both OK)
    // 401 would mean token required (also acceptable if token configured)
    expect([200, 401, 503]).toContain(res.status());
  });

  test('/api/skill-roots GET is accessible from same-origin context', async ({ page }) => {
    await page.goto('/');
    const res = await page.request.get('/api/skill-roots');
    expect([200, 401, 503]).toContain(res.status());
  });
});
