import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentRuntime } from '../../core/types';
import type { KanbanStore } from '../../core/store';
import { FileLock } from '../../core/filelock';
import { resolveDir } from '../../core/data-dir';
import { parseClaudeStreamLine } from './claude-stream-parser';
import type { ChildLinker } from './child-linker';
import { RuntimeDispatchError } from './types';
import { parseCodexJsonlLine } from './codex-jsonl-parser';
import { codexChildEvents } from './codex-child-events';

export type RuntimeRunStatus = 'starting' | 'running' | 'interrupted' | 'completed' | 'failed' | 'aborted';

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
  admissionClosed?: boolean;
  delegation?: {
    parentCardId: string; parentRunId: string; requestId: string; requestHash: string;
    claimed?: boolean;
  };
}

export type ManagedDelegationRuntime = 'claude' | 'codex';

/** Managed delegation only crosses runtimes: Claude → Codex and Codex → Claude. */
export function crossRuntimeTarget(parentRuntime: AgentRuntime): ManagedDelegationRuntime | undefined {
  if (parentRuntime === 'claude') return 'codex';
  if (parentRuntime === 'codex') return 'claude';
  return undefined;
}

/** Every assistant text block a delegated child run streamed, parsed in its own runtime's format. */
export async function readDelegationSegments(run: RuntimeRun): Promise<string[]> {
  const segments: string[] = [];
  if (!existsSync(run.eventsPath)) return segments;
  for (const line of (await Bun.file(run.eventsPath).text()).split('\n')) {
    if (run.runtime === 'claude') {
      const event = parseClaudeStreamLine(line);
      if (event?.type === 'assistant' && event.text) segments.push(event.text);
    } else {
      const event = parseCodexJsonlLine(line);
      if (event?.type === 'agent_message') segments.push(event.text);
    }
  }
  return segments;
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
  private readonly dataDir: string;
  private readonly rootDir: string;
  private readonly runsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.rootDir = join(this.dataDir, 'runtime-runs');
    this.runsPath = join(this.rootDir, 'runs.json');
    this.tmpPath = join(this.rootDir, '.runs.json.tmp');
    this.fileLock = new FileLock(join(this.rootDir, '.runs.json.lock'));
  }

  async createRun(input: CreateRunInput): Promise<RuntimeRun> {
    const run = this.newRun(input);
    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      state.runs.push(run);
      state.lastModified = run.startedAt;
      await this.saveUnsafe(state);
    });
    return run;
  }

  private newRun(input: CreateRunInput): RuntimeRun {
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

    return run;
  }

  async reserveDelegation(input: {
    parentCardId: string; parentRunId: string; requestId: string; requestHash: string; model: string;
    /** Expected child runtime; the parent run's runtime is authoritative and must cross to it. */
    childRuntime?: ManagedDelegationRuntime;
  }, createCard: (run: RuntimeRun) => Promise<void>): Promise<{ run: RuntimeRun; created: boolean }> {
    return this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      const existing = state.runs.find(r => r.delegation?.parentRunId === input.parentRunId
        && r.delegation.requestId === input.requestId);
      if (existing) {
        if (existing.delegation?.requestHash !== input.requestHash) {
          throw new RuntimeDispatchError('Delegation requestId was reused with different input', 409);
        }
        return { run: existing, created: false };
      }
      const parent = state.runs.find(r => r.runId === input.parentRunId);
      const childRuntime = parent ? crossRuntimeTarget(parent.runtime) : undefined;
      // A managed child never delegates again (no Claude↔Codex ping-pong chains), and only
      // the parent card's own live run may admit children.
      if (!parent || !childRuntime || parent.cardId !== input.parentCardId || parent.delegation
        || parent.status !== 'running' || parent.admissionClosed
        || (input.childRuntime && input.childRuntime !== childRuntime)) {
        throw new RuntimeDispatchError('Parent run is not accepting delegations', 409);
      }
      const run = this.newRun({ runtime: childRuntime, cardId: nanoid(), model: input.model, cwd: parent.cwd });
      run.delegation = { parentCardId: input.parentCardId, parentRunId: input.parentRunId,
        requestId: input.requestId, requestHash: input.requestHash };
      state.runs.push(run);
      state.lastModified = new Date().toISOString();
      await this.saveUnsafe(state);
      try {
        // Runtime reservation survives card deletion/purge and a crash before creation.
        await createCard(run);
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : 'Delegation card creation failed';
        run.finishedAt = new Date().toISOString();
        await this.saveUnsafe(state);
        throw error;
      }
      return { run, created: true };
    });
  }

  async claimDelegation(runId: string, enabled: () => Promise<boolean>): Promise<RuntimeRun | null> {
    return this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      const run = state.runs.find(r => r.runId === runId);
      if (!run?.delegation || run.status !== 'starting' || run.delegation.claimed) return null;
      if (!await enabled()) return null;
      run.delegation.claimed = true;
      await this.saveUnsafe(state);
      return run;
    });
  }

  async closeDelegationAdmission(runId: string): Promise<void> {
    await this.updateRun(runId, { admissionClosed: true });
  }

  async waitForDelegations(parentRunId: string): Promise<void> {
    while ((await this.listRuns()).some(r => r.delegation?.parentRunId === parentRunId
      && (r.status === 'starting' || r.status === 'running'))) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async updateRun(runId: string, input: Partial<Omit<RuntimeRun, 'runId'>>): Promise<RuntimeRun> {
    let updated: RuntimeRun | undefined;
    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      const index = state.runs.findIndex(run => run.runId === runId);
      if (index === -1) throw new Error(`Runtime run not found: ${runId}`);
      if (state.runs[index].delegation
        && !['starting', 'running'].includes(state.runs[index].status)) {
        updated = state.runs[index];
        return;
      }
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
    status: 'completed' | 'failed' | 'aborted';
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

  // Acquire the run lock before the board lock so no new run can be inserted
  // between checking the latest run and committing a conditional card update.
  async withLatestRun<T>(
    cardId: string,
    runId: string | undefined,
    commit: (run: RuntimeRun | undefined) => Promise<T>,
  ): Promise<T | undefined> {
    return this.withDualLock(async () => {
      const { runs } = await this.loadUnsafe();
      const latest = runs.findLast(run => run.cardId === cardId);
      if (latest?.runId === runId) return commit(latest);
    });
  }

  async reconcileStale(
    store: KanbanStore,
    childLinker?: ChildLinker,
    bootRuns?: RuntimeRun[],
  ): Promise<RuntimeRun[]> {
    const staleRuns: RuntimeRun[] = [];
    const activeIds = new Set((bootRuns ?? await this.listRuns())
      .filter(run => run.status === 'starting' || run.status === 'running')
      .map(run => run.runId));

    await this.withDualLock(async () => {
      const state = await this.loadUnsafe();
      for (const run of state.runs) {
        if (run.restartReconcilePending) {
          staleRuns.push({ ...run });
          continue;
        }
        if (!activeIds.has(run.runId)) continue;
        if (run.status !== 'starting' && run.status !== 'running') continue;
        if (run.delegation) {
          const now = new Date().toISOString();
          const committed = run.delegation
            ? await store.getCard(run.cardId, { includeArchived: true, includeDeleted: true }) : null;
          if (committed?.managedDelegation?.runId === run.runId
            && (committed.status === 'complete' || committed.status === 'done')) {
            // Card completion is the durable commit before the run terminal write.
            // A restart in that gap must not turn a committed success into failure.
            run.status = committed.resolution === 'completed' ? 'completed' : 'failed';
            run.finishedAt = committed.completedAt ?? now;
            run.error = run.status === 'completed' ? undefined : run.error ?? 'Delegation failed before restart';
            staleRuns.push({ ...run });
            continue;
          }
          run.status = 'failed';
          run.finishedAt = now;
          run.error = run.error ?? 'Runtime run was reconciled after restart';
        } else {
          // The monitor was lost. The runtime outcome is still unknown.
          run.status = 'interrupted';
          run.restartReconcilePending = true;
        }
        staleRuns.push({ ...run });
      }
      if (staleRuns.length > 0) {
        state.lastModified = new Date().toISOString();
        await this.saveUnsafe(state);
      }
    });

    for (const run of staleRuns) {
      if (run.delegation) {
        if (run.status === 'completed') continue;
        const segments = await readDelegationSegments(run);
        const card = await store.getCard(run.cardId);
        if (card) await store.updateCard(card.id, {
          status: 'complete', resolution: 'failed',
          result: segments.join('\n\n') || card.result || run.error,
          finalResult: segments.at(-1) || card.finalResult,
          progressSummary: `[failed] ${run.error}`, staleStatus: null, staleDetectedAt: null,
        }, run.runId);
        continue;
      }
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
      const state = JSON.parse(await Bun.file(this.runsPath).text()) as RuntimeRunState | null;
      if (!Array.isArray(state?.runs) || state.runs.some(run => !run?.runId || !run.cardId)) {
        throw new Error('Invalid runtime run store');
      }
      return state;
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
