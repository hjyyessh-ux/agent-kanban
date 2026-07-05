import { Cron } from 'croner';
import { nanoid } from 'nanoid';
import type { SchedulerEntry, SchedulerRun } from '../core/types';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';

const MAX_STDOUT = 8192; // 8KB cap
const RELOAD_INTERVAL_MS = 10_000;

interface ActiveJob {
  cron: Cron;
  entryId: string;
}

/**
 * SchedulerEngine manages cron jobs in-process.
 * Shell commands run via Bun.spawn (no LLM, no token cost).
 * Mirrors ServerMonitor lifecycle: start() → tick → stop().
 */
export class SchedulerEngine {
  private readonly store: SchedulerStore;
  private readonly jobs = new Map<string, ActiveJob>();
  private started = false;
  private readonly settingsStore?: SettingsStore;
  private runtimeOwner = true;
  private reloadIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(store: SchedulerStore, settingsStore?: SettingsStore) {
    this.store = store;
    this.settingsStore = settingsStore;
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
      const cron = new Cron(entry.cron, {
        timezone: entry.timezone,
        catch: (err: unknown) => {
          // Cron error handler — log to history
          const errorMsg = err instanceof Error ? err.message : String(err);
          void this.recordRun(entry.id, {
            id: nanoid(),
            schedulerId: entry.id,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            status: 'fail',
            error: `Cron error: ${errorMsg}`,
          });
        },
      }, () => {
        void this.executeEntry(entry.id);
      });

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
      id: nanoid(),
      schedulerId: id,
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    try {
      if (entry.action.type === 'shell') {
        const result = await this.executeShell(entry.action.command ?? '');
        run.exitCode = result.exitCode;
        run.stdout = result.stdout;
        run.stderr = result.stderr;
        run.status = result.exitCode === 0 ? 'success' : 'fail';
      } else if (entry.action.type === 'skill') {
        // Skill execution produces a warning — skills always require LLM
        run.status = 'fail';
        run.error = 'Skill execution requires LLM invocation (token cost). Use plugin tools to invoke skills.';
      }
    } catch (err: unknown) {
      run.status = 'fail';
      run.error = err instanceof Error ? err.message : String(err);
    }

    run.finishedAt = new Date().toISOString();
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
   * Execute a shell command via Bun.spawn.
   * Returns captured stdout, stderr, and exit code.
   */
  private async executeShell(command: string): Promise<{
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

    const proc = Bun.spawn(['sh', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...settingsEnv },
    });

    // Read output with cap
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

    this.reloadIntervalId = setInterval(() => {
      if (!this.started || !this.runtimeOwner) return;
      this.reload().catch(() => {});
    }, RELOAD_INTERVAL_MS);

    if (this.reloadIntervalId && typeof this.reloadIntervalId === 'object' && 'unref' in this.reloadIntervalId) {
      (this.reloadIntervalId as NodeJS.Timeout).unref();
    }
  }

  private stopReloadLoop(): void {
    if (!this.reloadIntervalId) return;
    clearInterval(this.reloadIntervalId);
    this.reloadIntervalId = null;
  }
}
