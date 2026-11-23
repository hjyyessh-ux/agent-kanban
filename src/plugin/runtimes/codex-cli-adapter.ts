import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { CodexReasoningEffort, CodexSandboxMode, DispatchResult, UpdateCardInput } from '../../core/types';
import type { KanbanStore } from '../../core/store';
import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import {
  CODEX_REASONING_EFFORT_SETTING_KEY,
  CODEX_REASONING_EFFORT_VALUES,
  CODEX_SANDBOX_SETTING_KEY,
  CODEX_SANDBOX_VALUES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from '../../core/runtime-config';
import { dispatchNextQueuedTodoCard } from '../hooks/event-handler';
import type { AgentAdapter, AdapterRunResult, AdapterStartInput, DispatchHandle } from './types';
import { RuntimeDispatchError } from './types';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { parseCodexJsonlLine } from './codex-jsonl-parser';
import { completeTrackedRuntimeCard, updateFailedRuntimeCard } from './runtime-restart-sync';
import { codexChildEvents } from './codex-child-events';
import { ChildLinker } from './child-linker';
import type { ClaudeStreamEvent } from './claude-stream-parser';
import { joinResultSegments, lastResultSegment } from './result-segments';
import { captureGitEndAndUsage } from './git-capture';
import { withSpawnLock } from './spawn-lock';
import { planCodexGuidelineDelivery } from './codex-response-guidelines';
import { notifyTelegramCompletion } from '../telegram-completion';

const DEFAULT_THREAD_ID_TIMEOUT_MS = 30_000;
const CODEX_BYPASS_SETTING_KEY = 'agent.codex.bypass_approvals_and_sandbox';
const CODEX_BYPASS_ENV_KEY = 'KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX';

export interface CodexCliAdapterDeps {
  store: KanbanStore;
  settingsStore?: SettingsStore;
  runStore: RuntimeRunStore;
  dispatchFn?: (cardId: string) => Promise<DispatchResult>;
  commandOverride?: string[];
  threadIdTimeoutMs?: number;
  getApiUrl?: () => string | undefined;
}

interface CodexRunState {
  threadId?: string;
  timedOut: boolean;
  // Every agent_message seen this run, in order. Joined at completion
  // (see result-segments.ts) so mid-turn answers are not lost.
  resultSegments: string[];
  threadResolved: boolean;
  resolveThread?: (threadId: string) => void;
}

export function createCodexCliAdapter(deps: CodexCliAdapterDeps): AgentAdapter {
  const threadIdTimeoutMs = deps.threadIdTimeoutMs ?? DEFAULT_THREAD_ID_TIMEOUT_MS;

  return {
    runtime: 'codex',
    async start(input: AdapterStartInput): Promise<DispatchHandle> {
      return withSpawnLock(`runtime-card-${input.card.id}`, async () => {
        const sessionLockKey = input.resumeSessionId
          ? `runtime-session-${input.resumeSessionId}`
          : `runtime-new-session-${input.card.id}`;
        return withSpawnLock(sessionLockKey, () => startCodexRun(deps, threadIdTimeoutMs, input));
      });
    },
  };
}

async function startCodexRun(
  deps: CodexCliAdapterDeps,
  threadIdTimeoutMs: number,
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

  const model = input.card.model?.trim() || DEFAULT_CODEX_MODEL;
  const reserved = input.reservedRun ? await deps.runStore.getRun(input.reservedRun.runId) : null;
  if (input.reservedRun && (!reserved?.delegation?.claimed || reserved.status !== 'starting'
    || reserved.cardId !== input.card.id || input.card.managedDelegation?.runId !== reserved.runId)) {
    throw new RuntimeDispatchError('Delegation reservation is not executable', 409);
  }
  const run = reserved ?? await deps.runStore.createRun({
    cardId: input.card.id,
    runtime: 'codex',
    sessionId: input.resumeSessionId,
    model,
    cwd: input.cwd,
  });
  await Bun.write(run.promptPath, input.prompt);
  await Bun.write(run.eventsPath, '');
  await Bun.write(run.stderrPath, '');

  // prompt.md above keeps the user's original words; only stdin carries a
  // guideline prefix (resume / config fallback) — see codex-response-guidelines.
  const guidelines = await planCodexGuidelineDelivery({
    settingsStore: deps.settingsStore,
    cwd: input.cwd,
    prompt: input.prompt,
    resumeSessionId: input.resumeSessionId,
  });
  const argv = await buildCodexCommand(deps, run, input, model, guidelines.configArgs);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
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
    const message = error instanceof Error ? error.message : 'Failed to spawn Codex';
    await deps.runStore.closeDelegationAdmission(run.runId);
    if (run.delegation) {
      await finalizeDelegation(deps, run, {
        status: 'complete', resolution: 'failed', result: message, progressSummary: `[failed] ${message}`,
      }, 'failed', message);
      throw new RuntimeDispatchError(message, 500);
    }
    await deps.runStore.finishRun(run.runId, {
      status: 'failed',
      error: message,
    });
    await writeCodexCard(deps, run, {
      status: 'todo',
      progressSummary: `[failed] runId=${run.runId} ${message.slice(0, 500)}`,
    });
    throw new RuntimeDispatchError(message, 500);
  }

  await deps.runStore.updateRun(run.runId, {
    status: 'running',
    pid: proc.pid,
  });

  const stdin = getWritableStdin(proc.stdin);
  stdin.write(guidelines.stdinPrompt);
  stdin.end();

  input.abortSignal?.addEventListener('abort', () => proc.kill(), { once: true });

  const state: CodexRunState = {
    threadId: input.resumeSessionId,
    timedOut: false,
    resultSegments: [],
    threadResolved: Boolean(input.resumeSessionId),
  };

  const threadPromise = new Promise<string>((resolve) => {
    state.resolveThread = resolve;
    if (input.resumeSessionId) resolve(input.resumeSessionId);
  });

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

  const childLinker = new ChildLinker(deps.store);
  const stdoutDone = readCodexStdout(getReadableStream(proc.stdout), run, state, async (threadId) => {
    if (state.threadResolved || state.timedOut) return;
    state.threadId = threadId;
    state.threadResolved = true;
    state.resolveThread?.(threadId);
    await deps.runStore.updateRun(run.runId, { sessionId: threadId });
    await writeCodexCard(deps, run, {
      status: 'in_progress',
      startedAt: run.startedAt,
      progressSummary: undefined,
      sessionId: threadId,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }, async event => {
    if (!run.delegation) {
      await childLinker.onChildEvent(input.card.id, run.runId, event, 'codex').catch(() => undefined);
    }
  });
  const stderrDone = readCodexStderr(getReadableStream(proc.stderr), run.stderrPath);
  const done = handleCodexCompletion({
    deps,
    input,
    proc,
    run,
    state,
    stdoutDone,
    stderrDone,
  });
  const settled = Promise.allSettled([done]);

  let sessionId: string;
  try {
    sessionId = await waitForThreadId({
      threadPromise,
      timeoutMs: threadIdTimeoutMs,
      proc,
      run,
      deps,
      cardId: input.card.id,
      state,
    });
  } catch (error) {
    const [completion] = await settled;
    if (error instanceof Error && completion!.status === 'rejected') {
      error.cause = new AggregateError(error.cause ? [error.cause, completion!.reason] : [completion!.reason], 'Codex startup cleanup failed');
    }
    throw error;
  }

  return {
    sessionId,
    runId: run.runId,
    startedAt: run.startedAt,
    abort: () => proc.kill(),
    done,
  };
}

async function buildCodexCommand(
  deps: CodexCliAdapterDeps,
  run: RuntimeRun,
  input: AdapterStartInput,
  model: string,
  guidelineConfigArgs: string[] = [],
): Promise<string[]> {
  const command = deps.commandOverride ?? ['codex'];
  const sandbox = await resolveCodexSandbox(deps, input);
  const reasoningEffort = await resolveCodexReasoningEffort(deps, input);
  const skipGitRepoCheck = input.card.codexOptions?.skipGitRepoCheck ?? true;
  const bypassApprovalsAndSandbox = await resolveBypassApprovalsAndSandbox(deps, input);

  const args = [...command, 'exec'];
  args.push(
    '--json',
    '-o',
    run.lastMessagePath,
    '-m',
    model,
    '-s',
    sandbox,
    '-C',
    input.cwd,
  );
  args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  args.push(...guidelineConfigArgs);
  if (skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (bypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (input.resumeSessionId) {
    args.push('resume', input.resumeSessionId);
  }
  args.push('-');
  return args;
}

async function resolveCodexSandbox(
  deps: CodexCliAdapterDeps,
  input: AdapterStartInput,
): Promise<CodexSandboxMode> {
  const cardValue = input.card.codexOptions?.sandbox;
  if (cardValue) return cardValue;

  if (!deps.settingsStore) return DEFAULT_CODEX_SANDBOX;

  const stored = await getSettingValueOrDefault(
    deps.settingsStore,
    CODEX_SANDBOX_SETTING_KEY,
    DEFAULT_CODEX_SANDBOX,
  );
  return CODEX_SANDBOX_VALUES.includes(stored as CodexSandboxMode)
    ? (stored as CodexSandboxMode)
    : DEFAULT_CODEX_SANDBOX;
}

async function resolveCodexReasoningEffort(
  deps: CodexCliAdapterDeps,
  input: AdapterStartInput,
): Promise<CodexReasoningEffort> {
  const cardValue = input.card.codexOptions?.reasoningEffort;
  if (cardValue) return cardValue;

  if (!deps.settingsStore) return DEFAULT_CODEX_REASONING_EFFORT;

  const stored = await getSettingValueOrDefault(
    deps.settingsStore,
    CODEX_REASONING_EFFORT_SETTING_KEY,
    DEFAULT_CODEX_REASONING_EFFORT,
  );
  return CODEX_REASONING_EFFORT_VALUES.includes(stored as CodexReasoningEffort)
    ? (stored as CodexReasoningEffort)
    : DEFAULT_CODEX_REASONING_EFFORT;
}

async function resolveBypassApprovalsAndSandbox(
  deps: CodexCliAdapterDeps,
  input: AdapterStartInput,
): Promise<boolean> {
  const cardValue = input.card.codexOptions?.bypassApprovalsAndSandbox;
  if (typeof cardValue === 'boolean') return cardValue;

  if (deps.settingsStore) {
    const stored = await getSettingValueOrDefault(
      deps.settingsStore,
      CODEX_BYPASS_SETTING_KEY,
      process.env[CODEX_BYPASS_ENV_KEY] ?? 'false',
    );
    return stored === 'true';
  }

  return process.env[CODEX_BYPASS_ENV_KEY] === 'true';
}

async function readCodexStdout(
  stream: ReadableStream<Uint8Array>,
  run: RuntimeRun,
  state: CodexRunState,
  onThreadId: (threadId: string) => Promise<void>,
  onChild: (event: ClaudeStreamEvent) => Promise<void>,
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
      await processCodexLine(run, state, line, onThreadId, onChild);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  const rest = `${buffer}${decoder.decode()}`;
  if (rest.trim()) {
    await processCodexLine(run, state, rest, onThreadId, onChild);
  }
}

async function processCodexLine(
  run: RuntimeRun,
  state: CodexRunState,
  line: string,
  onThreadId: (threadId: string) => Promise<void>,
  onChild: (event: ClaudeStreamEvent) => Promise<void>,
): Promise<void> {
  if (!line.trim()) return;
  await appendFile(run.eventsPath, `${line}\n`);
  const event = parseCodexJsonlLine(line);
  if (!event) return;
  if (event.type === 'thread_started') {
    await onThreadId(event.threadId);
    return;
  }
  for (const child of codexChildEvents(event, state.threadId)) await onChild(child);
  if (event.type === 'agent_message') {
    state.resultSegments.push(event.text);
  }
}

async function readCodexStderr(stream: ReadableStream<Uint8Array>, stderrPath: string): Promise<void> {
  for await (const chunk of stream) {
    await appendFile(stderrPath, chunk);
  }
}

async function waitForThreadId(input: {
  threadPromise: Promise<string>;
  timeoutMs: number;
  proc: ReturnType<typeof Bun.spawn>;
  run: RuntimeRun;
  deps: CodexCliAdapterDeps;
  cardId: string;
  state: CodexRunState;
}): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.threadPromise,
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => reject(new RuntimeDispatchError(
          `Codex thread_id timeout after ${input.timeoutMs}ms`,
          504,
        )), input.timeoutMs);
      }),
    ]);
  } catch (error) {
    input.state.timedOut = true;
    input.proc.kill();
    const message = error instanceof Error ? error.message : 'Codex thread_id timeout';
    if (input.run.delegation) throw error;
    await input.deps.runStore.finishRun(input.run.runId, {
      status: 'failed',
      error: message,
    });
    await input.deps.store.updateCard(input.cardId, {
      status: 'todo',
      progressSummary: `[failed] ${message}`,
      staleStatus: null,
      staleDetectedAt: null,
    });
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function handleCodexCompletion(input: {
  deps: CodexCliAdapterDeps;
  input: AdapterStartInput;
  proc: ReturnType<typeof Bun.spawn>;
  run: RuntimeRun;
  state: CodexRunState;
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
}): Promise<AdapterRunResult> {
  const streams = Promise.allSettled([input.stdoutDone, input.stderrDone]);
  const exitCode = await input.proc.exited;
  await streams;
  const durationMs = Date.now() - new Date(input.run.startedAt).getTime();

  if (input.run.delegation) {
    const result = await readFinalResult(input.run, joinResultSegments(input.state.resultSegments));
    const error = input.state.timedOut ? 'Codex thread_id timeout'
      : exitCode === 0 && input.state.threadId ? undefined
      : await readTail(input.run.stderrPath) || `codex exited with code ${exitCode}`;
    await finalizeDelegation(input.deps, input.run, {
      status: 'complete', resolution: error ? 'failed' : 'completed',
      sessionId: input.state.threadId, result: result || error || '(no output)',
      finalResult: lastResultSegment(input.state.resultSegments) || undefined,
      progressSummary: error ? `[failed] ${error}` : undefined,
      responseAt: new Date().toISOString(), durationMs,
    }, error ? 'failed' : 'completed', error, exitCode);
    return { outcome: error ? 'failed' : 'completed', result, error, durationMs };
  }

  // Codex → Claude admission closes under the run-store lock before the parent's
  // terminal write, so no late delegation races the drain below. A failed parent
  // does not cancel accepted Claude children; each keeps its own run.
  await input.deps.runStore.closeDelegationAdmission(input.run.runId);

  if (input.state.timedOut) {
    return {
      outcome: 'failed',
      result: '',
      error: 'thread_id timeout',
      durationMs,
    };
  }

  // A child lacking a terminal log is not a verified success, even if its parent finished.
  await input.deps.store.supersedeNativeChildren(
    input.input.card.id, input.run.runId, '[parent run exited without a recorded child completion]',
  ).catch(() => undefined);

  const joinedResult = await readFinalResult(input.run, joinResultSegments(input.state.resultSegments));
  const finalSegment = lastResultSegment(input.state.resultSegments);

  const drained = exitCode !== 0 || !input.state.threadId || await input.deps.runStore.waitForDelegations(input.run.runId);
  if (exitCode === 0 && input.state.threadId && drained) {
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
    // Best-effort git/usage capture — never throws, runs after completion/queue
    // so it cannot block the flow. Codex events.jsonl uses the codex parser.
    await captureGitEndAndUsage(
      input.deps.store,
      input.input.card.id,
      input.input.cwd,
      input.run.eventsPath,
      'codex',
    );
    return {
      outcome: 'completed',
      result: joinedResult,
      durationMs,
    };
  }

  const stderrTail = await readTail(input.run.stderrPath);
  const message = !drained ? 'Managed child review still running at parent drain deadline'
    : stderrTail || `codex exited with code ${exitCode}`;
  const aborted = input.input.abortSignal?.aborted;
  await input.deps.runStore.finishRun(input.run.runId, {
    status: aborted ? 'aborted' : 'failed',
    exitCode,
    error: message,
  });
  await updateFailedRuntimeCard(input.deps.store, input.deps.runStore, input.run, input.input.card, {
    status: 'todo',
    progressSummary: `[${aborted ? 'aborted' : 'failed'}] runId=${input.run.runId} exit=${exitCode} ${message.slice(0, 500)}`,
    result: joinedResult || message,
    finalResult: finalSegment || undefined,
    staleStatus: null,
    staleDetectedAt: null,
  });

  return {
    outcome: aborted ? 'aborted' : 'failed',
    result: joinedResult,
    error: message,
    durationMs,
  };
}

async function writeCodexCard(deps: CodexCliAdapterDeps, run: RuntimeRun, updates: UpdateCardInput): Promise<void> {
  try {
    await deps.store.updateCard(run.cardId, updates, run.delegation ? run.runId : undefined);
  } catch (error) {
    if (run.delegation && error instanceof Error && error.message === `Card not found: ${run.cardId}`) return;
    throw error;
  }
}

async function finalizeDelegation(
  deps: CodexCliAdapterDeps, run: RuntimeRun, updates: UpdateCardInput,
  status: 'completed' | 'failed', error?: string, exitCode?: number,
): Promise<void> {
  const current = await deps.runStore.getRun(run.runId);
  if (!current || !['starting', 'running'].includes(current.status)) return;
  await writeCodexCard(deps, run, { ...updates, staleStatus: null, staleDetectedAt: null });
  await deps.runStore.finishRun(run.runId, { status, error, exitCode });
}

// The streamed agent_message segments are authoritative: `codex exec -o` writes
// only the LAST agent message to the last-message file, so preferring that file
// dropped every earlier mid-turn answer. The file is rewritten with the joined
// segments so the run artifact matches the card, and is read only as a fallback
// when the stream yielded no agent text.
async function readFinalResult(run: RuntimeRun, streamed: string): Promise<string> {
  if (streamed) {
    await writeFile(run.lastMessagePath, streamed);
    return streamed;
  }
  if (existsSync(run.lastMessagePath)) {
    const text = await readFile(run.lastMessagePath, 'utf8');
    if (text.trim()) return text;
  }
  return '';
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
