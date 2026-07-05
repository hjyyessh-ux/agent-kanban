import { useReducer, useEffect, useCallback } from 'react';
import type { ScriptEntry, ScriptSyncResult, CreateScriptInput, UpdateScriptInput } from '../../../src/core/types';
import {
  fetchScripts,
  createScript as apiCreateScript,
  updateScript as apiUpdateScript,
  deleteScript as apiDeleteScript,
  runScript as apiRunScript,
  syncScripts as apiSyncScripts,
} from './useScriptsApi';
import { usePolling } from './usePolling';

interface ScriptsState {
  entries: ScriptEntry[];
  loading: boolean;
  error: string | null;
}

type ScriptsAction =
  | { type: 'LOAD'; entries: ScriptEntry[] }
  | { type: 'CREATE'; entry: ScriptEntry }
  | { type: 'UPDATE'; entry: ScriptEntry }
  | { type: 'DELETE'; id: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_LOADING'; loading: boolean };

function scriptsReducer(state: ScriptsState, action: ScriptsAction): ScriptsState {
  switch (action.type) {
    case 'LOAD':
      return { ...state, entries: action.entries, loading: false, error: null };
    case 'CREATE':
      return { ...state, entries: [...state.entries, action.entry] };
    case 'UPDATE':
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.entry.id ? action.entry : e)),
      };
    case 'DELETE':
      return { ...state, entries: state.entries.filter((e) => e.id !== action.id) };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

const initialState: ScriptsState = {
  entries: [],
  loading: true,
  error: null,
};

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
  const [state, dispatch] = useReducer(scriptsReducer, initialState);

  const refreshEntries = useCallback(async () => {
    try {
      const entries = await fetchScripts();
      dispatch({ type: 'LOAD', entries });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch scripts';
      dispatch({ type: 'SET_ERROR', error: message });
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void refreshEntries();
    }
  }, [enabled, refreshEntries]);

  usePolling(refreshEntries, 10000, enabled);

  const createEntry = useCallback(async (input: CreateScriptInput): Promise<ScriptEntry> => {
    try {
      const entry = await apiCreateScript(input);
      dispatch({ type: 'CREATE', entry });
      return entry;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create script';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, []);

  const updateEntry = useCallback(async (id: string, input: UpdateScriptInput) => {
    try {
      const entry = await apiUpdateScript(id, input);
      dispatch({ type: 'UPDATE', entry });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update script';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, []);

  const deleteEntry = useCallback(async (id: string) => {
    try {
      await apiDeleteScript(id);
      dispatch({ type: 'DELETE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete script';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, []);

  const runEntry = useCallback(async (id: string) => {
    try {
      await apiRunScript(id);
      await refreshEntries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to run script';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, [refreshEntries]);

  const syncEntries = useCallback(async (): Promise<ScriptSyncResult> => {
    try {
      const result = await apiSyncScripts();
      await refreshEntries();
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to sync scripts';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, [refreshEntries]);

  return {
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    createEntry,
    updateEntry,
    deleteEntry,
    runEntry,
    refreshEntries,
    syncEntries,
  };
}
