import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { KanbanStore } from '../../core/store';
import type { CardResultResyncResponse, KanbanCard } from '../../core/types';
import { resolveAgentRuntime } from '../../core/runtime-config';
import { locateSessionTranscript, type SessionTranscriptLocation } from '../wiki/wiki-transcript';
import type { RuntimeRun, RuntimeRunStore } from './runtime-run-store';
import {
  extractClaudeTurn,
  extractCodexTurn,
  extractRunEventsTurn,
  type TurnExtraction,
} from './transcript-turn';

/**
 * `POST /api/cards/:id/resync` — re-pull a card's result from the session it
 * ran in. See `transcript-turn.ts` for how the turn is located.
 *
 * Only `result` / `finalResult` are written (together, as everywhere else).
 * Status is never touched here: completing a card is what fires queue
 * auto-dispatch / Telegram on the runtime paths, and a sync button must not
 * start the next queued task as a side effect. The response says whether the
 * CLI finished the turn so the UI can offer the existing "mark complete" action.
 */

export type ResyncFailureReason =
  | 'unsupported_runtime'
  | 'no_session'
  | 'run_active'
  | 'transcript_not_found'
  | 'prompt_not_found'
  | 'empty_turn';

export class CardResultResyncError extends Error {
  constructor(readonly reason: ResyncFailureReason, readonly status: number, message: string) {
    super(message);
  }
}

const FAILURE_MESSAGES: Record<ResyncFailureReason, [number, string]> = {
  unsupported_runtime: [400, 'Result sync supports claude/codex cards only'],
  no_session: [409, 'Card has no session to sync from'],
  run_active: [409, 'Card is still running — sync after the run ends'],
  transcript_not_found: [404, 'Session transcript not found (Claude Code deletes transcripts after 30 days)'],
  prompt_not_found: [404, "This card's prompt is not in the session transcript — the turn never ran there"],
  empty_turn: [404, 'The matched turn has no assistant text yet'],
};

function fail(reason: ResyncFailureReason): never {
  const [status, message] = FAILURE_MESSAGES[reason];
  throw new CardResultResyncError(reason, status, message);
}

export interface CardResultResyncDeps {
  store: KanbanStore;
  runStore?: RuntimeRunStore;
  /** Test seam; defaults to the shared transcript locator. */
  locateTranscript?: (sessionId: string, projectDir?: string) => SessionTranscriptLocation | undefined;
}

async function latestRun(runStore: RuntimeRunStore | undefined, cardId: string): Promise<RuntimeRun | undefined> {
  if (!runStore) return undefined;
  const runs = (await runStore.listRuns()).filter(run => run.cardId === cardId);
  return runs.reduce<RuntimeRun | undefined>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), undefined);
}

/**
 * The prompt the card sent and when. A board-dispatched card sent its run's
 * `prompt.md` (the description wrapped by `buildDispatchPromptText`), at the
 * run's start; an organic CLI card's description IS the prompt, minted by the
 * prompt hook the moment it was submitted.
 */
async function promptQuery(card: KanbanCard, run: RuntimeRun | undefined): Promise<{ prompt: string; anchorAt: string }> {
  if (run && existsSync(run.promptPath)) {
    return { prompt: await readFile(run.promptPath, 'utf8'), anchorAt: run.startedAt };
  }
  return { prompt: card.description ?? '', anchorAt: card.startedAt ?? card.createdAt };
}

function shouldReplace(existing: string | undefined, next: string): boolean {
  const current = existing?.trim() ?? '';
  if (!current || current === '(no output)') return true;
  // Never regress: a sync only adds what the card is missing.
  return next.trim().length > current.length;
}

export async function resyncCardResult(deps: CardResultResyncDeps, cardId: string): Promise<CardResultResyncResponse> {
  const card = await deps.store.getCard(cardId);
  if (!card) throw new CardResultResyncError('no_session', 404, 'Card not found');

  const runtime = resolveAgentRuntime(card);
  if (runtime !== 'claude' && runtime !== 'codex') fail('unsupported_runtime');
  if (!card.sessionId) fail('no_session');
  if (deps.runStore && await deps.runStore.findActiveRunByCard(card.id)) fail('run_active');

  const run = await latestRun(deps.runStore, card.id);
  const query = await promptQuery(card, run);
  const locate = deps.locateTranscript ?? locateSessionTranscript;
  const located = locate(card.sessionId, card.projectDir);

  let extraction: TurnExtraction;
  let source: CardResultResyncResponse['source'];
  if (located) {
    const raw = await readFile(located.path, 'utf8');
    extraction = located.format === 'codex' ? extractCodexTurn(raw, query) : extractClaudeTurn(raw, query);
    source = 'transcript';
  } else if (run && existsSync(run.eventsPath)) {
    extraction = extractRunEventsTurn(await readFile(run.eventsPath, 'utf8'), run.runtime);
    source = 'run_events';
  } else {
    fail('transcript_not_found');
  }
  if (!extraction.ok) fail(extraction.reason);

  const { turn } = extraction;
  const previousLength = card.result?.length ?? 0;
  if (!shouldReplace(card.result, turn.result)) {
    return { outcome: 'unchanged', source, turnCompleted: turn.completed, previousLength, resultLength: previousLength, card };
  }
  const updated = await deps.store.updateCard(card.id, { result: turn.result, finalResult: turn.finalResult });
  return {
    outcome: 'updated',
    source,
    turnCompleted: turn.completed,
    previousLength,
    resultLength: turn.result.length,
    card: updated,
  };
}
