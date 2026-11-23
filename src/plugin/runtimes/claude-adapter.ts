import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import { buildClaudeAppendSystemPrompt, loadResponseGuidelines } from '../../core/response-guidelines';
import type { DispatchResult, UpdateCardInput } from '../../core/types';
import type { KanbanStore } from '../../core/store';
import { DEFAULT_CLAUDE_MODEL, isClaudeModelValid } from '../../core/runtime-config';
import { dispatchNextQueuedTodoCard } from '../hooks/event-handler';
import type { AgentAdapter, AdapterRunResult, AdapterStartInput, DispatchHandle } from './types';
import { captureGitEndAndUsage } from './git-capture';
import { RuntimeDispatchError } from './types';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { createClaudeBinaryResolver } from './claude-binary';
import { parseClaudeStreamLine } from './claude-stream-parser';
import { completeTrackedRuntimeCard, updateFailedRuntimeCard } from './runtime-restart-sync';
import { joinResultSegments, lastResultSegment } from './result-segments';
import type { ClaudeStreamEvent } from './claude-stream-parser';
import { withSpawnLock } from './spawn-lock';
import { notifyTelegramCompletion } from '../telegram-completion';

const DEFAULT_SESSION_ID_TIMEOUT_MS = 30_000;
export interface ClaudeAdapterDeps {
  store: KanbanStore;
  settingsStore: SettingsStore;
  runStore: RuntimeRunStore;
  dispatchFn?: (cardId: string) => Promise<DispatchResult>;
  commandOverride?: string[];
  sessionIdTimeoutMs?: number;
  onChildEvent?: (parentCardId: string, runId: string, ev: ClaudeStreamEvent) => Promise<void>;
  getApiUrl?: () => string | undefined;
}

interface ClaudeRunState {
  sessionId?: string;
  startupFailure?: string;
  // Every assistant text block seen this run, in order. Joined at completion
  // (see result-segments.ts) so mid-turn answers are not lost.
  resultSegments: string[];
  sessionResolved: boolean;
  resolveSession?: (sessionId: string) => void;
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps): AgentAdapter {
  const resolveClaudeBinary = createClaudeBinaryResolver({
    settingsStore: deps.settingsStore,
    commandOverride: deps.commandOverride,
  });
  const sessionIdTimeoutMs = deps.sessionIdTimeoutMs ?? DEFAULT_SESSION_ID_TIMEOUT_MS;

  return {
    runtime: 'claude',
    async start(input: AdapterStartInput): Promise<DispatchHandle> {
      return withSpawnLock(`runtime-card-${input.card.id}`, async () => {
        const sessionLockKey = input.resumeSessionId
          ? `runtime-session-${input.resumeSessionId}`
          : `runtime-new-session-${input.card.id}`;
        return withSpawnLock(sessionLockKey, () => startClaudeRun(deps, resolveClaudeBinary, sessionIdTimeoutMs, input));
      });
    },
  };
}

async function startClaudeRun(
  deps: ClaudeAdapterDeps,
  resolveClaudeBinary: () => Promise<string[]>,
  sessionIdTimeoutMs: number,
  input: AdapterStartInput,
): Promise<DispatchHandle> {
  const activeCardRun = await deps.runStore.findActiveRunByCard(input.card.id);
  if (input.card.managedDelegation && !input.reservedRun) {
    throw new RuntimeDispatchError('Managed delegations must use the delegation service', 409);
  }
  if (activeCardRun && activeCardRun.runId !== input.reservedRun?.runId) {
    throw new RuntimeDispatchError(`Card already has an active ${activeCardRun.runtime} run`, 409);
  }
  if (input.resumeSessionId) {
    const activeSessionRun = await deps.runStore.findActiveRunBySession(input.resumeSessionId);
    if (activeSessionRun) {
      throw new RuntimeDispatchError(`Session already has an active run: ${input.resumeSessionId}`, 409);
    }
  }

  const model = input.card.model && isClaudeModelValid(input.card.model)
    ? input.card.model
    : DEFAULT_CLAUDE_MODEL;
  // A Codex → Claude managed child runs on the run id the delegation service
  // persisted before spawn; it is never re-created here.
  const reserved = input.reservedRun ? await deps.runStore.getRun(input.reservedRun.runId) : null;
  if (input.reservedRun && (!reserved?.delegation?.claimed || reserved.status !== 'starting'
    || reserved.runtime !== 'claude' || reserved.cardId !== input.card.id
    || input.card.managedDelegation?.runId !== reserved.runId || input.resumeSessionId)) {
    throw new RuntimeDispatchError('Delegation reservation is not executable', 409);
  }
  const run = reserved ?? await deps.runStore.createRun({
    cardId: input.card.id,
    runtime: 'claude',
    sessionId: input.resumeSessionId,
    model,
    cwd: input.cwd,
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    await Bun.write(run.promptPath, input.prompt);
    await Bun.write(run.eventsPath, '');
    await Bun.write(run.stderrPath, '');

    const argv = await buildClaudeCommand(deps, resolveClaudeBinary, {
      model,
      resumeSessionId: input.resumeSessionId,
      permissionMode: input.card.claudeOptions?.permissionMode,
      dangerouslySkipPermissions: input.card.claudeOptions?.dangerouslySkipPermissions,
      effort: input.card.claudeOptions?.effort,
    });
    const apiUrl = deps.getApiUrl?.();
    proc = Bun.spawn(argv, {
      cwd: input.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        AGENT_KANBAN_DISPATCH_CARD_ID: input.card.id,
        AGENT_KANBAN_DISPATCH_RUN_ID: run.runId,
        ...(apiUrl ? { KANBAN_API_URL: apiUrl } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to spawn Claude';
    await deps.runStore.closeDelegationAdmission(run.runId);
    if (run.delegation) {
      await finalizeClaudeDelegation(deps, run, {
        status: 'complete', resolution: 'failed', result: message, progressSummary: `[failed] ${message}`,
      }, 'failed', message);
      const failure = new RuntimeDispatchError(message, 500);
      failure.cause = error;
      throw failure;
    }
    await deps.runStore.finishRun(run.runId, {
      status: 'failed',
      error: message,
    });
    await updateCardIfPresent(deps.store, input.card.id, {
      status: 'todo',
      progressSummary: `[failed] runId=${run.runId} ${message.slice(0, 500)}`,
      staleStatus: null, staleDetectedAt: null,
    });
    const failure = new RuntimeDispatchError(message, 500);
    failure.cause = error;
    throw failure;
  }

  const state: ClaudeRunState = {
    sessionId: input.resumeSessionId,
    resultSegments: [],
    sessionResolved: Boolean(input.resumeSessionId),
  };

  const sessionPromise = new Promise<string>((resolve) => {
    state.resolveSession = resolve;
    if (input.resumeSessionId) resolve(input.resumeSessionId);
  });

  // Like Codex delegated runs, a managed child does not mint its own native
  // child cards; restart recovery for managed runs replays only its output.
  const childEventCallback = deps.onChildEvent && !run.delegation
    ? async (ev: ClaudeStreamEvent) => {
        try {
          await deps.onChildEvent!(input.card.id, run.runId, ev);
        } catch {
          // swallow — child event failure must not abort the parent run
        }
      }
    : undefined;

  if (input.resumeSessionId) {
    await deps.store.updateCard(input.card.id, {
      status: 'in_progress',
      startedAt: run.startedAt,
      progressSummary: undefined,
      sessionId: input.resumeSessionId,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }

  const stdoutDone = readClaudeStdout(getReadableStream(proc.stdout), run, state, async (sessionId) => {
    if (state.sessionResolved || state.startupFailure !== undefined) return;
    state.sessionId = sessionId;
    state.sessionResolved = true;
    state.resolveSession?.(sessionId);
    await deps.runStore.updateRun(run.runId, { sessionId });
    await writeClaudeCard(deps, run, input.card.id, {
      status: 'in_progress',
      startedAt: run.startedAt,
      progressSummary: undefined,
      sessionId,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }, childEventCallback);
  const stderrDone = readClaudeStderr(getReadableStream(proc.stderr), run.stderrPath);
  let finishStartup!: () => void;
  const startupDone = new Promise<void>(resolve => { finishStartup = resolve; });
  const abort = () => proc.kill();
  const done = handleClaudeCompletion({
    deps,
    input,
    proc,
    run,
    state,
    stdoutDone,
    stderrDone,
    startupDone,
  }).finally(() => input.abortSignal?.removeEventListener('abort', abort));
  // Observe rejection immediately, while start still owns the process. The
  // original promise is returned on success so callers still see its failure.
  const settled = Promise.allSettled([done, stdoutDone, stderrDone]);

  try {
    await deps.runStore.updateRun(run.runId, { status: 'running', pid: proc.pid });
    const stdin = getWritableStdin(proc.stdin);
    stdin.write(input.prompt);
    stdin.end();
    input.abortSignal?.addEventListener('abort', abort, { once: true });
    if (input.abortSignal?.aborted) abort();

    if (input.resumeSessionId) {
      await deps.store.updateCard(input.card.id, {
        status: 'in_progress', sessionId: input.resumeSessionId, startedAt: run.startedAt, progressSummary: undefined,
        staleStatus: null, staleDetectedAt: null,
      });
    }
    const sessionId = await waitForSessionId({ sessionPromise, timeoutMs: sessionIdTimeoutMs });
    finishStartup();
    return { sessionId, runId: run.runId, startedAt: run.startedAt, abort, done };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start Claude';
    state.startupFailure = message;
    const failures: unknown[] = [];
    try { proc.kill(); } catch (failure) { failures.push(failure); }
    finishStartup();
    for (const completion of await settled) if (completion.status === 'rejected') failures.push(completion.reason);
    // Completion owns process/stream drain and admission closure. Only this
    // branch writes startup failure, after all late session callbacks stopped.
    if (run.delegation) {
      // A managed child is terminal on startup failure: never a retryable todo,
      // never a placeholder session id.
      try {
        await finalizeClaudeDelegation(deps, run, {
          status: 'complete', resolution: 'failed', result: message, progressSummary: `[failed] ${message}`,
        }, 'failed', message);
      } catch (failure) { failures.push(failure); }
    } else {
      try { await deps.runStore.finishRun(run.runId, { status: 'failed', error: message }); }
      catch (failure) { failures.push(failure); }
      try {
        await updateCardIfPresent(deps.store, input.card.id, {
          status: 'todo', progressSummary: `[failed] ${message}`,
          staleStatus: null, staleDetectedAt: null,
        });
      } catch (failure) { failures.push(failure); }
    }
    if (error instanceof Error && failures.length) {
      error.cause = new AggregateError(error.cause ? [error.cause, ...failures] : failures, 'Claude startup cleanup failed');
    }
    throw error;
  }
}

async function buildClaudeCommand(
  deps: ClaudeAdapterDeps,
  resolveClaudeBinary: () => Promise<string[]>,
  input: {
    model: string;
    resumeSessionId?: string;
    permissionMode?: string;
    dangerouslySkipPermissions?: boolean;
    effort?: string;
  },
): Promise<string[]> {
  const command = await resolveClaudeBinary();
  const args = [
    ...command,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.model,
  ];

  const skipPermissions = input.dangerouslySkipPermissions
    ?? ((await getSettingValueOrDefault(
      deps.settingsStore,
      'agent.claude.dangerously_skip_permissions',
      'false',
    )) === 'true');
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    const permissionMode = input.permissionMode
      ?? await getSettingValueOrDefault(
        deps.settingsStore,
        'agent.claude.permission_mode',
        'acceptEdits',
      );
    args.push('--permission-mode', permissionMode);
  }

  if (input.effort) {
    args.push('--effort', input.effort);
  }

  // Common response guidelines (Settings). `--append-system-prompt` keeps the
  // default system prompt and CLAUDE.md intact. Snapshot `off` makes every
  // launch — new or `--resume` — render the system prompt fresh, so a resumed
  // session gets the LATEST saved text, and the guideline is never written into
  // the transcript's user turns (so it cannot pile up). With the default
  // snapshot `on`, a resume would replay the text recorded at first launch.
  const guidelines = await loadResponseGuidelines(deps.settingsStore);
  if (guidelines) {
    args.push('--append-system-prompt', buildClaudeAppendSystemPrompt(guidelines));
    args.push('--system-prompt-snapshot', 'off');
  }

  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId);
  }

  return args;
}

async function readClaudeStdout(
  stream: ReadableStream<Uint8Array>,
  run: RuntimeRun,
  state: ClaudeRunState,
  onSessionId: (sessionId: string) => Promise<void>,
  onChildEvent?: (ev: ClaudeStreamEvent) => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    buffer += text;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await processClaudeLine(run, state, line, onSessionId, onChildEvent);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  const rest = `${buffer}${decoder.decode()}`;
  if (rest.trim()) {
    await processClaudeLine(run, state, rest, onSessionId, onChildEvent);
  }
}

async function processClaudeLine(
  run: RuntimeRun,
  state: ClaudeRunState,
  line: string,
  onSessionId: (sessionId: string) => Promise<void>,
  onChildEvent?: (ev: ClaudeStreamEvent) => Promise<void>,
): Promise<void> {
  if (!line.trim()) return;
  await appendFile(run.eventsPath, `${line}\n`);
  const event = parseClaudeStreamLine(line);
  if (!event) return;
  if (event.type === 'system' && event.subtype === 'init' && event.sessionId) {
    await onSessionId(event.sessionId);
    return;
  }
  if (
    event.type === 'subagent_started' ||
    event.type === 'subagent_updated' ||
    event.type === 'subagent_completed'
  ) {
    if (onChildEvent) await onChildEvent(event);
    return;
  }
  if (event.type === 'assistant' && event.text) {
    state.resultSegments.push(event.text);
    return;
  }
  if (event.type === 'result') {
    // `result` carries only the LAST assistant text. Never let it replace the
    // accumulated segments — that dropped every earlier mid-turn answer. Use it
    // only when the stream produced no assistant text at all (e.g. error subtypes).
    if (event.result && state.resultSegments.length === 0) state.resultSegments.push(event.result);
    if (event.sessionId) await onSessionId(event.sessionId);
  }
}

async function readClaudeStderr(stream: ReadableStream<Uint8Array>, stderrPath: string): Promise<void> {
  for await (const chunk of stream) {
    await appendFile(stderrPath, chunk);
  }
}

async function waitForSessionId(input: {
  sessionPromise: Promise<string>;
  timeoutMs: number;
}): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.sessionPromise,
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => reject(new RuntimeDispatchError(
          `Claude session_id timeout after ${input.timeoutMs}ms`,
          504,
        )), input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function handleClaudeCompletion(input: {
  deps: ClaudeAdapterDeps;
  input: AdapterStartInput;
  proc: ReturnType<typeof Bun.spawn>;
  run: RuntimeRun;
  state: ClaudeRunState;
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
  startupDone: Promise<void>;
}): Promise<AdapterRunResult> {
  // Attach both handlers before waiting for exit; a rejected reader must never
  // become an unhandled rejection while the child is still terminating.
  const streams = Promise.allSettled([input.stdoutDone, input.stderrDone]);
  const exitCode = await input.proc.exited;
  await streams;
  await input.startupDone;
  const durationMs = Date.now() - new Date(input.run.startedAt).getTime();

  // Admission and reservations share the run-store lock. Once closed, no late
  // delegation can race the final empty-child check. Failure does not cancel
  // independent Codex children; each child retains its own run/artifacts.
  await input.deps.runStore.closeDelegationAdmission(input.run.runId);
  if (input.state.startupFailure !== undefined) {
    return {
      outcome: 'failed',
      result: '',
      error: input.state.startupFailure,
      durationMs,
    };
  }

  const drained = exitCode !== 0 || !!input.run.delegation
    || await input.deps.runStore.waitForDelegations(input.run.runId);

  const joinedResult = joinResultSegments(input.state.resultSegments);
  const finalSegment = lastResultSegment(input.state.resultSegments);
  if (joinedResult) {
    await writeFile(input.run.lastMessagePath, joinedResult);
  }

  if (input.run.delegation) {
    // Managed Codex → Claude child: its own run owns a terminal card; no Telegram,
    // queue continuation or git capture (the parent run owns those).
    const error = exitCode === 0 && input.state.sessionId ? undefined
      : await readTail(input.run.stderrPath) || `claude exited with code ${exitCode}`;
    await finalizeClaudeDelegation(input.deps, input.run, {
      status: 'complete', resolution: error ? 'failed' : 'completed',
      sessionId: input.state.sessionId, result: joinedResult || error || '(no output)',
      finalResult: finalSegment || undefined,
      progressSummary: error ? `[failed] ${error}` : undefined,
      responseAt: new Date().toISOString(), durationMs,
    }, error ? 'failed' : 'completed', error, exitCode);
    return { outcome: error ? 'failed' : 'completed', result: joinedResult, error, durationMs };
  }

  if (exitCode === 0 && input.state.sessionId && drained) {
    const run = await input.deps.runStore.finishRun(input.run.runId, { status: 'completed', exitCode });
    const completed = await completeTrackedRuntimeCard(
      input.deps.store, input.deps.runStore, run, joinedResult || '(no output)', finalSegment || undefined,
    );
    if (!completed) return { outcome: 'completed', result: joinedResult, durationMs };
    await notifyTelegramCompletion({
      store: input.deps.store,
      settingsStore: input.deps.settingsStore,
      cardId: input.input.card.id,
      result: joinedResult || '(no output)',
    });
    await dispatchNextQueuedTodoCard(input.deps.store, input.input.card.id, input.deps.dispatchFn);
    // best-effort, never throws — runs after queue dispatch so it can't delay it
    await captureGitEndAndUsage(input.deps.store, input.input.card.id, input.input.cwd, input.run.eventsPath);
    return {
      outcome: 'completed',
      result: joinedResult,
      durationMs,
    };
  }

  const stderrTail = await readTail(input.run.stderrPath);
  const message = !drained ? 'Managed child review still running at parent drain deadline'
    : stderrTail || `claude exited with code ${exitCode}`;
  const aborted = input.input.abortSignal?.aborted;
  await input.deps.runStore.finishRun(input.run.runId, {
    status: aborted ? 'aborted' : 'failed',
    exitCode,
    error: message,
  });
  const failed = await updateFailedRuntimeCard(input.deps.store, input.deps.runStore, input.run, input.input.card, {
    status: 'todo',
    progressSummary: `[${aborted ? 'aborted' : 'failed'}] runId=${input.run.runId} exit=${exitCode} ${message.slice(0, 500)}`,
    result: joinedResult || message,
    finalResult: finalSegment || undefined,
    staleStatus: null,
    staleDetectedAt: null,
  });
  if (failed) await input.deps.store.supersedeNativeChildren(input.input.card.id, input.run.runId, '[parent run failed]').catch(() => undefined);

  return {
    outcome: aborted ? 'aborted' : 'failed',
    result: joinedResult,
    error: message,
    durationMs,
  };
}

/**
 * Update a card only if it is still on the active board. Once a card is archived
 * it is physically removed from the board, so a late runtime finalization writing
 * to it would either throw "Card not found" or resurrect state the user archived
 * away. Archive wins: the runtime silently drops the write. Soft-deleted cards
 * (still on the board with `deletedAt`) are intentionally NOT skipped — passing
 * `includeDeleted` narrows the guard to genuinely-archived cards.
 */
async function updateCardIfPresent(
  store: KanbanStore,
  cardId: string,
  input: Parameters<KanbanStore['updateCard']>[1],
): Promise<void> {
  const existing = await store.getCard(cardId, { includeDeleted: true });
  if (!existing) return;
  await store.updateCard(cardId, input);
}

/** Card writes for a managed child carry its run id, the only writer the store accepts. */
async function writeClaudeCard(
  deps: ClaudeAdapterDeps, run: RuntimeRun, cardId: string, updates: UpdateCardInput,
): Promise<void> {
  if (!run.delegation) {
    await deps.store.updateCard(cardId, updates);
    return;
  }
  try {
    await deps.store.updateCard(cardId, updates, run.runId);
  } catch (error) {
    // A purged managed child keeps its run record; the run stays readable.
    if (error instanceof Error && error.message === `Card not found: ${cardId}`) return;
    throw error;
  }
}

async function finalizeClaudeDelegation(
  deps: ClaudeAdapterDeps, run: RuntimeRun, updates: UpdateCardInput,
  status: 'completed' | 'failed', error?: string, exitCode?: number,
): Promise<void> {
  const current = await deps.runStore.getRun(run.runId);
  if (!current || !['starting', 'running'].includes(current.status)) return;
  await writeClaudeCard(deps, run, run.cardId, { ...updates, staleStatus: null, staleDetectedAt: null });
  await deps.runStore.finishRun(run.runId, { status, error, exitCode });
}

async function readTail(path: string): Promise<string> {
  if (!existsSync(path)) return '';
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) return '';
  return text.slice(-4096);
}

function getReadableStream(value: unknown): ReadableStream<Uint8Array> {
  if (value instanceof ReadableStream) {
    return value as ReadableStream<Uint8Array>;
  }
  throw new Error('Expected subprocess pipe to be a readable stream');
}

function getWritableStdin(value: unknown): { write: (chunk: string) => unknown; end: () => unknown } {
  if (!value || typeof value !== 'object') {
    throw new Error('Expected subprocess stdin pipe');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.write !== 'function' || typeof record.end !== 'function') {
    throw new Error('Expected subprocess stdin pipe');
  }
  return {
    write: (chunk: string) => {
      const write = record.write as (chunk: string) => unknown;
      return write.call(value, chunk);
    },
    end: () => {
      const end = record.end as () => unknown;
      return end.call(value);
    },
  };
}
