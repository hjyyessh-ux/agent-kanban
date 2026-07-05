import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { createCodexCliAdapter } from '../plugin/runtimes/codex-cli-adapter';
import { withTempDir } from './setup';

async function createFakeCodexBinary(dir: string, scenario: string, options: {
  argvPath?: string;
  envPath?: string;
  threadId?: string;
  emittedThreadId?: string;
  output?: string;
  stderr?: string;
} = {}): Promise<string> {
  const path = join(dir, 'fake-codex.js');
  await Bun.write(path, `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
const argvPath = ${JSON.stringify(options.argvPath ?? '')};
const envPath = ${JSON.stringify(options.envPath ?? '')};
const configuredThreadId = ${JSON.stringify(options.threadId ?? '')};
const configuredEmittedThreadId = ${JSON.stringify(options.emittedThreadId ?? '')};
const configuredOutput = ${JSON.stringify(options.output ?? 'codex final result')};
const configuredStderr = ${JSON.stringify(options.stderr ?? 'codex failed')};
if (argvPath) fs.writeFileSync(argvPath, JSON.stringify(args));
if (envPath) {
  fs.writeFileSync(envPath, JSON.stringify({
    cardId: process.env.AGENT_KANBAN_DISPATCH_CARD_ID || '',
    runId: process.env.AGENT_KANBAN_DISPATCH_RUN_ID || '',
  }));
}
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const outputPath = args[args.indexOf('-o') + 1] || args[args.indexOf('--output-last-message') + 1];
const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : (configuredThreadId || 'thread-codex-abc');
const emittedThreadId = configuredEmittedThreadId || threadId;
function emit(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
if (scenario === 'timeout') {
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(1);
}
emit({ type: 'thread.started', thread_id: emittedThreadId });
if (scenario === 'failure') {
  process.stderr.write(configuredStderr);
  process.exit(1);
}
const output = scenario === 'echo' ? configuredOutput + ':' + prompt.trim() : configuredOutput;
if (outputPath) fs.writeFileSync(outputPath, output);
emit({ type: 'item.completed', item: { role: 'assistant', content: [{ type: 'text', text: output }] } });
emit({ type: 'turn.completed' });
process.exit(0);
`);
  chmodSync(path, 0o755);
  return path;
}

describe('CodexCliAdapter', () => {
  test('dispatch success captures thread_id, completes the card, and returns dispatch schema', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir, 'success', { output: 'done' });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const dispatchNext = mock(async () => ({
        sessionId: 'queued-thread',
        runId: 'queued-run',
        startedAt: new Date().toISOString(),
      }));
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
        model: 'gpt-5.3-codex',
      });
      const queued = await store.createCard({
        title: 'Queued',
        description: 'Queued',
        agentRuntime: 'codex',
      });
      await store.updateCard(queued.id, {
        queuedAfterCardId: card.id,
        queuePosition: 1,
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
        dispatchFn: dispatchNext,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      expect(handle.sessionId).toBe('thread-codex-abc');
      expect(handle.runId).toStartWith('codex-');
      expect(handle.startedAt).toBeString();

      const done = await handle.done;
      expect(done.outcome).toBe('completed');
      expect(dispatchNext).toHaveBeenCalledWith(queued.id);

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('thread-codex-abc');
      expect(updated?.result).toBe('done');
      expect(updated?.responseAt).toBeTruthy();

      const run = await runStore.getRun(handle.runId);
      expect(run?.status).toBe('completed');
      expect(await Bun.file(run!.lastMessagePath).text()).toBe('done');
    });
  });

  test('failure marks run failed and returns card to todo', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir, 'failure', { stderr: 'rate limit' });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const predecessor = await store.createCard({
        title: 'Predecessor',
        description: 'Already ran',
        agentRuntime: 'codex',
        sessionId: 'thread-predecessor',
      });
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
        model: 'gpt-5.3-codex',
        command: 'prompts:planner',
        arguments: '--tight',
        resumeSessionId: 'thread-resume-original',
        codexOptions: {
          reasoningEffort: 'high',
          sandbox: 'read-only',
          skipGitRepoCheck: false,
          bypassApprovalsAndSandbox: false,
        },
      });
      const bytes = new Uint8Array([1, 2, 3]);
      await store.saveScreenshot(
        card.id,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        'failure-context.png',
        'image/png',
      );
      const dispatchCard = await store.updateCard(card.id, {
        queuedAfterCardId: predecessor.id,
        queuePosition: 2,
        queueSessionMode: 'continue_queued_after_session',
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
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
      expect(updated?.sessionId).toBe('thread-resume-original');
      expect(updated?.progressSummary).toStartWith('[failed]');
      expect(updated?.progressSummary).toContain('rate limit');
      expect(updated?.projectDir).toBe(dir);
      expect(updated?.model).toBe('gpt-5.3-codex');
      expect(updated?.agentRuntime).toBe('codex');
      expect(updated?.command).toBe('prompts:planner');
      expect(updated?.arguments).toBe('--tight');
      expect(updated?.resumeSessionId).toBe('thread-resume-original');
      expect(updated?.queuedAfterCardId).toBe(predecessor.id);
      expect(updated?.queuePosition).toBe(2);
      expect(updated?.queueSessionMode).toBe('continue_queued_after_session');
      expect(updated?.codexOptions).toEqual({
        reasoningEffort: 'high',
        sandbox: 'read-only',
        skipGitRepoCheck: false,
        bypassApprovalsAndSandbox: false,
      });
      expect(updated?.screenshots).toHaveLength(1);
      expect(updated?.screenshots?.[0].originalName).toBe('failure-context.png');
    });
  });

  test('thread_id timeout fails run and does not save placeholder sessionId', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir, 'timeout');
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 50,
      });

      await expect(adapter.start({ card, prompt: card.description, cwd: dir })).rejects.toThrow('thread_id timeout');

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('todo');
      expect(updated?.sessionId).toBeUndefined();
      expect(updated?.progressSummary).toStartWith('[failed] Codex thread_id timeout');

      const runs = await runStore.listRuns();
      expect(runs[0].status).toBe('failed');
    });
  });

  test('feedback resumes with codex exec resume threadId argv', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const envPath = join(dir, 'env.json');
      const fakeCodex = await createFakeCodexBinary(dir, 'success', {
        argvPath,
        envPath,
        output: 'feedback done',
      });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const original = await store.createCard({
        title: 'Original',
        description: 'Original',
        agentRuntime: 'codex',
        sessionId: 'thread-original',
      });
      const feedback = await store.createCard({
        title: 'Feedback',
        description: 'Feedback',
        agentRuntime: 'codex',
        feedbackForCardId: original.id,
        model: 'gpt-5.4-mini',
        codexOptions: {
          reasoningEffort: 'xhigh',
          sandbox: 'read-only',
          skipGitRepoCheck: true,
        },
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({
        card: feedback,
        prompt: feedback.description,
        cwd: dir,
        resumeSessionId: original.sessionId,
      });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv[0]).toBe('exec');
      expect(argv.slice(-3)).toEqual(['resume', 'thread-original', '-']);
      expect(argv).toContain('-C');
      expect(argv[argv.indexOf('-C') + 1]).toBe(dir);
      expect(argv.indexOf('-C')).toBeLessThan(argv.indexOf('resume'));
      expect(argv).not.toContain('--cwd');
      expect(argv).toContain('-m');
      expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.4-mini');
      expect(argv).toContain('-s');
      expect(argv[argv.indexOf('-s') + 1]).toBe('read-only');
      expect(argv.indexOf('-s')).toBeLessThan(argv.indexOf('resume'));
      expect(argv).toContain('-c');
      expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="xhigh"');
      const env = JSON.parse(await Bun.file(envPath).text()) as { cardId: string; runId: string };
      expect(env.cardId).toBe(feedback.id);
      expect(env.runId).toBe(handle.runId);

      const updated = await store.getCard(feedback.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('thread-original');
      expect(updated?.result).toBe('feedback done');
    });
  });

  test('card option bypasses approvals and sandbox in argv', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const fakeCodex = await createFakeCodexBinary(dir, 'success', { argvPath });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
        codexOptions: {
          sandbox: 'danger-full-access',
          bypassApprovalsAndSandbox: true,
        },
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('-s');
      expect(argv[argv.indexOf('-s') + 1]).toBe('danger-full-access');
      expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  test('stored Codex bypass default is used when card option is absent', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const fakeCodex = await createFakeCodexBinary(dir, 'success', { argvPath });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      await settingsStore.upsertByKey('agent.codex.bypass_approvals_and_sandbox', 'true');
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
      });
      const adapter = createCodexCliAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  test('stored Codex reasoning and sandbox defaults are used when card options are absent', async () => {
    await withTempDir(async (dir) => {
      const argvPath = join(dir, 'argv.json');
      const fakeCodex = await createFakeCodexBinary(dir, 'success', { argvPath });
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const runStore = new RuntimeRunStore(dir);
      await settingsStore.upsertByKey('agent.defaults.codex.reasoning_effort', 'high');
      await settingsStore.upsertByKey('agent.defaults.codex.sandbox', 'read-only');
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
      });
      const adapter = createCodexCliAdapter({
        store,
        settingsStore,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
      expect(argv).toContain('-s');
      expect(argv[argv.indexOf('-s') + 1]).toBe('read-only');
      expect(argv).toContain('-c');
      expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
    });
  });

  test('Codex bypass env var is used when card and setting are absent', async () => {
    const previous = process.env.KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX;
    process.env.KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX = 'true';
    try {
      await withTempDir(async (dir) => {
        const argvPath = join(dir, 'argv.json');
        const fakeCodex = await createFakeCodexBinary(dir, 'success', { argvPath });
        const store = new KanbanStore(dir);
        const runStore = new RuntimeRunStore(dir);
        const card = await store.createCard({
          title: 'Codex task',
          description: 'Do it',
          agentRuntime: 'codex',
          projectDir: dir,
        });
        const adapter = createCodexCliAdapter({
          store,
          runStore,
          commandOverride: [fakeCodex],
          threadIdTimeoutMs: 1000,
        });

        const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
        await handle.done;

        const argv = JSON.parse(await Bun.file(argvPath).text()) as string[];
        expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
      });
    } finally {
      if (previous === undefined) {
        delete process.env.KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX;
      } else {
        process.env.KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX = previous;
      }
    }
  });

  test('resume keeps the requested thread id when Codex emits a different thread_id', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir, 'success', {
        emittedThreadId: 'thread-unexpected-new',
        output: 'follow-up done',
      });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Follow-up',
        description: 'Follow-up',
        agentRuntime: 'codex',
        resumeSessionId: 'thread-original',
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({
        card,
        prompt: card.description,
        cwd: dir,
        resumeSessionId: 'thread-original',
      });
      expect(handle.sessionId).toBe('thread-original');
      await handle.done;

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.sessionId).toBe('thread-original');
      expect(updated?.result).toBe('follow-up done');

      const run = await runStore.getRun(handle.runId);
      expect(run?.sessionId).toBe('thread-original');
    });
  });

  test('spawn env includes dispatch markers', async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, 'env.json');
      const fakeCodex = await createFakeCodexBinary(dir, 'success', { envPath });
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
      });
      const adapter = createCodexCliAdapter({
        store,
        runStore,
        commandOverride: [fakeCodex],
        threadIdTimeoutMs: 1000,
      });

      const handle = await adapter.start({ card, prompt: card.description, cwd: dir });
      await handle.done;

      const env = JSON.parse(await Bun.file(envPath).text()) as { cardId: string; runId: string };
      expect(env.cardId).toBe(card.id);
      expect(env.runId).toBe(handle.runId);
    });
  });
});
