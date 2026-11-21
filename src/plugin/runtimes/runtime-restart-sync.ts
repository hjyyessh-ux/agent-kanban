import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { KanbanStore } from '../../core/store';
import type { DispatchResult, KanbanCard, UpdateCardInput } from '../../core/types';
import { dispatchNextQueuedTodoCard } from '../hooks/event-handler';
import { appendRuntimeDebugLog } from '../debug-log';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import { extractRunEventsTurn } from './transcript-turn';

type CardExecution = Pick<KanbanCard, 'id' | 'agentRuntime' | 'sessionId' | 'startedAt'>;
interface Completion {
  result: string;
  finalResult?: string;
  completedAt: string;
}
const INTERACTIVE_SOURCES = new Set(['claude-code', 'codex']);
const UNVERIFIED = '[restart sync] Completion could not be verified for the latest run.';

export function matchesInProgressExecution(card: KanbanCard, expected: CardExecution): boolean {
  return !card.deletedAt && card.status === 'in_progress' && card.agentRuntime === expected.agentRuntime
    && card.sessionId === expected.sessionId && card.startedAt === expected.startedAt;
}

export function completeRuntimeCard(store: KanbanStore, expected: CardExecution, completion: Completion) {
  return store.updateCardIf(expected.id, {
    ...completion,
    responseAt: completion.completedAt,
    status: 'complete',
    resolution: 'completed',
    completedSeenAt: null,
    progressSummary: undefined,
    staleStatus: null,
    staleDetectedAt: null,
    queuedAfterCardId: null,
    queuePosition: null,
    queueSessionMode: null,
    resumeSessionId: null,
  }, card => matchesInProgressExecution(card, expected));
}

export function completeTrackedRuntimeCard(
  store: KanbanStore,
  runStore: RuntimeRunStore,
  run: RuntimeRun,
  result: string,
  finalResult: string | undefined,
) {
  return runStore.withLatestRun(run.cardId, run.runId, async current => {
    if (current?.status !== 'completed' || !current.finishedAt) return;
    return completeRuntimeCard(store, {
      id: current.cardId,
      agentRuntime: current.runtime,
      sessionId: current.sessionId,
      startedAt: current.startedAt,
    }, { result, finalResult, completedAt: current.finishedAt });
  });
}

export function updateFailedRuntimeCard(
  store: KanbanStore,
  runStore: RuntimeRunStore,
  run: RuntimeRun,
  original: KanbanCard,
  update: UpdateCardInput,
) {
  return runStore.withLatestRun(run.cardId, run.runId, current => {
    if (!current || (current.status !== 'failed' && current.status !== 'aborted')) return Promise.resolve(undefined);
    return store.updateCardIf(run.cardId, update, card => matchesInProgressExecution(card, {
      id: current.cardId,
      agentRuntime: current.runtime,
      sessionId: current.sessionId,
      startedAt: current.startedAt,
    }) || (!card.deletedAt && card.status === 'todo' && card.updatedAt === original.updatedAt
      && card.sessionId === original.sessionId && card.startedAt === original.startedAt));
  });
}

function hasSuccessfulTerminalEvent(raw: string, run: RuntimeRun): boolean {
  let terminals = 0;
  let codexTurnStarts = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Reject malformed records and contradictions anywhere in the run.
    const event = JSON.parse(line) as Record<string, unknown> | null;
    if (!event || typeof event.type !== 'string' || event.type === 'error') return false;
    if (run.runtime === 'claude') {
      if (event.session_id && event.session_id !== run.sessionId) return false;
      if (terminals && (event.type === 'assistant' || event.type === 'user')) return false;
      if (event.type !== 'result') continue;
      if (event.subtype !== 'success' || event.is_error !== false) return false;
      terminals++;
    } else {
      if (event.type === 'thread.started' && event.thread_id !== run.sessionId) return false;
      if (event.type === 'turn.failed' || event.type === 'turn.interrupted') return false;
      if (event.type === 'turn.started' && (++codexTurnStarts > 1 || terminals > 0)) return false;
      if (event.type === 'turn.completed') terminals++;
    }
  }
  return terminals === 1;
}

function canRecoverRun(run: RuntimeRun, card: KanbanCard): boolean {
  return Boolean(card.sessionId) && run.sessionId === card.sessionId && run.runtime === card.agentRuntime
    && !run.error && ((run.status === 'completed' && run.exitCode === 0)
      || (run.status === 'interrupted' && run.exitCode === undefined));
}

async function readCompletion(run: RuntimeRun, runDir: string): Promise<Completion | undefined> {
  if (run.eventsPath !== join(runDir, 'events.jsonl')) return;
  const raw = await readFile(run.eventsPath, 'utf8');
  if (!hasSuccessfulTerminalEvent(raw, run)) return;
  const completedAt = run.finishedAt ?? (await stat(run.eventsPath)).mtime.toISOString();
  if (!(Date.parse(completedAt) >= Date.parse(run.startedAt))) return;
  const extraction = extractRunEventsTurn(raw, run.runtime);
  if (extraction.ok) {
    return { result: extraction.turn.result, finalResult: extraction.turn.finalResult, completedAt };
  }
  const lastMessage = Bun.file(join(runDir, 'last-message.md'));
  if (await lastMessage.exists()) {
    const result = (await lastMessage.text()).trim();
    if (result) return { result, completedAt };
  }
  return { result: '(no output)', completedAt };
}

export async function syncInterruptedCards(
  store: KanbanStore,
  runStore: RuntimeRunStore,
  bootCards: KanbanCard[],
  bootRuns: RuntimeRun[] | undefined,
  dispatch: (cardId: string) => Promise<DispatchResult>,
): Promise<void> {
  const latest = new Map(bootRuns?.map(run => [run.cardId, run]));
  for (const card of bootCards) {
    if (card.executionKind === 'script' || card.linkKind === 'subagent') continue;
    if (card.agentRuntime !== 'claude' && card.agentRuntime !== 'codex') continue;
    const run = latest.get(card.id);
    let completion: Completion | undefined;
    // Interactive cards with no board run belong to their external Stop hook.
    if (!run && card.sourceContext && INTERACTIVE_SOURCES.has(card.sourceContext)) continue;
    if (run && run.runtime === card.agentRuntime && run.sessionId && run.sessionId === card.sessionId
      && !run.error && (run.status === 'starting' || run.status === 'running' || canRecoverRun(run, card))) {
      try {
        completion = await readCompletion(run, runStore.getRunDir(run.runId));
      } catch {
        // Parse errors can include snippets of runtime output; don't log them.
        appendRuntimeDebugLog('runtime.restartSync.unreadable', { runId: run.runId });
      }
    }

    const markUnverified = () => store.updateCardIf(card.id, {
      progressSummary: UNVERIFIED,
      staleStatus: 'orphan',
      staleDetectedAt: card.staleDetectedAt ?? new Date().toISOString(),
    }, current => matchesInProgressExecution(current, card) && current.updatedAt === card.updatedAt
      && (current.staleStatus !== 'orphan' || current.progressSummary !== UNVERIFIED));

    if (!bootRuns) {
      await markUnverified();
      continue;
    }
    const completed = await runStore.withLatestRun(card.id, run?.runId, async current => {
      if (completion && current && canRecoverRun(current, card)) {
        return completeRuntimeCard(store, card, {
          ...completion, completedAt: current.finishedAt ?? completion.completedAt,
        });
      }
      await markUnverified();
    });
    if (completed) await dispatchNextQueuedTodoCard(store, card.id, dispatch);
  }
}
