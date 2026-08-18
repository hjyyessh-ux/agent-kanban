import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { KanbanStore } from '../core/store';
import type { ScriptStore } from '../core/script-store';
import type { SettingsStore } from '../core/settings-store';
import type {
  DispatchResult,
  QuickActionParameterValue,
  ScriptRun,
  ScriptRunAcceptedResponse,
  SupportedScriptLanguage,
} from '../core/types';
import { resolveDir } from '../core/data-dir';
import {
  EXECUTION_OUTPUT_BYTE_CAP,
  buildExecutionEnvironment,
  capExecutionOutput,
  redactSecrets,
} from '../core/execution-environment';
import { dispatchNextQueuedTodoCard } from './hooks/event-handler';

const ORPHAN_ERROR = 'Script execution was interrupted by a process restart';
const TRUNCATED_SUFFIX = '\n... (truncated)';

export interface ScriptSpawnInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ScriptSpawnProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export interface PrepareScriptExecutionInput {
  scriptId: string;
  cwdOverride?: string;
  parameterValues?: Readonly<Record<string, QuickActionParameterValue>>;
  secretParameterKeys?: ReadonlySet<string>;
}

export interface PreparedScriptExecution {
  runId: string;
  scriptId: string;
  scriptName: string;
  startedAt: string;
  cwd: string;
  language: SupportedScriptLanguage;
  scriptRevision: string;
  argv: string[];
  env: Record<string, string>;
  secretValues: string[];
}

export interface ScriptExecutionServiceDeps {
  scriptStore: ScriptStore;
  cardStore: KanbanStore;
  settingsStore?: SettingsStore;
  dispatchFn?: (cardId: string) => Promise<DispatchResult | { sessionId: string }>;
  spawn?: (input: ScriptSpawnInput) => ScriptSpawnProcess;
  now?: () => Date;
  generateId?: () => string;
}

export class ScriptExecutionConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ScriptExecutionConflictError';
  }
}

export class ScriptExecutionValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ScriptExecutionValidationError';
  }
}

function normalizeLanguage(language: string): SupportedScriptLanguage {
  switch (language.toLowerCase()) {
    case 'bash':
    case 'python':
    case 'javascript':
    case 'typescript':
    case 'bun':
    case 'ruby':
      return language.toLowerCase() as SupportedScriptLanguage;
    default:
      throw new ScriptExecutionValidationError(`Unsupported script language: ${language}`);
  }
}

function buildInterpreterArgv(language: SupportedScriptLanguage, content: string): string[] {
  switch (language) {
    case 'bash':
      return ['bash', '-c', content];
    case 'python':
      return ['python3', '-c', content];
    case 'javascript':
    case 'typescript':
    case 'bun':
      return ['bun', '-e', content];
    case 'ruby':
      return ['ruby', '-e', content];
  }
}

function defaultSpawn(input: ScriptSpawnInput): ScriptSpawnProcess {
  return Bun.spawn(input.argv, {
    cwd: input.cwd,
    env: input.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

interface CapturedOutput {
  text: string;
  truncated: boolean;
}

async function readCappedStream(
  stream: ReadableStream<Uint8Array>,
  lookaheadBytes: number,
): Promise<CapturedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let truncated = false;
  const retainLimit = EXECUTION_OUTPUT_BYTE_CAP + lookaheadBytes;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = retainLimit - retainedBytes;
    if (remaining > 0) {
      const retained = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(retained);
      retainedBytes += retained.byteLength;
    }
    if (value.byteLength > remaining) truncated = true;
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return { text, truncated };
}

function sanitizeCapturedOutput(
  captured: CapturedOutput,
  secretValues: readonly string[],
  oversizedSecret: boolean,
): string {
  if (oversizedSecret) return captured.text.length > 0 ? '[REDACTED]' : '';
  const redacted = redactSecrets(captured.text, secretValues) ?? '';
  const capped = capExecutionOutput(redacted) ?? '';
  if (captured.truncated && !capped.endsWith(TRUNCATED_SUFFIX)) {
    return `${capped}${TRUNCATED_SUFFIX}`;
  }
  return capped;
}

function scriptRevision(language: SupportedScriptLanguage, content: string): string {
  return createHash('sha256').update(language).update('\0').update(content).digest('hex');
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatCardResult(run: ScriptRun): string {
  const lines = [
    run.status === 'success' ? 'Script completed successfully.' : '[failed] Script execution failed.',
    `runId: ${run.id}`,
    `cwd: ${run.cwd ?? 'unknown'}`,
    `revision: ${run.scriptRevision ?? 'unknown'}`,
  ];
  if (run.exitCode !== undefined) lines.push(`exitCode: ${run.exitCode}`);
  if (run.error) lines.push(`error: ${run.error}`);
  if (run.stdout) lines.push('', 'stdout:', run.stdout);
  if (run.stderr) lines.push('', 'stderr:', run.stderr);
  return lines.join('\n');
}

export class ScriptExecutionService {
  private readonly scriptStore: ScriptStore;
  private readonly cardStore: KanbanStore;
  private readonly settingsStore?: SettingsStore;
  private readonly dispatchFn?: ScriptExecutionServiceDeps['dispatchFn'];
  private readonly spawn: NonNullable<ScriptExecutionServiceDeps['spawn']>;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly completions = new Map<string, Promise<ScriptRun>>();
  private initializePromise: Promise<number> | null = null;

  constructor(deps: ScriptExecutionServiceDeps) {
    this.scriptStore = deps.scriptStore;
    this.cardStore = deps.cardStore;
    this.settingsStore = deps.settingsStore;
    this.dispatchFn = deps.dispatchFn;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => nanoid());
  }

  initialize(): Promise<number> {
    if (!this.initializePromise) {
      this.initializePromise = this.reconcileOrphanedRuns();
    }
    return this.initializePromise;
  }

  private async reconcileOrphanedRuns(): Promise<number> {
    const finishedAt = this.now().toISOString();
    const runs = await this.scriptStore.reconcileRunningRuns(
      ORPHAN_ERROR,
      finishedAt,
      (run) => !isProcessAlive(run.ownerPid),
    );
    for (const run of runs) {
      if (!run.cardId) continue;
      const failureSummary = `[failed] ${ORPHAN_ERROR}`;
      await this.cardStore.finalizeScriptExecutionCard(run.cardId, {
        runId: run.id,
        outcome: 'failed',
        failureSummary,
        result: formatCardResult(run),
      }).catch(() => undefined);
    }
    return runs.length;
  }

  async prepareExecution(input: PrepareScriptExecutionInput): Promise<PreparedScriptExecution> {
    const active = await this.scriptStore.getRunningRun(input.scriptId);
    if (active) {
      throw new ScriptExecutionConflictError(`Script is already running: ${active.id}`);
    }

    const entry = await this.scriptStore.getEntry(input.scriptId);
    if (!entry) throw new ScriptExecutionValidationError(`Script not found: ${input.scriptId}`);
    const language = normalizeLanguage(entry.language);
    const rawCwd = input.cwdOverride ?? entry.projectDir ?? process.cwd();
    const cwd = resolve(resolveDir(rawCwd));
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new ScriptExecutionValidationError(`Script cwd is not a valid directory: ${cwd}`);
    }

    const environment = await buildExecutionEnvironment({
      settingsStore: this.settingsStore,
      parameterValues: input.parameterValues,
      secretParameterKeys: input.secretParameterKeys,
    });
    const contentSnapshot = entry.content;
    return {
      runId: this.generateId(),
      scriptId: entry.id,
      scriptName: entry.name,
      startedAt: this.now().toISOString(),
      cwd,
      language,
      scriptRevision: scriptRevision(language, contentSnapshot),
      argv: buildInterpreterArgv(language, contentSnapshot),
      env: environment.env,
      secretValues: environment.secretValues,
    };
  }

  async startPreparedExecution(
    plan: PreparedScriptExecution,
    cardId: string,
  ): Promise<ScriptRunAcceptedResponse> {
    const initialRun: ScriptRun = {
      id: plan.runId,
      scriptId: plan.scriptId,
      cardId,
      startedAt: plan.startedAt,
      status: 'running',
      language: plan.language,
      cwd: plan.cwd,
      scriptRevision: plan.scriptRevision,
      ownerPid: process.pid,
    };

    try {
      await this.scriptStore.beginRun(plan.scriptId, initialRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already has a running execution')) {
        await this.failCardBeforeStart(cardId, plan.runId, message);
        throw new ScriptExecutionConflictError(message);
      }
      await this.failCardBeforeStart(cardId, plan.runId, message);
      throw error;
    }

    try {
      await this.cardStore.markScriptExecutionStarted(cardId, plan.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.scriptStore.finishRun(plan.scriptId, plan.runId, {
        status: 'fail',
        finishedAt: this.now().toISOString(),
        error: capExecutionOutput(redactSecrets(message, plan.secretValues)),
      });
      throw error;
    }

    const completion = Promise.resolve()
      .then(() => this.execute(plan, initialRun))
      .finally(() => {
        if (this.completions.get(plan.runId) === completion) {
          this.completions.delete(plan.runId);
        }
      });
    this.completions.set(plan.runId, completion);

    return {
      id: plan.runId,
      scriptId: plan.scriptId,
      cardId,
      runId: plan.runId,
      status: 'running',
      startedAt: plan.startedAt,
    };
  }

  private async failCardBeforeStart(cardId: string, runId: string, message: string): Promise<void> {
    const failureSummary = `[failed] ${message}`;
    await this.cardStore.finalizeScriptExecutionCard(cardId, {
      runId,
      outcome: 'failed',
      failureSummary,
      result: failureSummary,
    }).catch(() => undefined);
  }

  private async execute(plan: PreparedScriptExecution, initialRun: ScriptRun): Promise<ScriptRun> {
    let terminal: ScriptRun;
    try {
      const proc = this.spawn({ argv: [...plan.argv], cwd: plan.cwd, env: { ...plan.env } });
      const maxSecretBytes = plan.secretValues.reduce(
        (max, secret) => Math.max(max, Buffer.byteLength(secret, 'utf8')),
        0,
      );
      const oversizedSecret = maxSecretBytes > EXECUTION_OUTPUT_BYTE_CAP;
      const lookaheadBytes = oversizedSecret ? 0 : maxSecretBytes;
      const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        readCappedStream(proc.stdout, lookaheadBytes),
        readCappedStream(proc.stderr, lookaheadBytes),
        proc.exited,
      ]);
      const stdout = sanitizeCapturedOutput(stdoutRaw, plan.secretValues, oversizedSecret);
      const stderr = sanitizeCapturedOutput(stderrRaw, plan.secretValues, oversizedSecret);
      const success = exitCode === 0;
      terminal = {
        ...initialRun,
        status: success ? 'success' : 'fail',
        finishedAt: this.now().toISOString(),
        exitCode,
        stdout,
        stderr,
        ...(!success ? { error: `Script exited with code ${exitCode}` } : {}),
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = capExecutionOutput(redactSecrets(rawMessage, plan.secretValues))
        ?? 'Script spawn failed';
      terminal = {
        ...initialRun,
        status: 'fail',
        finishedAt: this.now().toISOString(),
        error: message,
      };
    }

    const stored = await this.scriptStore.finishRun(plan.scriptId, plan.runId, {
      status: terminal.status,
      finishedAt: terminal.finishedAt,
      language: terminal.language,
      cwd: terminal.cwd,
      scriptRevision: terminal.scriptRevision,
      ownerPid: terminal.ownerPid,
      cardId: terminal.cardId,
      exitCode: terminal.exitCode,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      error: terminal.error,
    });
    const finalRun = stored ?? terminal;
    const success = finalRun.status === 'success';
    const failureSummary = success
      ? undefined
      : `[failed] ${finalRun.error ?? `Script exited with code ${finalRun.exitCode ?? 'unknown'}`}`;
    await this.cardStore.finalizeScriptExecutionCard(initialRun.cardId!, {
      runId: finalRun.id,
      outcome: success ? 'completed' : 'failed',
      result: formatCardResult(finalRun),
      failureSummary,
    }).catch(() => undefined);

    if (success) {
      await dispatchNextQueuedTodoCard(this.cardStore, initialRun.cardId!, this.dispatchFn);
    }
    return finalRun;
  }

  async waitForRun(runId: string): Promise<ScriptRun> {
    const active = this.completions.get(runId);
    if (active) return active;
    const stored = await this.scriptStore.findRun(runId);
    if (!stored) throw new Error(`Script run not found: ${runId}`);
    return stored;
  }
}
