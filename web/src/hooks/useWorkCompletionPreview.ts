import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkCompletionPreview } from '../../../src/core/types';
import { fetchWorkCompletionPreview } from './useWorksApi';

export interface UseWorkCompletionPreviewResult {
  /** null until the response for the current Work lands (or after a failure). */
  preview: WorkCompletionPreview | null;
  loading: boolean;
  /** Server message, so the dialog can say why it cannot state the scope. */
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * `GET /api/works/:id/completion-preview` for the resolve-confirmation dialog.
 *
 * Read on demand rather than polled: it parses archive month files and consults
 * the runtime run store, and it only matters for the seconds a confirmation
 * dialog is open. Pass `null` while no dialog is open and nothing is fetched.
 *
 * A response for a Work whose dialog has since closed is dropped through
 * `requestRef`, the same guard `useWorkSessions` and `useTimeline` use.
 */
export function useWorkCompletionPreview(workId: string | null): UseWorkCompletionPreviewResult {
  const [preview, setPreview] = useState<WorkCompletionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (id: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchWorkCompletionPreview(id);
      if (requestRef.current !== requestId) return;
      setPreview(next);
    } catch (e: unknown) {
      if (requestRef.current !== requestId) return;
      setPreview(null);
      setError(e instanceof Error ? e.message : '완료 영향 범위를 불러오지 못했습니다');
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workId) {
      // Bump the id so an in-flight response for a dismissed dialog cannot
      // repopulate the state behind the next one.
      requestRef.current++;
      setPreview(null);
      setError(null);
      setLoading(false);
      return;
    }
    void load(workId);
  }, [workId, load]);

  const reload = useCallback(async () => {
    if (!workId) return;
    await load(workId);
  }, [workId, load]);

  return { preview, loading, error, reload };
}
