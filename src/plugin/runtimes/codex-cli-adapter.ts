import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { CodexReasoningEffort, CodexSandboxMode, DispatchResult } from '../../core/types';
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
  isCodexModelValid,
} from '../../core/runtime-config';
import { dispatchNextQueuedTodoCard } from '../hooks/event-handler';
import type { AgentAdapter, AdapterRunResult, AdapterStartInput, DispatchHandle } from './types';
import { RuntimeDispatchError } from './types';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { parseCodexJsonlLine } from './codex-jsonl-parser';
import { captureGitEndAndUsage } from './git-capture';
import { withSpawnLock } from './spawn-lock';
import { notifyTelegramCompletion } from '../telegram-completion';

const DEFAULT_THREAD_ID_TIMEOUT_MS = 30_000;
const MAX_RESULT_MIRROR_LENGTH = 60_000;
const CODEX_BYPASS_SETTING_KEY = 'agent.codex.bypass_approvals_and_sandbox';
const CODEX_BYPASS_ENV_KEY = 'KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX';

export interface CodexCliAdapterDeps {
  store: KanbanStore;
  settingsStore?: SettingsStore;
  runStore: RuntimeRunStore;
  dispatchFn?: (cardId: string) => Promise<DispatchResult>;
  commandOverride?: string[];
  threadIdTimeoutMs?: number;
}

interface CodexRunState {
  threadId?: string;
  timedOut: boolean;
  resultBuffer: string;
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
  if (activeCardRun) {
    throw new RuntimeDispatchError(`Card already has an active ${activeCardRun.runtime} run`, 409);
  }
  if (input.resumeSessionId) {
    const activeSessionRun = await deps.runStore.findActiveRunBySession(input.resumeSessionId);
    if (activeSessionRun) {
      throw new RuntimeDispatchError(`Session already has an active run: ${input.resumeSessionId}`, 409);
    }
  }

  const model = input.card.model && isCodexModelValid(input.card.model)
    ? input.card.model
    : DEFAULT_CODEX_MODEL;
  const run = await deps.runStore.createRun({
    cardId: input.card.id,
    runtime: 'codex',
    sessionId: input.resumeSessionId,
    model,
    cwd: input.cwd,
  });
  await Bun.write(run.promptPath, input.prompt);
  await Bun.write(run.eventsPath, '');
  await Bun.write(run.stderrPath, '');

  const argv = await buildCodexCommand(deps, run, input, model);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: input.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        AGENT_KANBAN_DISPATCH_CARD_ID: input.card.id,
        AGENT_KANBAN_DISPATCH_RUN_ID: run.runId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to spawn Codex';
    await deps.runStore.finishRun(run.runId, {
      status: 'failed',
      error: message,
    });
    await deps.store.updateCard(input.card.id, {
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
  stdin.write(input.prompt);
  stdin.end();

  input.abortSignal?.addEventListener('abort', () => proc.kill(), { once: true });

  const state: CodexRunState = {
    threadId: input.resumeSessionId,
    timedOut: false,
    resultBuffer: '',
    threadResolved: Boolean(input.resumeSessionId),
  };

  const threadPromise = new Promise<string>((resolve) => {
    state.resolveThread = resolve;
    if (input.resumeSessionId) resolve(input.resumeSessionId);
  });

  const stdoutDone = readCodexStdout(getReadableStream(proc.stdout), run, state, async (threadId) => {
    if (state.threadResolved) return;
    state.threadId = threadId;
    state.threadResolved = true;
    state.resolveThread?.(threadId);
    await deps.runStore.updateRun(run.runId, { sessionId: threadId });
    await deps.store.updateCard(input.card.id, {
      status: 'in_progress',
      sessionId: threadId,
      staleStatus: null,
      staleDetectedAt: null,
    });
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

  if (input.resumeSessionId) {
    await deps.store.updateCard(input.card.id, {
      status: 'in_progress',
      sessionId: input.resumeSessionId,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }

  const sessionId = await waitForThreadId({
    threadPromise,
    timeoutMs: threadIdTimeoutMs,
    proc,
    run,
    deps,
    cardId: input.card.id,
    state,
  });

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
      await processCodexLine(run, state, line, onThreadId);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  const rest = `${buffer}${decoder.decode()}`;
  if (rest.trim()) {
    await processCodexLine(run, state, rest, onThreadId);
  }
}

async function processCodexLine(
  run: RuntimeRun,
  state: CodexRunState,
  line: string,
  onThreadId: (threadId: string) => Promise<void>,
): Promise<void> {
  if (!line.trim()) return;
  await appendFile(run.eventsPath, `${line}\n`);
  const event = parseCodexJsonlLine(line);
  if (!event) return;
  if (event.type === 'thread_started') {
    await onThreadId(event.threadId);
    return;
  }
  if (event.type === 'agent_message') {
    state.resultBuffer = event.text;
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
  const exitCode = await input.proc.exited;
  await Promise.allSettled([input.stdoutDone, input.stderrDone]);
  const durationMs = Date.now() - new Date(input.run.startedAt).getTime();

  if (input.state.timedOut) {
    return {
      outcome: 'failed',
      result: '',
      error: 'thread_id timeout',
      durationMs,
    };
  }

  const finalResult = await readFinalResult(input.run, input.state.resultBuffer);

  if (exitCode === 0 && input.state.threadId) {
    await input.deps.runStore.finishRun(input.run.runId, {
      status: 'completed',
      exitCode,
    });
    await input.deps.store.updateCard(input.input.card.id, {
      status: 'complete',
      resolution: 'completed',
      sessionId: input.state.threadId,
      result: mirrorResult(finalResult || '(no output)'),
      responseAt: new Date().toISOString(),
      progressSummary: undefined,
      staleStatus: null,
      staleDetectedAt: null,
      queuedAfterCardId: null,
      queuePosition: null,
      queueSessionMode: null,
      resumeSessionId: null,
    });
    await notifyTelegramCompletion({
      store: input.deps.store,
      settingsStore: input.deps.settingsStore,
      cardId: input.input.card.id,
      result: finalResult || '(no output)',
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
      result: finalResult,
      durationMs,
    };
  }

  const stderrTail = await readTail(input.run.stderrPath);
  const message = stderrTail || `codex exited with code ${exitCode}`;
  const aborted = input.input.abortSignal?.aborted;
  await input.deps.runStore.finishRun(input.run.runId, {
    status: aborted ? 'aborted' : 'failed',
    exitCode,
    error: message,
  });
  await input.deps.store.updateCard(input.input.card.id, {
    status: 'todo',
    progressSummary: `[${aborted ? 'aborted' : 'failed'}] runId=${input.run.runId} exit=${exitCode} ${message.slice(0, 500)}`,
    result: mirrorResult(finalResult || message),
    staleStatus: null,
    staleDetectedAt: null,
  });

  return {
    outcome: aborted ? 'aborted' : 'failed',
    result: finalResult,
    error: message,
    durationMs,
  };
}

async function readFinalResult(run: RuntimeRun, fallback: string): Promise<string> {
  if (existsSync(run.lastMessagePath)) {
    const text = await readFile(run.lastMessagePath, 'utf8');
    if (text.trim()) return text;
  }
  if (fallback) {
    await writeFile(run.lastMessagePath, fallback);
  }
  return fallback;
}

async function readTail(path: string): Promise<string> {
  if (!existsSync(path)) return '';
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) return '';
  return text.slice(-4096);
}

function mirrorResult(text: string): string {
  if (text.length <= MAX_RESULT_MIRROR_LENGTH) return text;
  return `${text.slice(0, MAX_RESULT_MIRROR_LENGTH)}\n\n[truncated] Full result is preserved in the runtime run directory.`;
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
