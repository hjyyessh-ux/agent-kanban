import { useCallback, useEffect, useState } from 'react';
import type { DiscoveredSkill, SkillSyncResult } from '../../../src/core/types';
import { setDynamicSkillCommands } from '../../../src/core/commands';
import { fetchSkills, syncSkills } from './useSkillsApi';

export interface UseSkillsResult {
  skills: DiscoveredSkill[];
  /** Bumps whenever the dynamic command registry changes — use as a memo dep. */
  version: number;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  lastSyncedAt: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<SkillSyncResult | null>;
}

/**
 * Loads skills discovered by the backend and registers them into the shared
 * command registry (`setDynamicSkillCommands`) so the pickers and dispatch see
 * user-authored skills. `version` increments on every registry change so
 * consumers can recompute memoized command lists.
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const apply = useCallback((next: DiscoveredSkill[]) => {
    setDynamicSkillCommands(next);
    setSkills(next);
    setVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await fetchSkills());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncSkills();
      setLastSyncedAt(result.lastSyncedAt);
      // The backend re-registered server-side; refresh our local copy + registry.
      apply(await fetchSkills());
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync skills');
      return null;
    } finally {
      setSyncing(false);
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { skills, version, loading, syncing, error, lastSyncedAt, refresh, sync };
}
