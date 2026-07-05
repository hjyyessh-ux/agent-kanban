import { useEffect, useState } from 'react';
import type { CardRunProgress } from '../../../src/core/types';

const BASE_URL = '/api';
const LIVE_POLL_INTERVAL_MS = 3000;

/**
 * Load the intermediate-step timeline of a card's latest runtime run.
 * While `live` (card in_progress) the endpoint is re-polled every 3s so the
 * detail dialog shows what the agent is doing in real time; otherwise it is
 * fetched once per card. 404 means "no claude/codex run for this card"
 * (e.g. opencode cards) and resolves to null without surfacing an error.
 */
export function useCardProgress(cardId: string | undefined, live: boolean): CardRunProgress | null {
  const [progress, setProgress] = useState<CardRunProgress | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!cardId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(cardId)}/progress`);
        if (!res.ok) {
          if (!cancelled && res.status === 404) setProgress(null);
          return; // non-404 errors keep the last known progress
        }
        const data = (await res.json()) as CardRunProgress;
        if (!cancelled) setProgress(data);
      } catch {
        // network hiccup — keep the last known progress
      }
    };

    void load();
    if (!live) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => void load(), LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cardId, live]);

  return progress;
}
