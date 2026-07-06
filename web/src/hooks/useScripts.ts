import { useCallback } from 'react';
import type { ScriptEntry, ScriptSyncResult, CreateScriptInput, UpdateScriptInput } from '../../../src/core/types';
import {
  fetchScripts,
  createScript as apiCreateScript,
  updateScript as apiUpdateScript,
  deleteScript as apiDeleteScript,
  runScript as apiRunScript,
  syncScripts as apiSyncScripts,
} from './useScriptsApi';
import { useCrudResource } from './useCrudResource';

export function useScripts(enabled: boolean): {
  entries: ScriptEntry[];
  loading: boolean;
  error: string | null;
  createEntry: (input: CreateScriptInput) => Promise<ScriptEntry>;
  updateEntry: (id: string, input: UpdateScriptInput) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  runEntry: (id: string) => Promise<void>;
  refreshEntries: () => Promise<void>;
  syncEntries: () => Promise<ScriptSyncResult>;
} {
  const resource = useCrudResource<ScriptEntry, CreateScriptInput, UpdateScriptInput, string>({
    enabled,
    fetchAll: fetchScripts,
    create: apiCreateScript,
    update: apiUpdateScript,
    remove: apiDeleteScript,
    fallbackMessages: {
      fetch: 'Failed to fetch scripts',
      create: 'Failed to create script',
      update: 'Failed to update script',
      delete: 'Failed to delete script',
    },
    makeError: (_action, message) => message,
  });

  const { reportError, refreshEntries } = resource;

  const runEntry = useCallback(async (id: string) => {
    try {
      await apiRunScript(id);
      await refreshEntries();
    } catch (err: unknown) {
      reportError('run', err, 'Failed to run script');
      throw err;
    }
  }, [refreshEntries, reportError]);

  const syncEntries = useCallback(async (): Promise<ScriptSyncResult> => {
    try {
      const result = await apiSyncScripts();
      await refreshEntries();
      return result;
    } catch (err: unknown) {
      reportError('sync', err, 'Failed to sync scripts');
      throw err;
    }
  }, [refreshEntries, reportError]);

  return {
    entries: resource.entries,
    loading: resource.loading,
    error: resource.error,
    createEntry: resource.createEntry,
    updateEntry: resource.updateEntry,
    deleteEntry: resource.deleteEntry,
    runEntry,
    refreshEntries: resource.refreshEntries,
    syncEntries,
  };
}
