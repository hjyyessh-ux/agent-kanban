import { useCallback, useEffect, useState } from 'react';
import type { KanbanCard, UpdateCardInput } from '../../../src/core/types';
import { resolveAgentRuntime } from '../../../src/core/runtime-config';
import { resyncCardResult } from './useKanbanApi';
import { RESULT_SYNC_COPY } from '../constants/copy';

export interface CardResultSyncControl {
  syncing: boolean;
  message: string | null;
  tone: 'ok' | 'error';
  sync: () => void;
  /** Set when the session finished the turn but the card is not complete yet. */
  markComplete?: () => void;
}

/** Only CLI sessions leave a transcript to sync from. */
export function canSyncCardResult(card: Pick<KanbanCard, 'sessionId' | 'agentRuntime'>): boolean {
  const runtime = resolveAgentRuntime(card);
  return !!card.sessionId && (runtime === 'claude' || runtime === 'codex');
}

/**
 * Drives the Result phase's ↻ Sync button. The server only rewrites
 * result/finalResult; completing the card stays a separate, explicit click
 * (it reuses the normal status update) so a sync never starts queued work.
 * The board poll brings the refreshed card into the dialog.
 */
export function useCardResultSync(
  card: KanbanCard,
  onUpdate?: (id: string, updates: UpdateCardInput) => void,
): CardResultSyncControl | null {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'ok' | 'error'>('ok');
  const [completable, setCompletable] = useState(false);

  useEffect(() => {
    setSyncing(false);
    setMessage(null);
    setCompletable(false);
  }, [card.id]);

  const sync = useCallback(() => {
    const cardId = card.id;
    setSyncing(true);
    setMessage(null);
    resyncCardResult(cardId)
      .then((res) => {
        const base = res.outcome === 'updated'
          ? RESULT_SYNC_COPY.updated(res.previousLength, res.resultLength)
          : RESULT_SYNC_COPY.unchanged;
        const source = res.source === 'run_events' ? RESULT_SYNC_COPY.fromRunEvents : '';
        const turn = res.turnCompleted ? '' : RESULT_SYNC_COPY.turnIncomplete;
        setTone('ok');
        setMessage(`${base}${source}${turn}`);
        setCompletable(res.turnCompleted && res.card.status !== 'complete' && res.card.status !== 'done');
      })
      .catch((error: unknown) => {
        setTone('error');
        setMessage(RESULT_SYNC_COPY.failed(error instanceof Error ? error.message : String(error)));
        setCompletable(false);
      })
      .finally(() => setSyncing(false));
  }, [card.id]);

  const markComplete = useCallback(() => {
    onUpdate?.(card.id, { status: 'complete' });
    setCompletable(false);
  }, [card.id, onUpdate]);

  if (!canSyncCardResult(card)) return null;
  return {
    syncing,
    message,
    tone,
    sync,
    markComplete: completable && onUpdate && card.status !== 'complete' ? markComplete : undefined,
  };
}
