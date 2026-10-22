import { useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from '../../../src/core/types';
import { fetchSessionCards } from './useKanbanApi';

export interface WorkSearchCards {
  /** Per session: its archive-inclusive cards once fetched, board cards until then. */
  cardsBySession: ReadonlyMap<string, KanbanCard[]>;
  /** Sessions still being fetched — the search can say "보관 카드 불러오는 중". */
  pending: number;
  /** Sessions whose archive read failed; they are searched over board cards only. */
  failed: number;
}

/**
 * The corpus for a Work detail's session search.
 *
 * Board cards alone miss everything already archived — every turn of a
 * completed Work, and the older turns of a long-running one — so each linked
 * session's full history is read with `fetchSessionCards` (archive-inclusive).
 * Lazily: nothing is fetched until `enabled` (the first keystroke), and each
 * session once per dialog, so opening a Work detail costs no extra requests.
 */
export function useWorkSearchCards(
  sessionIds: readonly string[],
  boardCards: readonly KanbanCard[],
  enabled: boolean,
): WorkSearchCards {
  const [fetched, setFetched] = useState<ReadonlyMap<string, KanbanCard[]>>(() => new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const requested = useRef(new Set<string>());
  // A ref, not a per-effect flag: the effect re-runs whenever the session list
  // changes, and a flag cleared by that re-run would drop a response still in
  // flight while `requested` kept it from ever being asked for again.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requested.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    for (const sessionId of sessionIds) {
      if (requested.current.has(sessionId)) continue;
      requested.current.add(sessionId);
      fetchSessionCards(sessionId)
        .then((cards) => {
          if (mounted.current) setFetched((prev) => new Map(prev).set(sessionId, cards));
        })
        .catch(() => {
          // Allow a retry the next time the search is used.
          requested.current.delete(sessionId);
          if (mounted.current) setFailedIds((prev) => new Set(prev).add(sessionId));
        });
    }
  }, [enabled, sessionIds]);

  return useMemo(() => {
    const cardsBySession = new Map<string, KanbanCard[]>();
    const board = new Map<string, KanbanCard[]>();
    for (const card of boardCards) {
      if (!card.sessionId) continue;
      const list = board.get(card.sessionId);
      if (list) list.push(card);
      else board.set(card.sessionId, [card]);
    }
    let pending = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      const full = fetched.get(sessionId);
      if (!full) {
        if (failedIds.has(sessionId)) failed++;
        else if (enabled) pending++;
      }
      cardsBySession.set(sessionId, full ?? board.get(sessionId) ?? []);
    }
    return { cardsBySession, pending, failed };
  }, [sessionIds, boardCards, fetched, failedIds, enabled]);
}
