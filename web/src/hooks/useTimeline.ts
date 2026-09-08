import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineSessionSpan } from '../../../src/core/types';
import { fetchTimeline } from './useWorksApi';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';

/** Same cadence as the other non-board views. */
const POLL_INTERVAL_MS = 10_000;

export interface UseTimelineResult {
  sessions: TimelineSessionSpan[];
  /** True only for the first load of a window — a poll must not blank the grid. */
  loading: boolean;
  error: UiAlert | null;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export interface UseTimelineOptions {
  /** Window start, ISO 8601 (the grid's first day at 00:00 local). */
  from: string;
  /** Window end, ISO 8601 (the grid's last day at 23:59:59.999 local). */
  to: string;
  includeSubagents: boolean;
}

/**
 * Executed sessions for one Timeline window.
 *
 * Its own endpoint rather than the Works poll: the grid needs cards that have
 * long since been archived off the board, and the window is what keeps that read
 * bounded. Changing week/month refetches; a stale response from the window the
 * user just left is discarded (`requestRef`), so paging quickly never lands the
 * wrong grid.
 */
export function useTimeline(options: UseTimelineOptions): UseTimelineResult {
  const { from, to, includeSubagents } = options;
  const [sessions, setSessions] = useState<TimelineSessionSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UiAlert | null>(null);
  const requestRef = useRef(0);
  /** Which window the currently held `sessions` belong to. */
  const loadedKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const key = `${from}|${to}|${includeSubagents}`;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (loadedKeyRef.current !== key) setLoading(true);
    try {
      const snapshot = await fetchTimeline({ from, to }, includeSubagents);
      if (requestRef.current !== requestId) return;
      setSessions(snapshot.sessions);
      loadedKeyRef.current = key;
      setError(null);
    } catch (e: unknown) {
      if (requestRef.current !== requestId) return;
      setError(createUiAlert(
        '타임라인을 불러오지 못했습니다',
        e instanceof Error ? e.message : String(e),
        '다시 시도',
      ));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [from, to, includeSubagents]);

  useEffect(() => {
    void load();
  }, [load]);

  // No `enabled` gate: the Timeline view is only mounted while it is the
  // Board tab's active view, so unmounting already stops the polling.
  usePolling(load, POLL_INTERVAL_MS);

  const clearError = useCallback(() => setError(null), []);

  return { sessions, loading, error, refresh: load, clearError };
}
