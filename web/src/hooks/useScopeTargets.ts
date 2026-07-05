import { useCallback, useEffect, useState } from 'react';
import type { PlacementTarget, CreatePlacementTargetInput } from '../../../src/core/types';

const BASE_URL = '/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function fetchTargets(): Promise<PlacementTarget[]> {
  const res = await fetch(`${BASE_URL}/scope/targets`);
  return handleResponse<PlacementTarget[]>(res);
}

async function apiAddTarget(input: CreatePlacementTargetInput): Promise<PlacementTarget> {
  const res = await fetch(`${BASE_URL}/scope/targets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<PlacementTarget>(res);
}

async function apiRemoveTarget(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/scope/targets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    await handleResponse<never>(res);
  }
}

export interface UseScopeTargetsResult {
  targets: PlacementTarget[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addTarget: (input: CreatePlacementTargetInput) => Promise<PlacementTarget>;
  removeTarget: (id: string) => Promise<void>;
}

export function useScopeTargets(enabled: boolean): UseScopeTargetsResult {
  const [targets, setTargets] = useState<PlacementTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTargets(await fetchTargets());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load placement targets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const addTarget = useCallback(
    async (input: CreatePlacementTargetInput) => {
      const target = await apiAddTarget(input);
      await refresh();
      return target;
    },
    [refresh],
  );

  const removeTarget = useCallback(
    async (id: string) => {
      await apiRemoveTarget(id);
      await refresh();
    },
    [refresh],
  );

  return { targets, loading, error, refresh, addTarget, removeTarget };
}
