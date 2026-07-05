import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { createClaudeAdapter } from '../plugin/runtimes/claude-adapter';
import { ChildLinker } from '../plugin/runtimes/child-linker';
import { withTempDir } from './setup';

async function createFakeClaudeBinary(dir: string, scenario: string, options: {
  argvPath?: string;
  envPath?: string;
  sessionId?: string;
  emittedSessionId?: string;
  output?: string;
  stderr?: string;
} = {}): Promise<string> {
  const path = join(dir, 'fake-claude.js');
  await Bun.write(path, `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
const argvPath = ${JSON.stringify(options.argvPath ?? '')};
const envPath = ${JSON.stringify(options.envPath ?? '')};
const configuredSessionId = ${JSON.stringify(options.sessionId ?? '')};
const configuredEmittedSessionId = ${JSON.stringify(options.emittedSessionId ?? '')};
const configuredOutput = ${JSON.stringify(options.output ?? 'claude final result')};
const configuredStderr = ${JSON.stringify(options.stderr ?? 'claude failed')};
if (argvPath) fs.writeFileSync(argvPath, JSON.stringify(args));
if (envPath) {
  fs.writeFileSync(envPath, JSON.stringify({
    cardId: process.env.AGENT_KANBAN_DISPATCH_CARD_ID || '',
    runId: process.env.AGENT_KANBAN_DISPATCH_RUN_ID || '',
  }));
}
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : (configuredSessionId || 'claude-session-abc');
const emittedSessionId = configuredEmittedSessionId || sessionId;
function emit(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
if (scenario === 'timeout') {
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(1);
}
emit({ type: 'system', subtype: 'init', session_id: emittedSessionId });
if (scenario === 'failure') {
  process.stderr.write(configuredStderr);
  process.exit(1);
}
const output = scenario === 'echo' ? configuredOutput + ':' + prompt.trim() : configuredOutput;
emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: output }] } });
emit({ type: 'result', result: output, session_id: emittedSessionId, total_cost_usd: 0.001 });
process.exit(0);
`);
  chmodSync(path, 0o755);
  return path;
}

describe('ClaudeAdapter', () => {
  test('dispatch success captures session_id and completes the card', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', { output: 'done' });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
        model: 'claude-sonnet-4-6',
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      expect(handle.sessionId).toBe('claude-session-abc');
      expect(handle.runId).toStartWith('claude-');

      const done = await handle.done;
      expect(done.outcome).toBe('completed');

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('claude-session-abc');
      expect(updated?.result).toBe('done');
      expect(updated?.responseAt).toBeTruthy();

      const run = await runStore.getRun(handle.runId);
      expect(run?.status).toBe('completed');
      expect(await Bun.file(run!.lastMessagePath).text()).toBe('done');
    });
  });

  test('failure marks run failed and returns card to todo', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir, 'failure', { stderr: 'rate limit' });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const predecessor = await store.createCard({
        title: 'Predecessor',
        description: 'Already ran',
        agentRuntime: 'claude',
        sessionId: 'claude-session-predecessor',
      });
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
        model: 'claude-sonnet-4-6',
        command: 'verify',
        arguments: '--browser',
        resumeSessionId: 'claude-session-original',
        claudeOptions: {
          permissionMode: 'plan',
          dangerouslySkipPermissions: false,
        },
      });
      const bytes = new Uint8Array([4, 5, 6]);
      await store.saveScreenshot(
        card.id,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        'claude-failure-context.png',
        'image/png',
      );
      const dispatchCard = await store.updateCard(card.id, {
        queuedAfterCardId: predecessor.id,
        queuePosition: 2,
        queueSessionMode: 'continue_queued_after_session',
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({
        card: dispatchCard,
        prompt: dispatchCard.description,
        cwd: dir,
        resumeSessionId: dispatchCard.resumeSessionId,
      });
      const done = await handle.done;
      expect(done.outcome).toBe('failed');

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('todo');
      expect(updated?.sessionId).toBe('claude-session-original');
      expect(updated?.progressSummary).toStartWith('[failed]');
      expect(updated?.progressSummary).toContain('rate limit');
      expect(updated?.projectDir).toBe(dir);
      expect(updated?.model).toBe('claude-sonnet-4-6');
      expect(updated?.agentRuntime).toBe('claude');
      expect(updated?.command).toBe('verify');
      expect(updated?.arguments).toBe('--browser');
      expect(updated?.resumeSessionId).toBe('claude-session-original');
      expect(updated?.queuedAfterCardId).toBe(predecessor.id);
      expect(updated?.queuePosition).toBe(2);
      expect(updated?.queueSessionMode).toBe('continue_queued_after_session');
      expect(updated?.claudeOptions).toEqual({
        permissionMode: 'plan',
        dangerouslySkipPermissions: false,
      });
      expect(updated?.screenshots).toHaveLength(1);
      expect(updated?.screenshots?.[0].originalName).toBe('claude-failure-context.png');
    });
  });

  test('session_id timeout fails run and does not save placeholder sessionId', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir, 'timeout');
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 50,
      });

      await expect(adapter.start({ card, prompt: card.description, cwd: dir })).rejects.toThrow('session_id timeout');

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('todo');
      expect(updated?.sessionId).toBeUndefined();
      expect(updated?.progressSummary).toStartWith('[failed] Claude session_id timeout');

      const runs = await runStore.listRuns();
      expect(runs[0].status).toBe('failed');
    });
  });

  test('feedback uses --resume with the original session id', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const envPath = join(dir, 'env.json');
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', {
        argvPath,
        envPath,
        output: 'feedback done',
      });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const original = await store.createCard({
        title: 'Original',
        description: 'Original',
        agentRuntime: 'claude',
        sessionId: 'claude-session-original',
      });
      const feedback = await store.createCard({
        title: 'Feedback',
        description: 'Feedback',
        agentRuntime: 'claude',
        feedbackForCardId: original.id,
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({
        card: feedback,
        prompt: feedback.description,
        cwd: dir,
        resumeSessionId: original.sessionId,
      });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('--resume');
      expect(argv[argv.indexOf('--resume') + 1]).toBe('claude-session-original');
      const env = JSON.parse(await Bun.file(envPath).text()) as { cardId: string; runId: string };
      expect(env.cardId).toBe(feedback.id);
      expect(env.runId).toBe(handle.runId);
      const updated = await store.getCard(feedback.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('claude-session-original');
      expect(updated?.result).toBe('feedback done');
    });
  });

  test('resume keeps the requested session id when Claude emits a different session_id', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', {
        emittedSessionId: 'claude-session-unexpected-new',
        output: 'follow-up done',
      });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Follow-up',
        description: 'Follow-up',
        agentRuntime: 'claude',
        resumeSessionId: 'claude-session-original',
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({
        card,
        prompt: card.description,
        cwd: dir,
        resumeSessionId: 'claude-session-original',
      });
      expect(handle.sessionId).toBe('claude-session-original');
      await handle.done;

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('claude-session-original');
      expect(updated?.result).toBe('follow-up done');

      const run = await runStore.getRun(handle.runId);
      expect(run?.sessionId).toBe('claude-session-original');
    });
  });

  test('spawn env includes dispatch markers', async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, 'env.json');
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', { envPath });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const env = JSON.parse(await Bun.file(envPath).text()) as { cardId: string; runId: string };
      expect(env.cardId).toBe(card.id);
      expect(env.runId).toBe(handle.runId);
    });
  });

  test('permission settings are reflected in argv', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', { argvPath });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      await settingsStore.upsertByKey('agent.claude.permission_mode', 'plan');
      await settingsStore.upsertByKey('agent.claude.dangerously_skip_permissions', 'false');
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
        model: 'claude-opus-4-7',
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('--permission-mode');
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
      expect(argv).toContain('--model');
      expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-4-7');
    });
  });

  test('card Claude options override current permission settings in argv', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const fakeClaude = await createFakeClaudeBinary(dir, 'success', { argvPath });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      await settingsStore.upsertByKey('agent.claude.permission_mode', 'plan');
      await settingsStore.upsertByKey('agent.claude.dangerously_skip_permissions', 'false');
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
        claudeOptions: {
          permissionMode: 'bypassPermissions',
          dangerouslySkipPermissions: false,
        },
      });
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeClaude],
        sessionIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('--permission-mode');
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    });
  });
});

async function createFakeClaudeWithFixture(dir: string): Promise<string> {
  const fixturePath = join(import.meta.dir, './fixtures/claude-task-stream-2.1.195.jsonl');
  const path = join(dir, 'fake-claude-fixture.js');
  await Bun.write(path, `#!/usr/bin/env bun
const { readFileSync } = require('node:fs');
const lines = readFileSync(${JSON.stringify(fixturePath)}, 'utf-8').split('\\n');
for (const line of lines) { if (line.trim()) process.stdout.write(line + '\\n'); }
process.exit(0);
`);
  chmodSync(path, 0o755);
  return path;
}

describe('ChildLinker integration via claude-adapter', () => {
  test('P0 fixture stdout → child card created and completed', async () => {
    await withTempDir(async (dir) => {
      const fakeBinary = await createFakeClaudeWithFixture(dir);
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const parent = await store.createCard({
        title: 'Parent Task',
        description: 'Do work',
        agentRuntime: 'claude',
        projectDir: dir,
      });

      const childLinker = new ChildLinker(store);
      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeBinary],
        sessionIdTimeoutMs: 3000,
        onChildEvent: (parentCardId, runId, ev) => childLinker.onChildEvent(parentCardId, runId, ev),
      });

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

  test('onChildEvent throw is swallowed and parent run completes', async () => {
    await withTempDir(async (dir) => {
      const fakeBinary = await createFakeClaudeWithFixture(dir);
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const parent = await store.createCard({
        title: 'Parent Task',
        description: 'Do work',
        agentRuntime: 'claude',
        projectDir: dir,
      });

      const adapter = createClaudeAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeBinary],
        sessionIdTimeoutMs: 3000,
        onChildEvent: async () => { throw new Error('child event handler exploded'); },
      });

      const handle = await adapter.start({ card: parent, prompt: parent.description, cwd: dir });
      const result = await handle.done;

      expect(result.outcome).toBe('completed');
      const updated = await store.getCard(parent.id);
      expect(updated?.status).toBe('complete');
    });
  });
});
