import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  SchedulerEntry,
  SchedulerStoreState,
  SchedulerRun,
  CreateSchedulerInput,
  UpdateSchedulerInput,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

const MAX_HISTORY = 20;
const MAX_OUTPUT_BYTES = 8192; // 8KB cap for stdout/stderr

function capOutput(output: string | undefined): string | undefined {
  if (!output) return output;
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return output.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)';
}

export class SchedulerStore {
  private readonly dataDir: string;
  private readonly schedulersPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.schedulersPath = join(this.dataDir, 'schedulers.json');
    this.tmpPath = join(this.dataDir, '.schedulers.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.schedulers.json.lock'));
  }

  /**
   * Dual locking: in-process mutex + cross-process FileLock.
   */
  private async withDualLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this.lockPromise;
    this.lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;

    try {
      return await this.fileLock.withLock(fn);
    } finally {
      release!();
    }
  }

  async load(): Promise<SchedulerStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    if (existsSync(this.schedulersPath)) {
      const content = await Bun.file(this.schedulersPath).text();
      return JSON.parse(content) as SchedulerStoreState;
    }

    return this.defaultState();
  }

  async save(state: SchedulerStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.schedulersPath);
  }

  async createEntry(input: CreateSchedulerInput): Promise<SchedulerEntry> {
    const now = new Date().toISOString();
    const entry: SchedulerEntry = {
      id: nanoid(),
      name: input.name,
      description: input.description,
      cron: input.cron,
      cronDescription: input.cronDescription,
      timezone: input.timezone,
      status: 'active',
      action: input.action,
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.withDualLock(async () => {
      const state = await this.load();
      state.entries.push(entry);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });

    return entry;
  }

  async updateEntry(id: string, input: UpdateSchedulerInput): Promise<SchedulerEntry> {
    const now = new Date().toISOString();
    let updatedEntry: SchedulerEntry | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Scheduler entry not found: ${id}`);
      }
      state.entries[index] = {
        ...state.entries[index],
        ...input,
        updatedAt: now,
      };
      state.lastModified = now;
      await this.save(state);
      updatedEntry = state.entries[index];
    });

    return updatedEntry!;
  }

  async deleteEntry(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Scheduler entry not found: ${id}`);
      }
      state.entries = state.entries.filter(e => e.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async toggleEntry(id: string): Promise<SchedulerEntry> {
    let toggled: SchedulerEntry | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Scheduler entry not found: ${id}`);
      }
      const entry = state.entries[index];
      state.entries[index] = {
        ...entry,
        status: entry.status === 'active' ? 'inactive' : 'active',
        updatedAt: new Date().toISOString(),
      };
      state.lastModified = new Date().toISOString();
      await this.save(state);
      toggled = state.entries[index];
    });

    return toggled!;
  }

  async getEntry(id: string): Promise<SchedulerEntry | null> {
    const state = await this.load();
    return state.entries.find(e => e.id === id) ?? null;
  }

  async getEntries(): Promise<SchedulerEntry[]> {
    const state = await this.load();
    return state.entries;
  }

  async addRun(schedulerId: string, run: SchedulerRun): Promise<void> {
    // Cap stdout/stderr
    const cappedRun: SchedulerRun = {
      ...run,
      stdout: capOutput(run.stdout),
      stderr: capOutput(run.stderr),
    };

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === schedulerId);
      if (index === -1) return; // silently skip if entry was deleted

      const entry = state.entries[index];
      // Prepend (most recent first), cap at MAX_HISTORY
      entry.history = [cappedRun, ...entry.history].slice(0, MAX_HISTORY);
      entry.lastRunAt = cappedRun.startedAt;
      if (cappedRun.status !== 'running') {
        entry.lastRunStatus = cappedRun.status;
      }
      entry.updatedAt = new Date().toISOString();
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async updateNextRunAt(id: string, nextRunAt: string | undefined): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) return;
      state.entries[index].nextRunAt = nextRunAt;
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async getHistory(id: string): Promise<SchedulerRun[]> {
    const state = await this.load();
    const entry = state.entries.find(e => e.id === id);
    return entry?.history ?? [];
  }

  private defaultState(): SchedulerStoreState {
    return {
      version: 1,
      entries: [],
      lastModified: new Date().toISOString(),
    };
  }
}
