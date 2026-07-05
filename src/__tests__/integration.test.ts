import { describe, test, expect } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../server/index';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { buildDispatchPromptBody, runCardCommand, runCardCommandThenPrompt } from '../plugin/index';
import { buildDispatchPromptText } from '../plugin/dispatch-prompt';
import { setDynamicSkillCommands } from '../core/commands';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { withTempDir } from './setup';

async function withTestServer(callback: (baseUrl: string, store: KanbanStore) => Promise<void>) {
  await withTempDir(async (dir) => {
    const store = new KanbanStore(dir);
    // Use a different port range to avoid conflicts
    const port = 24800 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(store, port);
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback(baseUrl, store);
    } finally {
      stop();
    }
  });
}

describe('Integration: API Data Flow', () => {
  test('Full card lifecycle: create -> update status -> complete -> done', async () => {
    await withTestServer(async (url) => {
      // 1. Create card
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Lifecycle Task', description: 'Testing flow' }),
      });
      expect(createRes.status).toBe(201);
      const card = await createRes.json();
      expect(card.status).toBe('todo');

      // 2. Start task (todo -> in_progress)
      const startRes = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      expect(startRes.status).toBe(200);
      const started = await startRes.json();
      expect(started.status).toBe('in_progress');

      // 3. Complete task (in_progress -> complete)
      const completeRes = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'complete' }),
      });
      expect(completeRes.status).toBe(200);

      // 4. Mark done (complete -> done)
      const doneRes = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
      expect(doneRes.status).toBe(200);

      // 5. Verify final state
      const getRes = await fetch(`${url}/api/cards/${card.id}`);
      expect(getRes.status).toBe(200);
      const finalCard = await getRes.json();
      expect(finalCard.status).toBe('done');
    });
  });

  test('agent-thread endpoint parses a subagent transcript into card.agentMessages', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Child', description: 'subagent', parentCardId: 'p1' }),
      });
      const card = await createRes.json();

      const transcript = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '너는 NumOne이다.' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'main', message: 'MY_NUMBER: 11' } }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'NumTwo', message: 'A_NUM:11' } }] },
        }),
      ].join('\n');

      const postRes = await fetch(`${url}/api/cards/${card.id}/agent-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: transcript,
      });
      expect(postRes.status).toBe(200);
      const updated = await postRes.json();
      expect(updated.agentMessages).toEqual([
        { direction: 'in', from: 'main', message: '너는 NumOne이다.' },
        { direction: 'out', to: 'main', message: 'MY_NUMBER: 11' },
        { direction: 'out', to: 'NumTwo', message: 'A_NUM:11' },
      ]);

      // Persisted and retrievable on subsequent GET.
      const fetched = await (await fetch(`${url}/api/cards/${card.id}`)).json();
      expect(fetched.agentMessages).toHaveLength(3);
    });
  });

  test('agent-thread returns 404 for an unknown card', async () => {
    await withTestServer(async (url) => {
      const res = await fetch(`${url}/api/cards/does-not-exist/agent-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '',
      });
      expect(res.status).toBe(404);
    });
  });

  test('command-only cards can be created with empty description', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Init deep only',
          description: '',
          command: 'init-deep',
          projectDir: '/tmp/test-project',
        }),
      });

      expect(createRes.status).toBe(201);
      const card = await createRes.json();
      expect(card.title).toBe('Init deep only');
      expect(card.description).toBe('');
      expect(card.command).toBe('init-deep');
    });
  });
});

describe('Integration: dispatch prompt body mapping', () => {
  test('buildDispatchPromptBody maps primary agentType to prompt agent', () => {
    const body = buildDispatchPromptBody({
      model: 'github-copilot/claude-opus-4.6',
      agentType: 'hephaestus',
      description: 'test prompt',
    });

    expect(body.agent).toBe('Hephaestus (Deep Agent)');
    expect(body.model).toEqual({ providerID: 'github-copilot', modelID: 'claude-opus-4.6' });
    expect(body.parts[0].text).toBe('test prompt');
  });

  test('buildDispatchPromptBody normalizes legacy sisyphus labels', () => {
    const body = buildDispatchPromptBody({
      agentType: 'Sisyphus (Ultraworker)',
      description: 'test prompt',
    });

    expect(body.agent).toBe('Sisyphus (Ultraworker)');
  });

  test('buildDispatchPromptBody omits non-primary agentType', () => {
    const body = buildDispatchPromptBody({
      agentType: 'explore',
      description: 'test prompt',
    });

    expect(body.agent).toBeUndefined();
  });

  test('buildDispatchPromptText appends screenshot file context', () => {
    const text = buildDispatchPromptText({
      description: 'inspect attached UI',
      screenshots: [
        {
          id: 'shot-1',
          cardId: 'card-1',
          filename: 'card-1_123_shot-1.png',
          originalName: 'ui.png',
          mimeType: 'image/png',
          size: 42,
          createdAt: '2026-05-27T00:00:00.000Z',
        },
      ],
    }, (screenshot) => `/tmp/screenshots/${screenshot.filename}`);

    expect(text).toContain('inspect attached UI');
    expect(text).toContain('Attached screenshots:');
    expect(text).toContain('ui.png');
    expect(text).toContain('/tmp/screenshots/card-1_123_shot-1.png');
    expect(text).toContain('Use the screenshot file path(s) above as visual context for this task.');
  });

  test('buildDispatchPromptText prefixes Codex command context only for Codex runtime', () => {
    const codexText = buildDispatchPromptText({
      agentRuntime: 'codex',
      command: 'prompts:architect',
      arguments: '--risk-first',
      description: 'review the runtime command design',
    }, () => '/tmp/unused.png');

    expect(codexText).toContain('Codex command: /prompts:architect --risk-first');
    expect(codexText).toContain('Command purpose: 구조, 경계, 리스크를 먼저 판단하는 설계 관점으로 실행합니다.');
    expect(codexText).toContain('review the runtime command design');

    const opencodeText = buildDispatchPromptText({
      agentRuntime: 'opencode',
      command: 'start-work',
      arguments: 'plan-a',
      description: 'start the plan',
    }, () => '/tmp/unused.png');

    expect(opencodeText).toBe('start the plan');
  });

  test('buildDispatchPromptText invokes Codex skills explicitly', () => {
    // skill-creator is now a disk-discovered skill rather than a static command.
    setDynamicSkillCommands([
      {
        id: 'skills:skill-creator',
        runtime: 'codex',
        kind: 'codex_skill',
        skillName: 'skill-creator',
        displayName: '$skill-creator',
        description: 'Scaffold a new skill.',
        source: 'test',
        directory: '/tmp/test-skills/skill-creator',
        scope: 'user',
      },
    ]);
    const text = buildDispatchPromptText({
      agentRuntime: 'codex',
      command: 'skills:skill-creator',
      arguments: '새 skill 초안',
      description: '옵시디언 문서 정리용 skill을 만들어줘',
    }, () => '/tmp/unused.png');

    expect(text).toBe('$skill-creator 새 skill 초안\n\n옵시디언 문서 정리용 skill을 만들어줘');
  });

  test('buildDispatchPromptText prepends real Claude slash commands', () => {
    const commandOnly = buildDispatchPromptText({
      agentRuntime: 'claude',
      command: 'code-review',
      arguments: 'high --fix',
      description: 'this should be ignored for command-only',
    }, () => '/tmp/unused.png');

    expect(commandOnly).toBe('/code-review high --fix');

    const withPrompt = buildDispatchPromptText({
      agentRuntime: 'claude',
      command: 'verify',
      description: 'confirm the login flow works',
    }, () => '/tmp/unused.png');

    expect(withPrompt).toBe('/verify\n\nconfirm the login flow works');

    const noCommand = buildDispatchPromptText({
      agentRuntime: 'claude',
      description: 'just a prompt',
    }, () => '/tmp/unused.png');

    expect(noCommand).toBe('just a prompt');
  });

  test('runCardCommand folds prompt text into command arguments for prompt-consuming commands', async () => {
    const calls: Array<{
      path: { id: string };
      body: { command: string; arguments: string };
      query?: { directory?: string };
    }> = [];

    await runCardCommand({
      runCommand: async (options) => {
        calls.push(options);
      },
      card: {
        command: 'ulw-loop',
        arguments: '"fix flaky tests" --strategy=continue',
        projectDir: '/tmp/test-project',
        description: 'investigate deploy regressions',
      },
      sessionId: 'session-command-1',
    });

    expect(calls).toEqual([
      {
        path: { id: 'session-command-1' },
        body: {
          command: 'ulw-loop',
          arguments: 'investigate deploy regressions "fix flaky tests" --strategy=continue',
        },
        query: { directory: '/tmp/test-project' },
      },
    ]);
  });

  test('runCardCommand swallows command failure and shows toast', async () => {
    const toasts: string[] = [];

    await runCardCommand({
      runCommand: async () => {
        throw new Error('command failed');
      },
      showToast: (options) => {
        toasts.push(options.body.message);
      },
      card: {
        command: 'handoff',
        arguments: '[goal]',
        description: 'summarize the last session',
      },
      sessionId: 'session-command-2',
    });

    expect(toasts).toEqual(['Command failed but prompt continued: handoff']);
  });

  test('runCardCommand ignores unsupported commands', async () => {
    const calls: string[] = [];

    await runCardCommand({
      runCommand: async () => {
        calls.push('command');
      },
      card: {
        command: '/not-built-in',
        description: 'ignored',
      },
      sessionId: 'session-command-3',
    });

    expect(calls).toEqual([]);
  });

  test('runCardCommandThenPrompt skips prompt for command-only commands', async () => {
    const sequence: string[] = [];

    await runCardCommandThenPrompt({
      runCommand: async () => {
        sequence.push('command');
      },
      runPrompt: async () => {
        sequence.push('prompt');
      },
      card: {
        command: '/init-deep',
        arguments: '--max-depth=2',
        description: 'this prompt should be ignored',
      },
      sessionId: 'session-command-4',
    });

    expect(sequence).toEqual(['command']);
  });

  test('runCardCommandThenPrompt does not call prompt for prompt-consuming commands', async () => {
    const sequence: string[] = [];

    await runCardCommandThenPrompt({
      runCommand: async () => {
        sequence.push('command');
      },
      runPrompt: async () => {
        sequence.push('prompt');
      },
      card: {
        command: '/ralph-loop',
        arguments: '--strategy=continue',
        description: 'ship feature',
      },
      sessionId: 'session-command-5',
    });

    expect(sequence).toEqual(['command']);
  });
});

describe('Integration: Dispatch Dedup (kanban_create tool + chat.message hook)', () => {
  test('dispatch flow: existing card prevents duplicate from kanban_create tool', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const sessionId = 'dispatched-session-integ';

      // Step 1: Simulate what dispatchCard() does — create a card via store.createCard()
      // then update its status to in_progress with the new sessionId
      const dispatched = await store.createCard({
        title: 'Dispatch: Fix login bug',
        description: 'User reported login fails on Safari',
        projectDir: '/tmp/test-project',
        sessionId,
      });
      await store.updateCard(dispatched.id, { status: 'in_progress' });

      // Step 2: Simulate what the agent does after dispatch — calls kanban_create tool
      // This should NOT create a duplicate; it should return the existing card
      const { createKanbanCreateTool } = await import('../plugin/tools/index');
      const mockInput = {
        client: {},
        project: {},
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        serverUrl: new URL('http://localhost:4000'),
        $: {},
      } as any;
      const mockCtx = {
        sessionID: sessionId,
        messageID: 'msg-from-agent',
        agent: 'claude-3',
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      } as any;

      const tool = createKanbanCreateTool(store, mockInput);
      const result = await tool.execute(
        { title: 'Fix login bug', description: 'Detailed agent plan to fix login' },
        mockCtx,
      );

      // Should return success (existing card)
      expect(result).toContain('✅');

      // Should have exactly 1 card — NOT 2
      const allCards = await store.getCards();
      const topLevel = allCards.filter(c => !c.parentCardId);
      expect(topLevel).toHaveLength(1);
      expect(topLevel[0].id).toBe(dispatched.id);

      // Should have updated title/description
      expect(topLevel[0].title).toBe('Fix login bug');
      expect(topLevel[0].description).toBe('Detailed agent plan to fix login');
    });
  });

  test('hook creates card, then tool call in same session does NOT duplicate', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const sessionId = 'hook-then-tool-session';

      // Step 1: Simulate hook creating a card (what chat.message does)
      const hookCard = await store.createCard({
        title: 'User said: implement dark mode',
        description: 'implement dark mode',
        sessionId,
        projectDir: '/tmp/test-project',
        model: 'anthropic/claude-3',
        agentType: 'build',
      });
      await store.updateCard(hookCard.id, { status: 'in_progress' });

      // Step 2: Agent calls kanban_create to track its work
      const { createKanbanCreateTool } = await import('../plugin/tools/index');
      const mockInput = {
        client: {},
        project: {},
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        serverUrl: new URL('http://localhost:4000'),
        $: {},
      } as any;
      const mockCtx = {
        sessionID: sessionId,
        messageID: 'msg-2',
        agent: 'claude-3',
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      } as any;

      const tool = createKanbanCreateTool(store, mockInput);
      const result = await tool.execute(
        { title: 'Dark mode implementation', description: 'Plan: 1. Add toggle 2. Update CSS' },
        mockCtx,
      );
      expect(result).toContain('✅');

      // Only 1 top-level card
      const allCards = await store.getCards();
      const topLevel = allCards.filter(c => !c.parentCardId);
      expect(topLevel).toHaveLength(1);
      expect(topLevel[0].id).toBe(hookCard.id);
    });
  });

  test('multiple kanban_create calls in rapid succession create only 1 card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const sessionId = 'rapid-fire-session';

      const { createKanbanCreateTool } = await import('../plugin/tools/index');
      const mockInput = {
        client: {},
        project: {},
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        serverUrl: new URL('http://localhost:4000'),
        $: {},
      } as any;
      const mockCtx = {
        sessionID: sessionId,
        messageID: 'msg-rapid',
        agent: 'claude-3',
        directory: '/tmp/test-project',
        worktree: '/tmp/test-project',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      } as any;

      const tool = createKanbanCreateTool(store, mockInput);

      // Fire 3 sequential calls (simulating agent retries or multiple create attempts)
      await tool.execute({ title: 'Task v1', description: 'First attempt' }, mockCtx);
      await tool.execute({ title: 'Task v2', description: 'Second attempt' }, mockCtx);
      await tool.execute({ title: 'Task v3', description: 'Third attempt' }, mockCtx);

      const allCards = await store.getCards();
      expect(allCards).toHaveLength(1);
      // Last call should have updated title/desc
      expect(allCards[0].title).toBe('Task v3');
      expect(allCards[0].description).toBe('Third attempt');
    });
  });
});

describe('Standalone daemon runtime with ChildLinker', () => {
  test('claude run with task events creates child card via ChildLinker', async () => {
    await withTempDir(async (dir) => {
      const fixturePath = join(import.meta.dir, './fixtures/claude-task-stream-2.1.195.jsonl');
      const fakeBinaryPath = join(dir, 'fake-claude.js');
      await Bun.write(fakeBinaryPath, `#!/usr/bin/env bun
const { readFileSync } = require('node:fs');
const lines = readFileSync(${JSON.stringify(fixturePath)}, 'utf-8').split('\\n');
for (const line of lines) { if (line.trim()) process.stdout.write(line + '\\n'); }
process.exit(0);
`);
      chmodSync(fakeBinaryPath, 0o755);

      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const host = await createStandaloneRuntimeHost({
        store,
        settingsStore,
        dataDir: dir,
        cwd: dir,
        claudeCommandOverride: [fakeBinaryPath],
        claudeSessionIdTimeoutMs: 3000,
      });

      const parent = await store.createCard({
        title: 'Daemon Parent Task',
        description: 'Do work in daemon mode',
        agentRuntime: 'claude',
        projectDir: dir,
      });

      const adapter = host.registry.pickAdapter('claude');
      const handle = await adapter.start({ card: parent, prompt: parent.description, cwd: dir });
      const result = await handle.done;

      expect(result.outcome).toBe('completed');

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id && c.linkKind === 'subagent');
      expect(children).toHaveLength(1);
      expect(children[0].childTaskId).toBe('a6419ba278a83071e');
      expect(children[0].status).toBe('complete');
    });
  });
});
