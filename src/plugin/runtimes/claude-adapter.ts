import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import type { DispatchResult } from '../../core/types';
import type { KanbanStore } from '../../core/store';
import { DEFAULT_CLAUDE_MODEL, isClaudeModelValid } from '../../core/runtime-config';
import { dispatchNextQueuedTodoCard } from '../hooks/event-handler';
import type { AgentAdapter, AdapterRunResult, AdapterStartInput, DispatchHandle } from './types';
import { captureGitEndAndUsage } from './git-capture';
import { RuntimeDispatchError } from './types';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { createClaudeBinaryResolver } from './claude-binary';
import { parseClaudeStreamLine } from './claude-stream-parser';
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
}

interface ClaudeRunState {
  sessionId?: string;
  timedOut: boolean;
  resultBuffer: string;
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
  if (activeCardRun) {
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
  const run = await deps.runStore.createRun({
    cardId: input.card.id,
    runtime: 'claude',
    sessionId: input.resumeSessionId,
    model,
    cwd: input.cwd,
  });
  await Bun.write(run.promptPath, input.prompt);
  await Bun.write(run.eventsPath, '');
  await Bun.write(run.stderrPath, '');

  const argv = await buildClaudeCommand(deps, resolveClaudeBinary, {
    model,
    resumeSessionId: input.resumeSessionId,
    permissionMode: input.card.claudeOptions?.permissionMode,
    dangerouslySkipPermissions: input.card.claudeOptions?.dangerouslySkipPermissions,
  });

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
    const message = error instanceof Error ? error.message : 'Failed to spawn Claude';
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

  const state: ClaudeRunState = {
    sessionId: input.resumeSessionId,
    timedOut: false,
    resultBuffer: '',
    sessionResolved: Boolean(input.resumeSessionId),
  };

  const sessionPromise = new Promise<string>((resolve) => {
    state.resolveSession = resolve;
    if (input.resumeSessionId) resolve(input.resumeSessionId);
  });

  const childEventCallback = deps.onChildEvent
    ? async (ev: ClaudeStreamEvent) => {
        try {
          await deps.onChildEvent!(input.card.id, run.runId, ev);
        } catch {
          // swallow — child event failure must not abort the parent run
        }
      }
    : undefined;

  const stdoutDone = readClaudeStdout(getReadableStream(proc.stdout), run, state, async (sessionId) => {
    if (state.sessionResolved) return;
    state.sessionId = sessionId;
    state.sessionResolved = true;
    state.resolveSession?.(sessionId);
    await deps.runStore.updateRun(run.runId, { sessionId });
    await deps.store.updateCard(input.card.id, {
      status: 'in_progress',
      sessionId,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }, childEventCallback);
  const stderrDone = readClaudeStderr(getReadableStream(proc.stderr), run.stderrPath);
  const done = handleClaudeCompletion({
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

  const sessionId = await waitForSessionId({
    sessionPromise,
    timeoutMs: sessionIdTimeoutMs,
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

async function buildClaudeCommand(
  deps: ClaudeAdapterDeps,
  resolveClaudeBinary: () => Promise<string[]>,
  input: {
    model: string;
    resumeSessionId?: string;
    permissionMode?: string;
    dangerouslySkipPermissions?: boolean;
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
    state.resultBuffer += event.text;
    return;
  }
  if (event.type === 'result') {
    if (event.result) state.resultBuffer = event.result;
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
  proc: ReturnType<typeof Bun.spawn>;
  run: RuntimeRun;
  deps: ClaudeAdapterDeps;
  cardId: string;
  state: ClaudeRunState;
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
  } catch (error) {
    input.state.timedOut = true;
    input.proc.kill();
    const message = error instanceof Error ? error.message : 'Claude session_id timeout';
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

async function handleClaudeCompletion(input: {
  deps: ClaudeAdapterDeps;
  input: AdapterStartInput;
  proc: ReturnType<typeof Bun.spawn>;
  run: RuntimeRun;
  state: ClaudeRunState;
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
      error: 'session_id timeout',
      durationMs,
    };
  }

  const finalResult = input.state.resultBuffer || '';
  if (finalResult) {
    await writeFile(input.run.lastMessagePath, finalResult);
  }

  if (exitCode === 0 && input.state.sessionId) {
    await input.deps.runStore.finishRun(input.run.runId, {
      status: 'completed',
      exitCode,
    });
    await input.deps.store.updateCard(input.input.card.id, {
      status: 'complete',
      resolution: 'completed',
      sessionId: input.state.sessionId,
      result: finalResult || '(no output)',
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
    // best-effort, never throws — runs after queue dispatch so it can't delay it
    await captureGitEndAndUsage(input.deps.store, input.input.card.id, input.input.cwd, input.run.eventsPath);
    return {
      outcome: 'completed',
      result: finalResult,
      durationMs,
    };
  }

  const stderrTail = await readTail(input.run.stderrPath);
  const message = stderrTail || `claude exited with code ${exitCode}`;
  const aborted = input.input.abortSignal?.aborted;
  await input.deps.runStore.finishRun(input.run.runId, {
    status: aborted ? 'aborted' : 'failed',
    exitCode,
    error: message,
  });
  await input.deps.store.updateCard(input.input.card.id, {
    status: 'todo',
    progressSummary: `[${aborted ? 'aborted' : 'failed'}] runId=${input.run.runId} exit=${exitCode} ${message.slice(0, 500)}`,
    result: finalResult || message,
    staleStatus: null,
    staleDetectedAt: null,
  });
  await finalizeChildrenOnParentFail(input.input.card.id, input.deps.store).catch(() => undefined);

  return {
    outcome: aborted ? 'aborted' : 'failed',
    result: finalResult,
    error: message,
    durationMs,
  };
}

async function finalizeChildrenOnParentFail(parentCardId: string, store: KanbanStore): Promise<void> {
  const cards = await store.getCards();
  const stuckChildren = cards.filter(
    c =>
      c.parentCardId === parentCardId &&
      c.linkKind === 'subagent' &&
      c.status === 'in_progress',
  );
  await Promise.allSettled(
    stuckChildren.map(child =>
      store.updateCard(child.id, {
        status: 'complete',
        resolution: 'superseded',
        result: '[parent run failed]',
      }),
    ),
  );
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
