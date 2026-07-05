import { test, expect } from './fixtures/kanban';
import { apiCreateCard, apiGetCards, apiUpdateCard, apiUploadScreenshot, type Card } from './helpers/api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_IMAGE = path.join(__dirname, 'fixtures', 'test-screenshot.png');
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:24681';
const E2E_DATA_DIR = path.resolve(process.cwd(), '.e2e-data');

async function startCard(page: import('@playwright/test').Page, title: string) {
  const todoColumn = page.locator('.kv2-column[data-status="todo"]');
  const cardEl = todoColumn.locator('.kv2-card').filter({
    has: page.locator('.kv2-card-title', { hasText: title }),
  });
  await expect(cardEl).toBeVisible();
  await cardEl.getByText('Start').click();
}

async function expectCardInColumn(page: import('@playwright/test').Page, status: string, title: string) {
  const column = page.locator(`.kv2-column[data-status="${status}"]`);
  await expect(column.locator('.kv2-card-title', { hasText: title })).toBeVisible();
}

async function openCard(page: import('@playwright/test').Page, title: string) {
  const card = page.locator('.kv2-card').filter({
    has: page.locator('.kv2-card-title', { hasText: title }),
  });
  await expect(card).toBeVisible();
  await card.locator('.kv2-card-click-layer').click();
}

async function expectDescriptionCount(description: string, count: number) {
  await expect.poll(async () => {
    const cards = await apiGetCards();
    return cards.filter(card => card.description === description).length;
  }).toBe(count);
}

async function createAndStartRuntimeCard(
  page: import('@playwright/test').Page,
  runtime: 'codex' | 'claude',
  title: string,
  description: string,
) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create new card' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#create-card-title-input').fill(title);
  await dialog.locator('#create-card-description-input').fill(description);
  await dialog.getByRole('button', { name: runtime === 'codex' ? 'Codex' : 'Claude', exact: true }).click();
  await dialog.getByRole('button', { name: 'CREATE & START', exact: true }).click();
  await expectCardInColumn(page, 'complete', title);

  const cards = await apiGetCards();
  const card = cards.find(candidate => candidate.title === title && candidate.description === description);
  expect(card).toBeDefined();
  return card!;
}

async function runOrganicHook(
  runtime: 'codex' | 'claude',
  hook: 'prompt' | 'stop',
  input: Record<string, string>,
) {
  const script = path.resolve(
    process.cwd(),
    runtime === 'codex' ? '.codex/hooks' : '.claude/hooks',
    hook === 'prompt' ? 'on-prompt.sh' : 'on-stop.sh',
  );

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('bash', [script], {
      env: {
        ...process.env,
        HOME: E2E_DATA_DIR,
        KANBAN_API_URL: BASE_URL,
        KANBAN_DATA_DIR: E2E_DATA_DIR,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${runtime} ${hook} hook failed with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test.describe('Runtime integration', () => {
  test('New Task exposes Opencode, Codex, and Claude panels without overflow', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create new card' }).click();
    const dialog = page.getByRole('dialog');

    await expect(dialog.getByText('Runtime', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Opencode', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Claude', exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Opencode', exact: true }).click();
    await expect(dialog.getByText('Agent', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Sisyphus/ })).toBeVisible();

    await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(dialog.getByLabel('Codex reasoning effort')).toBeVisible();
    await expect(dialog.getByLabel('Codex sandbox')).toBeVisible();
    await expect(dialog.getByText('Skip git repo check')).toBeVisible();

    await dialog.getByLabel('Model').selectOption('gpt-5.4-mini');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('kanban-runtime-model-preference'))).toContain('gpt-5.4-mini');
    await expect.poll(async () => {
      const res = await request.get('/api/settings');
      const entries = await res.json();
      return entries.find((entry: { key: string; value: string }) => entry.key === 'agent.defaults.codex')?.value;
    }).toBe('gpt-5.4-mini');

    await dialog.getByRole('button', { name: 'Claude', exact: true }).click();
    await expect(dialog.getByText('Claude Permissions')).toBeVisible();
    await expect(dialog.getByText('Dangerously skip permissions')).toBeVisible();

    const overflowing = await page.locator('.kv2-dialog--create *').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && el.scrollWidth - el.clientWidth > 2;
        })
        .map((node) => (node as HTMLElement).className.toString())
    );
    expect(overflowing.filter(Boolean)).toHaveLength(0);
  });

  test('server runtime defaults restore New Task controls when local preference is empty', async ({ page, request }) => {
    await request.put(`/api/settings/by-key/${encodeURIComponent('agent.defaults.runtime')}`, {
      data: { value: 'claude', description: 'Default for runtime', category: 'agent.defaults', masked: false },
    });
    await request.put(`/api/settings/by-key/${encodeURIComponent('agent.defaults.claude')}`, {
      data: { value: 'claude-sonnet-4-6', description: 'Default for claude', category: 'agent.defaults', masked: false },
    });
    await request.put(`/api/settings/by-key/${encodeURIComponent('agent.claude.permission_mode')}`, {
      data: { value: 'plan', description: 'agent.claude.permission_mode', category: 'agent.claude', masked: false },
    });

    await page.addInitScript(() => {
      localStorage.removeItem('kanban-runtime-model-preference');
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create new card' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Claude', exact: true })).toHaveClass(/kv2-create-agent-chip--active/);
    await expect(dialog.getByLabel('Model')).toHaveValue('claude-sonnet-4-6');
    await expect(dialog.locator('.kv2-create-field', { hasText: 'Claude Permissions' }).locator('select')).toHaveValue('plan');
  });

  test('New Task create and start keeps one Codex and Claude card per prompt', async ({ page, trackCard }) => {
    const cases = [
      {
        runtime: 'codex' as const,
        title: `[E2E] New Task Codex Marker ${Date.now()}`,
        description: 'New Task Codex marker prompt should create exactly one card',
      },
      {
        runtime: 'claude' as const,
        title: `[E2E] New Task Claude Marker ${Date.now()}`,
        description: 'New Task Claude marker prompt should create exactly one card',
      },
    ];

    for (const item of cases) {
      const card = await createAndStartRuntimeCard(page, item.runtime, item.title, item.description);
      trackCard(card.id);
      await expectDescriptionCount(item.description, 1);
      expect(card.result ?? '').toContain(`Fake ${item.runtime} result`);
    }
  });

  test('Codex fake dispatch handles complete, failure rerun, and feedback resume', async ({ page, trackCard }) => {
    const codex = await apiCreateCard({
      title: '[E2E] Codex Complete',
      description: 'Codex should complete',
      agentRuntime: 'codex',
      model: 'gpt-5.3-codex',
      codexOptions: { reasoningEffort: 'high', sandbox: 'workspace-write', skipGitRepoCheck: true },
    });
    trackCard(codex.id);

    const fail = await apiCreateCard({
      title: '[E2E] Codex Fail Once',
      description: '[fail-once] Codex should fail and rerun',
      agentRuntime: 'codex',
      model: 'gpt-5.4-mini',
    });
    trackCard(fail.id);

    await page.goto('/');
    await startCard(page, codex.title);
    await expectCardInColumn(page, 'complete', codex.title);
    await expectDescriptionCount(codex.description, 1);

    await openCard(page, codex.title);
    const codexDialog = page.getByRole('dialog');
    await expect(codexDialog.getByText('Runtime', { exact: true })).toBeVisible();
    await expect(codexDialog.locator('.kv2-meta-card--runtime-codex')).toContainText('CODEX');
    await expect(codexDialog.getByText('Fake codex result')).toBeVisible();
    await codexDialog.getByPlaceholder('Describe what needs additional work...').fill('Add one Codex follow-up');
    await codexDialog.getByRole('button', { name: 'CREATE & START' }).click();
    await expectCardInColumn(page, 'complete', `Feedback: ${codex.title}`);

    await startCard(page, fail.title);
    await expect.poll(async () => {
      const cards = await apiGetCards();
      return cards.find(card => card.id === fail.id)?.progressSummary ?? '';
    }).toContain('[failed] fake codex failure');
    await page.reload();
    await expectCardInColumn(page, 'todo', fail.title);
    await openCard(page, fail.title);
    const failDialog = page.getByRole('dialog');
    await expect(failDialog.getByText('[failed] fake codex failure', { exact: false })).toBeVisible();
    await failDialog.getByRole('button', { name: 'START TASK' }).click();
    await expectCardInColumn(page, 'complete', fail.title);
  });

  test('Claude fake dispatch handles complete, failure rerun, and feedback resume', async ({ page, trackCard }) => {
    const claude = await apiCreateCard({
      title: '[E2E] Claude Complete',
      description: 'Claude should complete',
      agentRuntime: 'claude',
      model: 'claude-sonnet-4-6',
    });
    trackCard(claude.id);

    const fail = await apiCreateCard({
      title: '[E2E] Claude Fail Once',
      description: '[fail-once] Claude should fail and rerun',
      agentRuntime: 'claude',
      model: 'claude-sonnet-4-6',
    });
    trackCard(fail.id);

    await page.goto('/');
    await startCard(page, claude.title);
    await expectCardInColumn(page, 'complete', claude.title);
    await expectDescriptionCount(claude.description, 1);

    await openCard(page, claude.title);
    const claudeDialog = page.getByRole('dialog');
    await expect(claudeDialog.getByText('Runtime', { exact: true })).toBeVisible();
    await expect(claudeDialog.locator('.kv2-meta-card--runtime-claude')).toContainText('CLAUDE');
    await expect(claudeDialog.getByText('Fake claude result')).toBeVisible();
    await claudeDialog.getByPlaceholder('Describe what needs additional work...').fill('Add one Claude follow-up');
    await claudeDialog.getByRole('button', { name: 'CREATE & START' }).click();
    await expectCardInColumn(page, 'complete', `Feedback: ${claude.title}`);

    await startCard(page, fail.title);
    await expect.poll(async () => {
      const cards = await apiGetCards();
      return cards.find(card => card.id === fail.id)?.progressSummary ?? '';
    }).toContain('[failed] fake claude failure');
    await page.reload();
    await expectCardInColumn(page, 'todo', fail.title);
    await openCard(page, fail.title);
    const failDialog = page.getByRole('dialog');
    await expect(failDialog.getByText('[failed] fake claude failure', { exact: false })).toBeVisible();
    await failDialog.getByRole('button', { name: 'START TASK' }).click();
    await expectCardInColumn(page, 'complete', fail.title);
  });

  test('dispatch includes screenshot context for Opencode, Codex, and Claude', async ({ page, trackCard }) => {
    const cases = [
      {
        title: '[E2E] Opencode Screenshot Context',
        agentRuntime: 'opencode',
        agentType: 'sisyphus',
        model: 'github-copilot/gpt-5.4',
      },
      {
        title: '[E2E] Codex Screenshot Context',
        agentRuntime: 'codex',
        model: 'gpt-5.3-codex',
      },
      {
        title: '[E2E] Claude Screenshot Context',
        agentRuntime: 'claude',
        model: 'claude-sonnet-4-6',
      },
    ];

    const created: Card[] = [];
    for (const item of cases) {
      const card = await apiCreateCard({
        ...item,
        description: `${item.title} should receive screenshot metadata`,
      });
      trackCard(card.id);
      await apiUploadScreenshot(card.id, TEST_IMAGE);
      created.push(card);
    }

    await page.goto('/');
    for (const card of created) {
      await startCard(page, card.title);
      await expectCardInColumn(page, 'complete', card.title);
      await expectDescriptionCount(card.description, 1);
    }

    await expect.poll(async () => {
      const cards = await apiGetCards();
      return created.every((card) => cards.find((candidate) => candidate.id === card.id)?.result?.includes('with screenshot context'));
    }).toBe(true);
  });

  test('organic terminal Codex and Claude hook sessions still create and complete cards', async ({ trackCard }) => {
    const cases = [
      {
        runtime: 'codex' as const,
        sessionId: `codex-organic-${Date.now()}`,
        description: 'Organic Codex terminal prompt should create a card',
        result: 'Organic Codex final result',
      },
      {
        runtime: 'claude' as const,
        sessionId: `claude-organic-${Date.now()}`,
        description: 'Organic Claude terminal prompt should create a card',
        result: 'Organic Claude final result',
      },
    ];

    for (const item of cases) {
      await runOrganicHook(item.runtime, 'prompt', {
        session_id: item.sessionId,
        cwd: process.cwd(),
        prompt: item.description,
      });
      await runOrganicHook(item.runtime, 'stop', {
        session_id: item.sessionId,
        last_assistant_message: item.result,
      });

      const cards = await apiGetCards();
      const created = cards.filter(card => card.description === item.description);
      expect(created).toHaveLength(1);
      trackCard(created[0].id);
      expect(created[0].status).toBe('complete');
      expect(created[0].result).toBe(item.result);
    }
  });

  test('Opencode complete and queue auto-dispatch flow stay intact', async ({ page, trackCard }) => {
    const first = await apiCreateCard({
      title: '[E2E] Opencode Queue First',
      description: 'First opencode card',
      agentRuntime: 'opencode',
      agentType: 'sisyphus',
      model: 'github-copilot/gpt-5.4',
    });
    trackCard(first.id);
    const queued = await apiCreateCard({
      title: '[E2E] Opencode Queue Next',
      description: 'Queued opencode card',
      agentRuntime: 'opencode',
      agentType: 'hephaestus',
      model: 'github-copilot/gpt-5.4',
    });
    trackCard(queued.id);
    await apiUpdateCard(queued.id, {
      queuedAfterCardId: first.id,
      queuePosition: 1,
      queueSessionMode: 'continue_queued_after_session',
    });

    await page.goto('/');
    await startCard(page, first.title);
    await expectCardInColumn(page, 'complete', first.title);
    await expectCardInColumn(page, 'complete', queued.title);

    const cards = await apiGetCards();
    const firstUpdated = cards.find(card => card.id === first.id);
    const queuedUpdated = cards.find(card => card.id === queued.id);
    expect(queuedUpdated?.sessionId).toBe(firstUpdated?.sessionId);
  });

  test('session picker and Telegram origin badge show runtime without overlap on mobile', async ({ page, trackCard }) => {
    const opencode = await apiCreateCard({
      title: '[E2E] Session Opencode',
      description: 'Session Opencode',
      agentRuntime: 'opencode',
      sessionId: 'opencode-session-picker',
    });
    const codex = await apiCreateCard({
      title: '[E2E] Telegram Codex',
      description: 'Telegram Codex',
      agentRuntime: 'codex',
      sessionId: 'codex-session-picker',
      originChannel: 'telegram',
      telegramChatId: 100,
      telegramMessageId: '200',
      telegramReplyStatus: 'sent',
    });
    const claude = await apiCreateCard({
      title: '[E2E] Session Claude',
      description: 'Session Claude',
      agentRuntime: 'claude',
      sessionId: 'claude-session-picker',
    });
    trackCard(opencode.id);
    trackCard(codex.id);
    trackCard(claude.id);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expectCardInColumn(page, 'todo', codex.title);

    const codexCard = page.locator('.kv2-card', { hasText: codex.title });
    await expect(codexCard.locator('.kv2-runtime-badge--codex')).toBeVisible();
    await expect(codexCard.locator('.kv2-telegram-badge')).toBeVisible();

    const overlap = await codexCard.evaluate((card) => {
      const runtime = card.querySelector('.kv2-runtime-badge')?.getBoundingClientRect();
      const telegram = card.querySelector('.kv2-telegram-badge')?.getBoundingClientRect();
      if (!runtime || !telegram) return false;
      return !(runtime.right < telegram.left || telegram.right < runtime.left || runtime.bottom < telegram.top || telegram.bottom < runtime.top);
    });
    expect(overlap).toBe(false);

    await page.getByRole('button', { name: 'Create new card' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Opencode', exact: true }).click();
    await expect(dialog.locator('.kv2-session-panel--embedded')).toContainText('Opencode');
    await expect(dialog.locator('.kv2-session-panel--embedded')).toContainText('Codex');
    await expect(dialog.locator('.kv2-session-panel--embedded')).toContainText('Claude');
  });
});
