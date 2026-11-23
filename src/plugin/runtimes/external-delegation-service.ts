import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KanbanStore } from '../../core/store';
import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import type { ExternalDelegationRequest, ExternalDelegationView } from '../../core/types';
import { CODEX_REASONING_EFFORT_VALUES, DEFAULT_CLAUDE_MODEL, isClaudeModelValid } from '../../core/runtime-config';
import { appendRuntimeDebugLog } from '../debug-log';
import type { ManagedDelegationRuntime, RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { crossRuntimeTarget, readDelegationSegments } from './runtime-run-store';
import type { AgentAdapter } from './types';
import { RuntimeDispatchError } from './types';

export const DELEGATION_ENABLED_KEY = 'agent.external_delegation.enabled';
export const DEFAULT_DELEGATION_CODEX_MODEL = 'gpt-6-astra';

/**
 * Server-owned Claude → Codex and Codex → Claude delegation. The parent is identified
 * only by its dispatched card/run ids (never by cwd, time or prompt text); the child
 * card and run id are persisted before any CLI is spawned, and the child card is
 * linked to the session id the child runtime itself reports.
 */
export class ExternalDelegationService {
  constructor(private readonly deps: {
    store: KanbanStore; runStore: RuntimeRunStore; settingsStore: SettingsStore;
    adapterFor: (runtime: ManagedDelegationRuntime) => AgentAdapter;
  }) {}

  private async enabled(): Promise<boolean> {
    return await getSettingValueOrDefault(this.deps.settingsStore, DELEGATION_ENABLED_KEY, 'false') === 'true';
  }

  async start(input: ExternalDelegationRequest): Promise<ExternalDelegationView> {
    if (!await this.enabled()) throw new RuntimeDispatchError('External delegation is disabled', 409);
    if (!input || ['parentCardId', 'parentRunId', 'requestId', 'prompt'].some(key =>
      typeof input[key as keyof ExternalDelegationRequest] !== 'string'
      || !String(input[key as keyof ExternalDelegationRequest]).trim())) {
      throw new RuntimeDispatchError('parentCardId, parentRunId, requestId and prompt are required', 400);
    }
    // The target is derived from the parent run (re-checked under the run lock).
    const parentRun = await this.deps.runStore.getRun(input.parentRunId);
    const runtime = parentRun && parentRun.cardId === input.parentCardId
      ? crossRuntimeTarget(parentRun.runtime) : undefined;
    if (!runtime) throw new RuntimeDispatchError('Parent run is not accepting delegations', 409);

    const model = input.model ?? (runtime === 'codex' ? DEFAULT_DELEGATION_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);
    let reasoningEffort = input.reasoningEffort;
    if (typeof model !== 'string' || !model.trim()) throw new RuntimeDispatchError('Invalid model', 400);
    if (runtime === 'codex') {
      reasoningEffort ??= 'high';
      if (!CODEX_REASONING_EFFORT_VALUES.includes(reasoningEffort)) {
        throw new RuntimeDispatchError('Invalid model or reasoning effort', 400);
      }
    } else if (!isClaudeModelValid(model) || reasoningEffort !== undefined) {
      // Claude children take a catalog model id and have no Codex reasoning effort.
      throw new RuntimeDispatchError('Invalid Claude model or unsupported reasoning effort', 400);
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      parentCardId: input.parentCardId, prompt: input.prompt, model, reasoningEffort,
    })).digest('hex');
    const { run, created } = await this.deps.runStore.reserveDelegation({
      parentCardId: input.parentCardId, parentRunId: input.parentRunId,
      requestId: input.requestId, requestHash, model, childRuntime: runtime,
    }, async reserved => {
      const parent = await this.deps.store.getCard(input.parentCardId);
      if (!parent || (parent.projectDir && resolve(parent.projectDir) !== resolve(reserved.cwd))) {
        throw new RuntimeDispatchError('Parent project no longer matches its run', 409);
      }
      await Bun.write(reserved.promptPath, input.prompt);
      await this.deps.store.createDelegationCard({
        id: reserved.cardId, parentCardId: input.parentCardId, parentRunId: input.parentRunId,
        runId: reserved.runId, prompt: input.prompt, model, cwd: reserved.cwd, reasoningEffort, runtime,
      });
    });
    if (created) {
      void this.execute(run).catch(error => appendRuntimeDebugLog('delegation.finalize.failed', {
        runId: run.runId, error: String(error),
      }));
    }
    return this.get(run.runId);
  }

  private async execute(reserved: RuntimeRun): Promise<void> {
    try {
      const run = await this.deps.runStore.claimDelegation(reserved.runId, () => this.enabled());
      if (!run) throw new RuntimeDispatchError('Delegation was disabled or interrupted before spawn', 409);
      const card = await this.deps.store.getCard(run.cardId);
      if (!card) throw new RuntimeDispatchError('Delegation card was deleted before spawn', 409);
      const runtime = run.runtime === 'claude' || run.runtime === 'codex' ? run.runtime : undefined;
      if (!runtime || card.agentRuntime !== runtime || card.managedDelegation?.runId !== run.runId) {
        throw new RuntimeDispatchError('Delegation card runtime does not match its run', 409);
      }
      const handle = await this.deps.adapterFor(runtime).start({
        card, prompt: await Bun.file(run.promptPath).text(), cwd: run.cwd, reservedRun: run,
      });
      await handle.done;
    } catch (error) {
      const run = await this.deps.runStore.getRun(reserved.runId);
      if (!run || !['starting', 'running'].includes(run.status)) return;
      const message = error instanceof Error ? error.message : String(error);
      const card = await this.deps.store.getCard(run.cardId);
      if (card) await this.deps.store.updateCard(card.id, {
        status: 'complete', resolution: 'failed', progressSummary: `[failed] ${message}`,
        result: card.result || message, staleStatus: null, staleDetectedAt: null,
      }, run.runId);
      await this.deps.runStore.finishRun(run.runId, { status: 'failed', error: message });
    }
  }

  async get(runId: string): Promise<ExternalDelegationView> {
    const run = await this.deps.runStore.getRun(runId);
    if (!run?.delegation) throw new RuntimeDispatchError('Delegation not found', 404);
    const segments = await readDelegationSegments(run);
    const result = segments.join('\n\n') || (existsSync(run.lastMessagePath)
      ? await Bun.file(run.lastMessagePath).text() : undefined);
    return { runId, cardId: run.cardId, parentRunId: run.delegation.parentRunId,
      runtime: run.runtime === 'claude' ? 'claude' : 'codex',
      status: run.status === 'interrupted' ? 'failed' : run.status, sessionId: run.sessionId, result,
      finalResult: segments.at(-1), error: run.error };
  }
}
