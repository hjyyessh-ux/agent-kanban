import { useReducer, useEffect, useCallback } from 'react';
import type { SettingsEntry, CreateSettingsInput, UpdateSettingsInput } from '../../../src/core/types';
import {
  fetchSettings,
  createSetting as apiCreateSetting,
  updateSetting as apiUpdateSetting,
  deleteSetting as apiDeleteSetting,
} from './useSettingsApi';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';

interface SettingsState {
  entries: SettingsEntry[];
  loading: boolean;
  error: UiAlert | null;
}

type SettingsAction =
  | { type: 'LOAD'; entries: SettingsEntry[] }
  | { type: 'CREATE'; entry: SettingsEntry }
  | { type: 'UPDATE'; entry: SettingsEntry }
  | { type: 'DELETE'; id: string }
  | { type: 'SET_ERROR'; error: UiAlert }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_LOADING'; loading: boolean };

function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
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
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

const initialState: SettingsState = {
  entries: [],
  loading: true,
  error: null,
};

export function useSettings(enabled: boolean): {
  entries: SettingsEntry[];
  loading: boolean;
  error: UiAlert | null;
  createEntry: (input: CreateSettingsInput) => Promise<SettingsEntry>;
  updateEntry: (id: string, input: UpdateSettingsInput) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  refreshEntries: () => Promise<void>;
  clearError: () => void;
} {
  const [state, dispatch] = useReducer(settingsReducer, initialState);

  const refreshEntries = useCallback(async () => {
    try {
      const entries = await fetchSettings();
      dispatch({ type: 'LOAD', entries });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch settings';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Settings unavailable', message, 'Refresh settings') });
    }
  }, []);

  // Initial fetch on mount (only when enabled)
  useEffect(() => {
    if (enabled) {
      void refreshEntries();
    }
  }, [enabled, refreshEntries]);

  // Poll every 10 seconds (only when tab is active)
  usePolling(refreshEntries, 10000, enabled);

  const createEntry = useCallback(async (input: CreateSettingsInput): Promise<SettingsEntry> => {
    try {
      const entry = await apiCreateSetting(input);
      dispatch({ type: 'CREATE', entry });
      return entry;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create setting';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not create setting', message, 'Refresh settings') });
      throw err;
    }
  }, []);

  const updateEntry = useCallback(async (id: string, input: UpdateSettingsInput) => {
    try {
      const entry = await apiUpdateSetting(id, input);
      dispatch({ type: 'UPDATE', entry });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update setting';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Setting update failed', message, 'Refresh settings') });
      throw err;
    }
  }, []);

  const deleteEntry = useCallback(async (id: string) => {
    try {
      await apiDeleteSetting(id);
      dispatch({ type: 'DELETE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete setting';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not delete setting', message, 'Refresh settings') });
      throw err;
    }
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  return {
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    createEntry,
    updateEntry,
    deleteEntry,
    refreshEntries,
    clearError,
  };
}
