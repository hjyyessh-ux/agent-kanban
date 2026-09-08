import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkSessionsResponse } from '../../../src/core/types';
import { fetchWorkSessions } from './useWorksApi';

export interface UseWorkSessionsResult {
  /** null until the first response for the current Work lands. */
  detail: WorkSessionsResponse | null;
  /** Only true for the first load of a Work — a refetch must not blank the dialog. */
  loading: boolean;
  /** Server message, so the dialog can say why it fell back to board cards. */
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The Work detail dialog's session data (`GET /api/works/:id/sessions`).
 *
 * Not part of `useWorks`: that hook polls the Work *list*, while this is a
 * one-Work read that also parses archive month files, so it runs only while a
 * detail dialog is open. There is no polling for the same reason — pass the
 * Work's `updatedAt` as `revision` and it refetches on every event that can
 * change what it returns (a link, an unlink, a role change, the completion
 * sweep) without blanking what is already on screen.
 *
 * A response for a Work the user has already closed (or switched away from) is
 * discarded via `requestRef`, the same guard `useTimeline` uses for a window the
 * user has paged past.
 */
export function useWorkSessions(
  workId: string | null,
  revision?: string,
): UseWorkSessionsResult {
  const [detail, setDetail] = useState<WorkSessionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  /** Which Work the state currently describes, and at which revision. */
  const loadedRef = useRef<{ workId: string; revision?: string } | null>(null);

  const load = useCallback(async (id: string, isFirst: boolean) => {
    const requestId = ++requestRef.current;
    if (isFirst) {
      // A different Work: drop the previous one's numbers rather than showing
      // them under the new title until the response lands.
      setLoading(true);
      setDetail(null);
      setError(null);
    }
    try {
      const next = await fetchWorkSessions(id);
      if (requestRef.current !== requestId) return;
      setDetail(next);
      setError(null);
    } catch (e: unknown) {
      if (requestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : '세션 정보를 불러오지 못했습니다');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workId) {
      // Bump the request id so an in-flight response for the closed dialog is
      // dropped instead of repopulating it.
      requestRef.current++;
      loadedRef.current = null;
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    const loaded = loadedRef.current;
    if (loaded && loaded.workId === workId && loaded.revision === revision) return;
    const isFirst = loaded?.workId !== workId;
    loadedRef.current = { workId, revision };
    void load(workId, isFirst);
  }, [workId, revision, load]);

  const refresh = useCallback(async () => {
    if (!workId) return;
    await load(workId, false);
  }, [workId, load]);

  return { detail, loading, error, refresh };
}
