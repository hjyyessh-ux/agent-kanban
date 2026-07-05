import { useReducer, useEffect, useCallback } from 'react';
import type { SchedulerEntry, CreateSchedulerInput, UpdateSchedulerInput } from '../../../src/core/types';
import {
  fetchSchedulers,
  createScheduler as apiCreateScheduler,
  updateScheduler as apiUpdateScheduler,
  deleteScheduler as apiDeleteScheduler,
  toggleScheduler as apiToggleScheduler,
  runScheduler as apiRunScheduler,
} from './useSchedulerApi';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';

interface SchedulerState {
  entries: SchedulerEntry[];
  loading: boolean;
  error: UiAlert | null;
}

type SchedulerAction =
  | { type: 'LOAD'; entries: SchedulerEntry[] }
  | { type: 'CREATE'; entry: SchedulerEntry }
  | { type: 'UPDATE'; entry: SchedulerEntry }
  | { type: 'DELETE'; id: string }
  | { type: 'SET_ERROR'; error: UiAlert }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_LOADING'; loading: boolean };

function schedulerReducer(state: SchedulerState, action: SchedulerAction): SchedulerState {
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

const initialState: SchedulerState = {
  entries: [],
  loading: true,
  error: null,
};

export function useScheduler(enabled: boolean): {
  entries: SchedulerEntry[];
  loading: boolean;
  error: UiAlert | null;
  createEntry: (input: CreateSchedulerInput) => Promise<SchedulerEntry>;
  updateEntry: (id: string, input: UpdateSchedulerInput) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  toggleEntry: (id: string) => Promise<void>;
  runEntry: (id: string) => Promise<void>;
  refreshEntries: () => Promise<void>;
  clearError: () => void;
} {
  const [state, dispatch] = useReducer(schedulerReducer, initialState);

  const refreshEntries = useCallback(async () => {
    try {
      const entries = await fetchSchedulers();
      dispatch({ type: 'LOAD', entries });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch schedulers';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Scheduler list unavailable', message, 'Refresh schedulers') });
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

  const createEntry = useCallback(async (input: CreateSchedulerInput): Promise<SchedulerEntry> => {
    try {
      const entry = await apiCreateScheduler(input);
      dispatch({ type: 'CREATE', entry });
      return entry;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create scheduler';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not create scheduler', message, 'Refresh schedulers') });
      throw err;
    }
  }, []);

  const updateEntry = useCallback(async (id: string, input: UpdateSchedulerInput) => {
    try {
      const entry = await apiUpdateScheduler(id, input);
      dispatch({ type: 'UPDATE', entry });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update scheduler';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Scheduler update failed', message, 'Refresh schedulers') });
      throw err;
    }
  }, []);

  const deleteEntry = useCallback(async (id: string) => {
    try {
      await apiDeleteScheduler(id);
      dispatch({ type: 'DELETE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete scheduler';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not delete scheduler', message, 'Refresh schedulers') });
      throw err;
    }
  }, []);

  const toggleEntry = useCallback(async (id: string) => {
    try {
      const entry = await apiToggleScheduler(id);
      dispatch({ type: 'UPDATE', entry });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to toggle scheduler';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Scheduler state change failed', message, 'Refresh schedulers') });
      throw err;
    }
  }, []);

  const runEntry = useCallback(async (id: string) => {
    try {
      await apiRunScheduler(id);
      // Refresh to get updated lastRunAt, lastRunStatus, history
      await refreshEntries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to run scheduler';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Scheduler run failed', message, 'Refresh schedulers') });
      throw err;
    }
  }, [refreshEntries]);

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
    toggleEntry,
    runEntry,
    refreshEntries,
    clearError,
  };
}
