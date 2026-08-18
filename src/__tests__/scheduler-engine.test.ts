import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';
import { SchedulerEngine } from '../plugin/scheduler-engine';
import { withTempDir } from './setup';

function createManualTimer() {
  const callbacks = new Set<() => void>();
  const handles = new Map<object, () => void>();
  return {
    timer: {
      setInterval(fn: () => void) {
        callbacks.add(fn);
        const handle = { unref() {} };
        handles.set(handle, fn);
        return handle;
      },
      clearInterval(handle: object) {
        const fn = handles.get(handle);
        if (!fn) return;
        callbacks.delete(fn);
        handles.delete(handle);
      },
    },
  };
}

function createFakeCron() {
  let onTick: (() => void) | null = null;
  let nextRun: Date | null = new Date('2026-07-17T01:00:00.000Z');
  return {
    factory(_expression: string, _timezone: string, tick: () => void) {
      onTick = tick;
      return {
        stop() {},
        nextRun() {
          return nextRun;
        },
      };
    },
    fire() {
      onTick?.();
    },
    setNextRun(value: Date | null) {
      nextRun = value;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForSchedulerHistoryCount(
  store: SchedulerStore,
  schedulerId: string,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const history = await store.getHistory(schedulerId);
    if (history.length === expectedCount) {
      return;
    }
    await Bun.sleep(0);
  }
  throw new Error(`Timed out waiting for scheduler history count ${expectedCount}`);
}

describe('SchedulerEngine', () => {
  test('bash runs receive settings env, cwd, and persisted output/exit code', async () => {
    await withTempDir(async (dir) => {
      const schedulerStore = new SchedulerStore(dir);
      const settingsStore = new SettingsStore(dir);
      await settingsStore.createEntry({
        key: 'API_TOKEN',
        value: 'secret',
        description: 'token',
      });
      await settingsStore.createEntry({
        key: 'PATH',
        value: '/attacker/bin',
        description: 'reserved',
      });

      const entry = await schedulerStore.createEntry({
        name: 'Bash',
        description: 'run bash',
        cron: '*/5 * * * *',
        action: { type: 'bash', command: 'pwd', cwd: '/repo' },
      });

      let receivedEnv: Record<string, string> | undefined;
      let receivedCwd: string | undefined;
      const engine = new SchedulerEngine(schedulerStore, {
        settingsStore,
        executeShell: async ({ env, cwd }) => {
          receivedEnv = env;
          receivedCwd = cwd;
          return {
            exitCode: 7,
            stdout: `secret:${'x'.repeat(9000)}`,
            stderr: 'secret stderr line',
          };
        },
      });

      const run = await engine.executeEntry(entry.id);
      const history = await schedulerStore.getHistory(entry.id);

      expect(receivedEnv?.API_TOKEN).toBe('secret');
      expect(receivedEnv?.PATH).not.toBe('/attacker/bin');
      expect(receivedCwd).toBe('/repo');
      expect(run.exitCode).toBe(7);
      expect(run.status).toBe('fail');
      expect(history[0].stdout?.length).toBe(8192 + '\n... (truncated)'.length);
      expect(history[0].stdout).not.toContain('secret');
      expect(history[0].stderr).toBe('[REDACTED] stderr line');
      expect(history[0].error).toBeUndefined();
    });
  });

  test('prompt runs create scheduler-origin cards and track dispatch acceptance by cardId', async () => {
    await withTempDir(async (dir) => {
      const schedulerStore = new SchedulerStore(dir);
      const cardStore = new KanbanStore(dir);
      const entry = await schedulerStore.createEntry({
        name: 'Morning sync',
        description: 'run prompt',
        cron: '0 9 * * *',
        action: {
          type: 'prompt',
          prompt: 'Summarize the backlog',
          projectDir: dir,
          agentRuntime: 'codex',
          model: 'gpt-5',
        },
      });

      const dispatched: string[] = [];
      const engine = new SchedulerEngine(schedulerStore, {
        cardStore,
        dispatchFn: async (cardId) => {
          dispatched.push(cardId);
          return { sessionId: 'thread-1', runId: 'runtime-run-1', startedAt: '2026-07-17T00:00:10.000Z' };
        },
        generateId: () => 'scheduler-run-1',
      });

      const run = await engine.executeEntry(entry.id);
      const card = await cardStore.getCard(run.cardId!);

      expect(run.status).toBe('success');
      expect(run.cardId).toBeTruthy();
      expect(run.dispatchAcceptedAt).toBe('2026-07-17T00:00:10.000Z');
      expect(dispatched).toEqual([run.cardId!]);
      expect(card).toMatchObject({
        title: 'Morning sync',
        description: 'Summarize the backlog',
        originChannel: 'scheduler',
        schedulerId: entry.id,
        schedulerRunId: 'scheduler-run-1',
        schedulerName: 'Morning sync',
        projectDir: dir,
        agentRuntime: 'codex',
        model: 'gpt-5',
      });
    });
  });

  test('prompt dispatch failures leave the created card in todo with a failed summary', async () => {
    await withTempDir(async (dir) => {
      const schedulerStore = new SchedulerStore(dir);
      const cardStore = new KanbanStore(dir);
      const entry = await schedulerStore.createEntry({
        name: 'Broken prompt',
        description: 'run prompt',
        cron: '0 9 * * *',
        action: {
          type: 'prompt',
          prompt: 'Do the thing',
        },
      });

      const engine = new SchedulerEngine(schedulerStore, {
        cardStore,
        dispatchFn: async () => {
          throw new Error('dispatch exploded');
        },
        generateId: () => 'scheduler-run-2',
      });

      const run = await engine.executeEntry(entry.id);
      const card = await cardStore.getCard(run.cardId!);

      expect(run.status).toBe('fail');
      expect(run.error).toBe('dispatch exploded');
      expect(card?.status).toBe('todo');
      expect(card?.progressSummary).toBe('[failed] dispatch exploded');
    });
  });

  test('cron tick and manual execution keep distinct run-to-card links', async () => {
    await withTempDir(async (dir) => {
      const schedulerStore = new SchedulerStore(dir);
      const cardStore = new KanbanStore(dir);
      const entry = await schedulerStore.createEntry({
        name: 'Concurrent prompt',
        description: 'run prompt',
        cron: '*/5 * * * *',
        action: {
          type: 'prompt',
          prompt: 'Create linked card',
        },
      });

      const ids = ['run-cron', 'run-manual'];
      const cron = createFakeCron();
      const timer = createManualTimer();
      const gate = createDeferred<void>();
      const engine = new SchedulerEngine(schedulerStore, {
        cardStore,
        dispatchFn: async () => {
          await gate.promise;
          return { sessionId: 'session', runId: 'runtime', startedAt: '2026-07-17T00:00:20.000Z' };
        },
        createCron: cron.factory,
        timer: timer.timer,
        generateId: () => ids.shift() ?? 'run-extra',
      });

      engine.start();
      engine.scheduleEntry(entry);
      cron.fire();
      const manualPromise = engine.executeEntry(entry.id);
      await Promise.resolve();
      gate.resolve();
      await manualPromise;
      await waitForSchedulerHistoryCount(schedulerStore, entry.id, 2);

      const history = await schedulerStore.getHistory(entry.id);
      const cardIds = history.map((run) => run.cardId).filter((value): value is string => Boolean(value));
      const cards = await Promise.all(cardIds.map((cardId) => cardStore.getCard(cardId)));

      expect(cardIds).toHaveLength(2);
      expect(new Set(cardIds).size).toBe(2);
      expect(history.map((run) => run.id)).toEqual(['run-manual', 'run-cron']);
      expect(cards[0]?.schedulerRunId).toBe('run-manual');
      expect(cards[1]?.schedulerRunId).toBe('run-cron');

      engine.stop();
    });
  });
});
