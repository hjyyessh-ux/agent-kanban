import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { ScriptStore } from '../core/script-store';
import { SettingsStore } from '../core/settings-store';
import type { ScriptRun } from '../core/types';
import {
  ScriptExecutionConflictError,
  ScriptExecutionService,
  type ScriptSpawnInput,
  type ScriptSpawnProcess,
} from '../plugin/script-execution-service';
import { withTempDir } from './setup';

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function completedProcess(stdout = '', stderr = '', exitCode = 0): ScriptSpawnProcess {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode) };
}

async function createTrackedCard(
  store: KanbanStore,
  input: { runId: string; cwd: string; title?: string },
) {
  return store.createCard({
    title: input.title ?? 'Tracked script',
    description: 'Run the stored script snapshot',
    projectDir: input.cwd,
    executionKind: 'script',
    scriptRunId: input.runId,
  });
}

describe('ScriptExecutionService', () => {
  test('passes spaces, quotes, semicolons, and dollar substitutions as env data only', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const marker = join(dir, 'must-not-exist');
      const payload = `space value \"quoted\"; touch ${marker}; $(printf injected)`;
      const script = await scriptStore.createEntry({
        name: 'safe-env', description: '', language: 'bash', projectDir: dir,
        content: 'printf "%s" "$AK_PARAM_PAYLOAD"',
      });
      const service = new ScriptExecutionService({ scriptStore, cardStore });
      const plan = await service.prepareExecution({
        scriptId: script.id,
        parameterValues: { payload },
      });
      const card = await createTrackedCard(cardStore, plan);

      await service.startPreparedExecution(plan, card.id);
      const run = await service.waitForRun(plan.runId);

      expect(run.status).toBe('success');
      expect(run.stdout).toBe(payload);
      expect(existsSync(marker)).toBe(false);
      expect(await cardStore.getCard(card.id)).toMatchObject({
        status: 'complete', resolution: 'completed',
      });
    });
  });

  test('uses fixed interpreter argv, validated cwd, and an immutable script revision', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const captured: ScriptSpawnInput[] = [];
      const script = await scriptStore.createEntry({
        name: 'snapshot', description: '', language: 'typescript',
        content: 'console.log("before")', projectDir: dir,
      });
      const service = new ScriptExecutionService({
        scriptStore,
        cardStore,
        spawn: (input) => {
          captured.push(input);
          return completedProcess('before');
        },
      });
      const plan = await service.prepareExecution({ scriptId: script.id });
      await scriptStore.updateEntry(script.id, {
        content: 'console.log("after")', language: 'python',
        projectDir: join(dir, 'missing-after-start'),
      });
      const card = await createTrackedCard(cardStore, plan);

      await service.startPreparedExecution(plan, card.id);
      const run = await service.waitForRun(plan.runId);

      expect(captured).toHaveLength(1);
      expect(captured[0].argv).toEqual(['bun', '-e', 'console.log("before")']);
      expect(captured[0].cwd).toBe(dir);
      expect(run).toMatchObject({
        language: 'typescript', cwd: dir, scriptRevision: plan.scriptRevision,
      });

      const python = await scriptStore.createEntry({
        name: 'python', description: '', language: 'python', content: 'print("fixed")', projectDir: dir,
      });
      const pythonPlan = await service.prepareExecution({ scriptId: python.id });
      const pythonCard = await createTrackedCard(cardStore, pythonPlan);
      await service.startPreparedExecution(pythonPlan, pythonCard.id);
      await service.waitForRun(pythonPlan.runId);
      expect(captured[1].argv).toEqual(['python3', '-c', 'print("fixed")']);
    });
  });

  test('rejects unsupported languages and cwd values that are missing or not directories', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const filePath = join(dir, 'not-a-directory');
      writeFileSync(filePath, 'file');
      const script = await scriptStore.createEntry({
        name: 'invalid', description: '', language: 'zsh', content: 'echo no', projectDir: dir,
      });
      const service = new ScriptExecutionService({ scriptStore, cardStore });

      await expect(service.prepareExecution({ scriptId: script.id }))
        .rejects.toThrow('Unsupported script language: zsh');
      await scriptStore.updateEntry(script.id, { language: 'bash' });
      await expect(service.prepareExecution({ scriptId: script.id, cwdOverride: filePath }))
        .rejects.toThrow('Script cwd is not a valid directory');
      await expect(service.prepareExecution({ scriptId: script.id, cwdOverride: join(dir, 'missing') }))
        .rejects.toThrow('Script cwd is not a valid directory');
    });
  });

  test('injects settings, redacts secrets everywhere, and caps stdout/stderr by bytes', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const settingsStore = new SettingsStore(dir);
      const cardStore = new KanbanStore(dir);
      await settingsStore.createEntry({
        key: 'DEPLOY_ENV', value: 'production', description: 'environment', masked: false,
      });
      await settingsStore.createEntry({
        key: 'DEPLOY_SECRET', value: 'settings-secret', description: 'secret',
      });
      const script = await scriptStore.createEntry({
        name: 'redact', description: '', language: 'bash',
        content: 'ignored by injected spawn', projectDir: dir,
      });
      let receivedEnv: Record<string, string> = {};
      const service = new ScriptExecutionService({
        scriptStore,
        settingsStore,
        cardStore,
        spawn: (input) => {
          receivedEnv = input.env;
          const output = `settings-secret parameter-secret ${'x'.repeat(8148)} parameter-secret ${'z'.repeat(100)}`;
          return completedProcess(output, 'parameter-secret stderr');
        },
      });
      const plan = await service.prepareExecution({
        scriptId: script.id,
        parameterValues: { token: 'parameter-secret' },
        secretParameterKeys: new Set(['token']),
      });
      const card = await createTrackedCard(cardStore, plan);

      await service.startPreparedExecution(plan, card.id);
      const run = await service.waitForRun(plan.runId);
      const completedCard = await cardStore.getCard(card.id);

      expect(receivedEnv).toMatchObject({
        DEPLOY_ENV: 'production',
        DEPLOY_SECRET: 'settings-secret',
        AK_PARAM_TOKEN: 'parameter-secret',
      });
      expect(run.stdout).toContain('(truncated)');
      expect(run.stdout).not.toContain('settings-secret');
      expect(run.stdout).not.toContain('parameter-secret');
      expect(run.stdout).not.toContain('parameter-se');
      expect(Buffer.byteLength(run.stdout!.replace('\n... (truncated)', ''), 'utf8')).toBeLessThanOrEqual(8192);
      expect(run.stderr).toBe('[REDACTED] stderr');
      expect(JSON.stringify(run)).not.toContain('settings-secret');
      expect(JSON.stringify(run)).not.toContain('parameter-secret');
      expect(JSON.stringify(completedCard)).not.toContain('settings-secret');
      expect(JSON.stringify(completedCard)).not.toContain('parameter-secret');
    });
  });

  test('records spawn and nonzero failures as terminal failed cards without advancing queue', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const dispatched: string[] = [];
      const scripts = await Promise.all([
        scriptStore.createEntry({ name: 'spawn-fail', description: '', content: 'exit', projectDir: dir }),
        scriptStore.createEntry({ name: 'exit-fail', description: '', content: 'exit 9', projectDir: dir }),
      ]);
      let spawnCount = 0;
      const service = new ScriptExecutionService({
        scriptStore,
        cardStore,
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          return { sessionId: 'session', runId: 'runtime', startedAt: new Date().toISOString() };
        },
        spawn: (input) => {
          spawnCount += 1;
          if (spawnCount === 1) throw new Error(`spawn exploded ${input.env.AK_PARAM_TOKEN}`);
          return completedProcess('', 'deployment failed', 9);
        },
      });

      for (const [index, script] of scripts.entries()) {
        const plan = await service.prepareExecution({
          scriptId: script.id,
          ...(index === 0
            ? {
              parameterValues: { token: 'spawn-secret' },
              secretParameterKeys: new Set(['token']),
            }
            : {}),
        });
        const card = await createTrackedCard(cardStore, plan);
        const queued = await cardStore.createCard({
          title: `queued-${index}`, description: 'must stay queued',
        });
        await cardStore.updateCard(queued.id, {
          queuedAfterCardId: card.id, queuePosition: 1, queueSessionMode: 'new_session',
        });
        await service.startPreparedExecution(plan, card.id);
        const run = await service.waitForRun(plan.runId);
        const failedCard = await cardStore.getCard(card.id);
        expect(run.status).toBe('fail');
        expect(failedCard).toMatchObject({ status: 'complete', resolution: 'failed' });
        expect(failedCard?.result).toContain('[failed]');
        if (index === 0) {
          expect(run.error).toContain('spawn exploded [REDACTED]');
          expect(JSON.stringify(failedCard)).not.toContain('spawn-secret');
        }
        else expect(run).toMatchObject({ exitCode: 9, error: 'Script exited with code 9' });
      }

      expect(dispatched).toEqual([]);
    });
  });

  test('advances exactly one queued card only after success', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const dispatched: string[] = [];
      const script = await scriptStore.createEntry({
        name: 'success', description: '', content: 'true', projectDir: dir,
      });
      const service = new ScriptExecutionService({
        scriptStore,
        cardStore,
        spawn: () => completedProcess('deployed'),
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          return { sessionId: 'session', runId: 'runtime', startedAt: new Date().toISOString() };
        },
      });
      const plan = await service.prepareExecution({ scriptId: script.id });
      const card = await createTrackedCard(cardStore, plan);
      const first = await cardStore.createCard({ title: 'first', description: '' });
      await cardStore.updateCard(first.id, { queuedAfterCardId: card.id, queuePosition: 1 });
      const second = await cardStore.createCard({ title: 'second', description: '' });
      await cardStore.updateCard(second.id, { queuedAfterCardId: card.id, queuePosition: 2 });

      await service.startPreparedExecution(plan, card.id);
      await service.waitForRun(plan.runId);

      expect(dispatched).toEqual([first.id]);
    });
  });

  test('guards concurrent runs and reconciles orphan running records after restart', async () => {
    await withTempDir(async (dir) => {
      const scriptStore = new ScriptStore(dir);
      const cardStore = new KanbanStore(dir);
      const script = await scriptStore.createEntry({
        name: 'long-running', description: '', content: 'deploy', projectDir: dir,
      });
      let release!: (exitCode: number) => void;
      const exited = new Promise<number>((resolve) => { release = resolve; });
      const service = new ScriptExecutionService({
        scriptStore,
        cardStore,
        spawn: () => ({ stdout: stream(''), stderr: stream(''), exited }),
      });
      const plan = await service.prepareExecution({ scriptId: script.id });
      const card = await createTrackedCard(cardStore, plan);
      await service.startPreparedExecution(plan, card.id);

      await expect(scriptStore.deleteEntry(script.id)).rejects.toThrow('Script entry is running');
      const observer = new ScriptExecutionService({ scriptStore, cardStore });
      expect(await observer.initialize()).toBe(0);
      await expect(service.prepareExecution({ scriptId: script.id }))
        .rejects.toBeInstanceOf(ScriptExecutionConflictError);
      release(0);
      await service.waitForRun(plan.runId);

      const orphanCard = await cardStore.createCard({
        title: 'orphan', description: '', executionKind: 'script', scriptRunId: 'orphan-run',
      });
      const orphan: ScriptRun = {
        id: 'orphan-run', scriptId: script.id, cardId: orphanCard.id,
        startedAt: new Date().toISOString(), status: 'running', language: 'bash',
        cwd: dir, scriptRevision: 'deadbeef',
      };
      await scriptStore.beginRun(script.id, orphan);
      await cardStore.updateCard(orphanCard.id, { status: 'in_progress' });

      const restarted = new ScriptExecutionService({ scriptStore, cardStore });
      const reconciled = await restarted.initialize();
      const recoveredRun = await scriptStore.getRun(script.id, orphan.id);
      const recoveredCard = await cardStore.getCard(orphanCard.id);

      expect(reconciled).toBe(1);
      expect(recoveredRun).toMatchObject({
        status: 'fail', error: 'Script execution was interrupted by a process restart',
      });
      expect(recoveredCard).toMatchObject({ status: 'complete', resolution: 'failed' });
    });
  });
});
