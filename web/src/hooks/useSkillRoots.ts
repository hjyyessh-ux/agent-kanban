import { useCallback, useEffect, useState } from 'react';
import type { SkillRoot } from '../../../src/core/types';
import { fetchSkillRoots, addSkillRoot, updateSkillRoot, removeSkillRoot } from './useSkillRootsApi';

export interface UseSkillRootsResult {
  roots: SkillRoot[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: Omit<SkillRoot, 'id'>) => Promise<SkillRoot>;
  update: (id: string, patch: Partial<Omit<SkillRoot, 'id'>>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useSkillRoots(enabled: boolean): UseSkillRootsResult {
  const [roots, setRoots] = useState<SkillRoot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoots(await fetchSkillRoots());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skill roots');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const add = useCallback(
    async (input: Omit<SkillRoot, 'id'>) => {
      const root = await addSkillRoot(input);
      await refresh();
      return root;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Omit<SkillRoot, 'id'>>) => {
      await updateSkillRoot(id, patch);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeSkillRoot(id);
      await refresh();
    },
    [refresh],
  );

  return { roots, loading, error, refresh, add, update, remove };
}
