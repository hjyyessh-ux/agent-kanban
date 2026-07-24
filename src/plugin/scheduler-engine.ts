import { Cron } from 'croner';
import { nanoid } from 'nanoid';
import type { KanbanStore } from '../core/store';
import type { DispatchResult, SchedulerEntry, SchedulerRun } from '../core/types';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';

const MAX_STDOUT = 8192; // 8KB cap
const RELOAD_INTERVAL_MS = 10_000;

interface CronLike {
  stop(): void;
  nextRun(): Date | null;
}

interface ActiveJob {
  cron: CronLike;
  entryId: string;
}

interface ShellExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ShellExecutorInput {
  command: string;
  cwd?: string;
  env: Record<string, string>;
}

interface IntervalHandle {
  unref?: () => void;
}

interface TimerApi {
  setInterval(fn: () => void, delayMs: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

interface SchedulerEngineDeps {
  settingsStore?: SettingsStore;
  cardStore?: KanbanStore;
  dispatchFn?: (cardId: string) => Promise<DispatchResult>;
  now?: () => Date;
  createCron?: (
    expression: string,
    timezone: string,
    onTick: () => void,
    onError: (error: unknown) => void,
  ) => CronLike;
  executeShell?: (input: ShellExecutorInput) => Promise<ShellExecutionResult>;
  generateId?: () => string;
  timer?: TimerApi;
}

function defaultTimerApi(): TimerApi {
  return {
    setInterval(fn, delayMs) {
      return globalThis.setInterval(fn, delayMs) as IntervalHandle;
    },
    clearInterval(handle) {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

function defaultCreateCron(
  expression: string,
  timezone: string,
  onTick: () => void,
  onError: (error: unknown) => void,
): CronLike {
  return new Cron(expression, { timezone, catch: onError }, onTick);
}

/**
 * SchedulerEngine manages cron jobs in-process.
 * Bash commands run via Bun.spawn (no LLM, no token cost).
 * Mirrors ServerMonitor lifecycle: start() → tick → stop().
 */
export class SchedulerEngine {
  private readonly store: SchedulerStore;
  private cardStore?: KanbanStore;
  private readonly jobs = new Map<string, ActiveJob>();
  private started = false;
  private readonly settingsStore?: SettingsStore;
  private dispatchFn?: (cardId: string) => Promise<DispatchResult>;
  private readonly now: () => Date;
  private readonly createCron: NonNullable<SchedulerEngineDeps['createCron']>;
  private readonly executeShellFn?: SchedulerEngineDeps['executeShell'];
  private readonly generateId: () => string;
  private readonly timer: TimerApi;
  private runtimeOwner = true;
  private reloadIntervalId: IntervalHandle | null = null;

  constructor(store: SchedulerStore, deps: SettingsStore | SchedulerEngineDeps = {}) {
    this.store = store;
    if (deps instanceof SettingsStore) {
      this.settingsStore = deps;
      this.now = () => new Date();
      this.createCron = defaultCreateCron;
      this.generateId = () => nanoid();
      this.timer = defaultTimerApi();
      return;
    }

    this.settingsStore = deps.settingsStore;
    this.cardStore = deps.cardStore;
    this.dispatchFn = deps.dispatchFn;
    this.now = deps.now ?? (() => new Date());
    this.createCron = deps.createCron ?? defaultCreateCron;
    this.executeShellFn = deps.executeShell;
    this.generateId = deps.generateId ?? (() => nanoid());
    this.timer = deps.timer ?? defaultTimerApi();
  }

  setPromptDispatcher(cardStore: KanbanStore, dispatchFn: (cardId: string) => Promise<DispatchResult>): void {
    this.cardStore = cardStore;
    this.dispatchFn = dispatchFn;
  }

  setRuntimeOwner(runtimeOwner: boolean): void {
    this.runtimeOwner = runtimeOwner;

    if (!runtimeOwner) {
      this.stopReloadLoop();
      for (const [, job] of this.jobs) {
        job.cron.stop();
      }
      this.jobs.clear();
    }
  }

  /**
   * Start all active schedulers from persistence.
   * Non-blocking — schedules cron jobs and returns immediately.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.runtimeOwner) return;

    this.startReloadLoop();

    const entries = await this.store.getEntries();
    for (const entry of entries) {
      if (entry.status === 'active') {
        this.scheduleEntry(entry);
      }
    }
  }

  /**
   * Stop all active cron jobs. Called on process exit.
   */
  stop(): void {
    this.stopReloadLoop();
    for (const [, job] of this.jobs) {
      job.cron.stop();
    }
    this.jobs.clear();
    this.started = false;
  }

  /**
   * Schedule a single entry. If already scheduled, reschedule.
   */
  scheduleEntry(entry: SchedulerEntry): void {
    if (!this.runtimeOwner) return;
    // Stop existing job if any
    this.unscheduleEntry(entry.id);

    if (entry.status !== 'active') return;

    try {
      const cron = this.createCron(
        entry.cron,
        entry.timezone,
        () => {
          void this.executeEntry(entry.id);
        },
        (err: unknown) => {
          const startedAt = this.now().toISOString();
          const errorMsg = err instanceof Error ? err.message : String(err);
          void this.recordRun(entry.id, {
            id: this.generateId(),
            schedulerId: entry.id,
            startedAt,
            finishedAt: startedAt,
            status: 'fail',
            error: `Cron error: ${errorMsg}`,
          });
        },
      );

      this.jobs.set(entry.id, { cron, entryId: entry.id });

      // Update nextRunAt
      const nextRun = cron.nextRun();
      if (nextRun) {
        void this.store.updateNextRunAt(entry.id, nextRun.toISOString());
      }
    } catch {
      // Invalid cron expression — mark as inactive
      void this.store.updateEntry(entry.id, { status: 'inactive' });
    }
  }

  /**
   * Unschedule a single entry.
   */
  unscheduleEntry(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.cron.stop();
      this.jobs.delete(id);
    }
  }

  /**
   * Execute a scheduler entry's action immediately.
   * Used both by cron trigger and manual "run now" API.
   */
  async executeEntry(id: string): Promise<SchedulerRun> {
    const entry = await this.store.getEntry(id);
    if (!entry) {
      throw new Error(`Scheduler entry not found: ${id}`);
    }

    const run: SchedulerRun = {
      id: this.generateId(),
      schedulerId: id,
      startedAt: this.now().toISOString(),
      status: 'running',
    };

    try {
      if (entry.action.type === 'bash') {
        const result = await this.executeShell(entry.action.command, entry.action.cwd);
        run.exitCode = result.exitCode;
        run.stdout = result.stdout;
        run.stderr = result.stderr;
        run.status = result.exitCode === 0 ? 'success' : 'fail';
      } else if (entry.action.type === 'prompt') {
        await this.executePromptEntry(entry, run);
      }
    } catch (err: unknown) {
      run.status = 'fail';
      run.error = err instanceof Error ? err.message : String(err);
    }

    run.finishedAt = this.now().toISOString();
    await this.recordRun(id, run);

    // Update nextRunAt
    const job = this.jobs.get(id);
    if (job) {
      const nextRun = job.cron.nextRun();
      void this.store.updateNextRunAt(id, nextRun?.toISOString());
    }

    return run;
  }

  /**
   * Execute a bash command via Bun.spawn.
   * Returns captured stdout, stderr, and exit code.
   */
  private async executeShell(command: string, cwd?: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (!command.trim()) {
      return { exitCode: 1, stdout: '', stderr: 'Empty command' };
    }

    // Inject settings as environment variables
    let settingsEnv: Record<string, string> = {};
    if (this.settingsStore) {
      try {
        const entries = await this.settingsStore.getEntries();
        for (const entry of entries) {
          settingsEnv[entry.key] = entry.value;
        }
      } catch {
        // Settings unavailable — continue without them
      }
    }

    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...settingsEnv }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    if (this.executeShellFn) {
      return this.executeShellFn({
        command,
        cwd,
        env,
      });
    }

    const proc = Bun.spawn(['bash', '-lc', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      cwd,
    });

    const stdoutReader = new Response(proc.stdout).text();
    const stderrReader = new Response(proc.stderr).text();
    const [stdoutText, stderrText] = await Promise.all([stdoutReader, stderrReader]);
    const exitCode = await proc.exited;

    return {
      exitCode,
      stdout: stdoutText.length > MAX_STDOUT
        ? stdoutText.slice(0, MAX_STDOUT) + '\n... (truncated)'
        : stdoutText,
      stderr: stderrText.length > MAX_STDOUT
        ? stderrText.slice(0, MAX_STDOUT) + '\n... (truncated)'
        : stderrText,
    };
  }

  private async executePromptEntry(entry: SchedulerEntry, run: SchedulerRun): Promise<void> {
    if (entry.action.type !== 'prompt') {
      throw new Error(`Scheduler action is not prompt: ${entry.action.type}`);
    }
    if (entry.action.editState === 'edit-required') {
      run.dispatched = false;
      run.status = 'fail';
      run.error = 'Prompt scheduler needs manual editing before it can be dispatched safely.';
      return;
    }
    if (!this.cardStore || !this.dispatchFn) {
      run.dispatched = false;
      run.status = 'fail';
      run.error = 'Prompt scheduler dispatch is unavailable in this runtime.';
      return;
    }

    const card = await this.cardStore.createCard({
      title: entry.name,
      description: entry.action.prompt,
      projectDir: entry.action.projectDir,
      agentRuntime: entry.action.agentRuntime,
      model: entry.action.model,
      codexOptions: entry.action.codexOptions,
      claudeOptions: entry.action.claudeOptions,
      originChannel: 'scheduler',
      schedulerId: entry.id,
      schedulerRunId: run.id,
      schedulerName: entry.name,
    });
    run.cardId = card.id;

    try {
      const result = await this.dispatchFn(card.id);
      run.dispatched = true;
      run.dispatchAcceptedAt = result.startedAt;
      run.status = 'success';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.dispatched = false;
      run.status = 'fail';
      run.error = message;
      await this.cardStore.updateCard(card.id, {
        status: 'todo',
        progressSummary: `[failed] ${message}`,
        staleStatus: null,
        staleDetectedAt: null,
      });
    }
  }

  /**
   * Record a run in the entry's history.
   */
  private async recordRun(schedulerId: string, run: SchedulerRun): Promise<void> {
    await this.store.addRun(schedulerId, run);
  }

  /**
   * Get next run time for an entry.
   */
  getNextRunAt(id: string): Date | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return job.cron.nextRun();
  }

  /**
   * Check if an entry is currently scheduled.
   */
  isScheduled(id: string): boolean {
    return this.jobs.has(id);
  }

  /**
   * Reload all entries from store (after external changes).
   */
  async reload(): Promise<void> {
    if (!this.runtimeOwner) return;
    // Stop all existing jobs
    for (const [, job] of this.jobs) {
      job.cron.stop();
    }
    this.jobs.clear();

    // Reload from store
    const entries = await this.store.getEntries();
    for (const entry of entries) {
      if (entry.status === 'active') {
        this.scheduleEntry(entry);
      }
    }
  }

  private startReloadLoop(): void {
    if (this.reloadIntervalId) return;

    this.reloadIntervalId = this.timer.setInterval(() => {
      if (!this.started || !this.runtimeOwner) return;
      this.reload().catch(() => {});
    }, RELOAD_INTERVAL_MS);
    this.reloadIntervalId.unref?.();
  }

  private stopReloadLoop(): void {
    if (!this.reloadIntervalId) return;
    this.timer.clearInterval(this.reloadIntervalId);
    this.reloadIntervalId = null;
  }
}
