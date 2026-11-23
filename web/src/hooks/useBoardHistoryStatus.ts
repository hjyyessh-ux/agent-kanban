import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardHistoryStatusSummary } from '../../../src/core/types';
import { usePolling } from './usePolling';
import { BOARD_HISTORY_COPY } from '../constants/copy';

export interface BoardHistoryStatusFailure {
  message: string;
  /** Client time of the failed attempt. */
  at: string;
}

/** Maps a failed read to fixed copy; server error bodies are never echoed. */
export function boardHistoryFailureMessage(status: number | null): string {
  if (status === 401) return BOARD_HISTORY_COPY.errorUnauthorized;
  if (status === 403) return BOARD_HISTORY_COPY.errorLocalOnly;
  return BOARD_HISTORY_COPY.errorTemporary;
}

/**
 * Read-only status of the Card/Works History subscription. A failed read keeps
 * the last successful summary (and says so) instead of blanking it, so a
 * transient error is never shown as "subscription OFF".
 */
export function useBoardHistoryStatus() {
  const [summary, setSummary] = useState<BoardHistoryStatusSummary | null>(null);
  const [failure, setFailure] = useState<BoardHistoryStatusFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [manualRefreshStatus, setManualRefreshStatus] = useState('');
  const requestVersion = useRef(0);
  /** `manual` marks the button press: only it shows the in-flight state. Polls stay quiet. */
  const refresh = useCallback(async (manual: boolean = false) => {
    const version = ++requestVersion.current;
    if (manual) { setRefreshing(true); setManualRefreshStatus(''); }
    let status: number | null = null;
    try {
      const response = await fetch('/api/board-history-status', { method: 'GET', cache: 'no-store' });
      status = response.status;
      if (!response.ok) throw new Error('board_history_status_failed');
      const next = await response.json() as BoardHistoryStatusSummary;
      if (version !== requestVersion.current) return;
      setSummary(next);
      setFailure(null);
      if (manual) setManualRefreshStatus(BOARD_HISTORY_COPY.refreshSucceeded);
    } catch {
      if (version !== requestVersion.current) return;
      setFailure({ message: boardHistoryFailureMessage(status), at: new Date().toISOString() });
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);
  const poll = useCallback(() => refresh(false), [refresh]);
  useEffect(() => { void poll(); return () => { requestVersion.current++; }; }, [poll]);
  usePolling(poll, 10000);
  return { summary, failure, refreshing, refresh, manualRefreshStatus };
}
