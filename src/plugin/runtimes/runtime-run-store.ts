import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentRuntime } from '../../core/types';
import type { KanbanStore } from '../../core/store';
import { FileLock } from '../../core/filelock';
import { resolveDir } from '../../core/data-dir';
import { parseClaudeStreamLine } from './claude-stream-parser';
import type { ChildLinker } from './child-linker';
import { parseCodexJsonlLine } from './codex-jsonl-parser';
import { codexChildEvents } from './codex-child-events';

export type RuntimeRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'aborted';

export interface RuntimeRun {
  runId: string;
  cardId: string;
  runtime: AgentRuntime;
  sessionId?: string;
  pid?: number;
  status: RuntimeRunStatus;
  startedAt: string;
  finishedAt?: string;
  restartReconcilePending?: boolean;
  exitCode?: number;
  model?: string;
  cwd: string;
  promptPath: string;
  eventsPath: string;
  stderrPath: string;
  lastMessagePath: string;
  error?: string;
}

interface RuntimeRunState {
  version: 1;
  runs: RuntimeRun[];
  lastModified: string;
}

interface CreateRunInput {
  cardId: string;
  runtime: AgentRuntime;
  sessionId?: string;
  model?: string;
  cwd: string;
}

export class RuntimeRunStore {
  private readonly rootDir: string;
  private readonly runsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.rootDir = join(resolveDir(dataDir), 'runtime-runs');
    this.runsPath = join(this.rootDir, 'runs.json');
    this.tmpPath = join(this.rootDir, '.runs.json.tmp');
    this.fileLock = new FileLock(join(this.rootDir, '.runs.json.lock'));
  }

  async createRun(input: CreateRunInput): Promise<RuntimeRun> {
    const runId = `${input.runtime}-${Date.now()}-${nanoid(8)}`;
    const runDir = this.getRunDir(runId);
    mkdirSync(runDir, { recursive: true });
    const run: RuntimeRun = {
      runId,
      cardId: input.cardId,
      runtime: input.runtime,
      sessionId: input.sessionId,
      status: 'starting',
      startedAt: new Date().toISOString(),
      model: input.model,
      cwd: input.cwd,
      promptPath: join(runDir, 'prompt.md'),
      eventsPath: join(runDir, 'events.jsonl'),
      stderrPath: join(runDir, 'stderr.log'),
      lastMessagePath: join(runDir, 'last-message.md'),
    };

    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      state.runs.push(run);
      state.lastModified = new Date().toISOString();
      await this.saveUnsafe(state);
    });

    return run;
  }

  async updateRun(runId: string, input: Partial<Omit<RuntimeRun, 'runId'>>): Promise<RuntimeRun> {
    let updated: RuntimeRun | undefined;
    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      const index = state.runs.findIndex(run => run.runId === runId);
      if (index === -1) throw new Error(`Runtime run not found: ${runId}`);
      state.runs[index] = {
        ...state.runs[index],
        ...input,
      };
      state.lastModified = new Date().toISOString();
      await this.saveUnsafe(state);
      updated = state.runs[index];
    });
    return updated!;
  }

  async finishRun(runId: string, input: {
    status: Exclude<RuntimeRunStatus, 'starting' | 'running'>;
    exitCode?: number;
    error?: string;
  }): Promise<RuntimeRun> {
    return this.updateRun(runId, {
      status: input.status,
      exitCode: input.exitCode,
      error: input.error,
      finishedAt: new Date().toISOString(),
    });
  }

  async getRun(runId: string): Promise<RuntimeRun | null> {
    const state = await this.loadUnsafe();
    return state.runs.find(run => run.runId === runId) ?? null;
  }

  async listRuns(): Promise<RuntimeRun[]> {
    const state = await this.loadUnsafe();
    return state.runs;
  }

  async findActiveRunByCard(cardId: string): Promise<RuntimeRun | undefined> {
    const state = await this.loadUnsafe();
    return state.runs.find(run =>
      run.cardId === cardId && (run.status === 'starting' || run.status === 'running')
    );
  }

  async findActiveRunBySession(sessionId: string): Promise<RuntimeRun | undefined> {
    const state = await this.loadUnsafe();
    return state.runs.find(run =>
      run.sessionId === sessionId && (run.status === 'starting' || run.status === 'running')
    );
  }

  async reconcileStale(store: KanbanStore, childLinker?: ChildLinker): Promise<RuntimeRun[]> {
    const staleRuns: RuntimeRun[] = [];
    const now = new Date().toISOString();

    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      for (const run of state.runs) {
        if (run.restartReconcilePending) {
          staleRuns.push({ ...run });
          continue;
        }
        if (run.status !== 'starting' && run.status !== 'running') continue;
        run.restartReconcilePending = true;
        run.status = 'failed';
        run.finishedAt = now;
        run.error = run.error ?? 'Runtime run was reconciled after restart';
        staleRuns.push({ ...run });
      }
      if (staleRuns.length > 0) {
        state.lastModified = now;
        await this.saveUnsafe(state);
      }
    });

    for (const run of staleRuns) {
      // Step 1: Replay the runtime's recorded lifecycle before interrupted-child cleanup.
      if (childLinker && existsSync(run.eventsPath)) {
        try {
          const text = await Bun.file(run.eventsPath).text();
          let threadId = run.sessionId;
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (run.runtime === 'codex') {
              const event = parseCodexJsonlLine(line);
              if (!event) continue;
              if (event.type === 'thread_started') threadId ??= event.threadId;
              for (const child of codexChildEvents(event, threadId)) {
                await childLinker.onChildEvent(run.cardId, run.runId, child, 'codex');
              }
              continue;
            }
            if (run.runtime !== 'claude') continue;
            const event = parseClaudeStreamLine(line);
            if (event?.type === 'subagent_started' || event?.type === 'subagent_updated' || event?.type === 'subagent_completed') {
              await childLinker.onChildEvent(run.cardId, run.runId, event);
            }
          }
        } catch {
          // Keep the pending marker for the next boot; other runs may still recover.
          continue;
        }
      }

      // Step 2: Atomically close only this run's interrupted native children.
      try {
        await store.supersedeNativeChildren(run.cardId, run.runId, '[parent run reconciled after restart]');
      } catch {
        continue;
      }

      // Return the parent to todo only if this is still its newest run.
      const parentRuns = (await this.listRuns()).filter(candidate => candidate.cardId === run.cardId);
      const hasNewerRun = parentRuns.at(-1)?.runId !== run.runId;
      const card = await store.getCard(run.cardId);
      if (!hasNewerRun && card?.status === 'in_progress') {
        await store.updateCard(run.cardId, {
          status: 'todo',
          progressSummary: `[reconciled] ${run.runtime} run ${run.runId} was marked failed after restart`,
          staleStatus: null,
          staleDetectedAt: null,
        });
      }

      // If this process stops before completing replay, the next boot retries
      // the same idempotent child events instead of losing the linkage.
      await this.updateRun(run.runId, { restartReconcilePending: undefined });
    }

    return staleRuns;
  }

  getRunDir(runId: string): string {
    return join(this.rootDir, runId);
  }

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

  private async loadUnsafe(): Promise<RuntimeRunState> {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true });
    }
    if (existsSync(this.runsPath)) {
      return JSON.parse(await Bun.file(this.runsPath).text()) as RuntimeRunState;
    }
    return {
      version: 1,
      runs: [],
      lastModified: new Date().toISOString(),
    };
  }

  private async saveUnsafe(state: RuntimeRunState): Promise<void> {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.runsPath);
  }
}
