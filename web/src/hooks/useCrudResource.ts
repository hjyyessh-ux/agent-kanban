import { useReducer, useEffect, useCallback, useRef } from 'react';
import { usePolling } from './usePolling';

export type CrudAction = 'fetch' | 'create' | 'update' | 'delete';

export interface CrudState<T, E> {
  entries: T[];
  loading: boolean;
  error: E | null;
}

export type CrudReducerAction<T, E> =
  | { type: 'LOAD'; entries: T[] }
  | { type: 'CREATE'; entry: T }
  | { type: 'UPDATE'; entry: T }
  | { type: 'DELETE'; id: string }
  | { type: 'SET_ERROR'; error: E }
  | { type: 'CLEAR_ERROR' };

export function crudReducer<T extends { id: string }, E>(
  state: CrudState<T, E>,
  action: CrudReducerAction<T, E>,
): CrudState<T, E> {
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
    default:
      return state;
  }
}

export interface CrudResourceOptions<T extends { id: string }, C, U, E> {
  enabled: boolean;
  fetchAll: () => Promise<T[]>;
  create: (input: C) => Promise<T>;
  update: (id: string, input: U) => Promise<T>;
  remove: (id: string) => Promise<void>;
  /** Fallback message per action when the thrown error carries none. */
  fallbackMessages: Record<CrudAction, string>;
  /** Builds the hook's error value (UiAlert, string, …) from an action + message. */
  makeError: (action: CrudAction | string, message: string) => E;
  /** Poll interval while enabled; defaults to the app-wide 10s. */
  pollMs?: number;
}

export interface CrudResource<T extends { id: string }, C, U, E> {
  entries: T[];
  loading: boolean;
  error: E | null;
  refreshEntries: () => Promise<void>;
  createEntry: (input: C) => Promise<T>;
  updateEntry: (id: string, input: U) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  clearError: () => void;
  /** Replace one entry in place — for extra mutations (toggle, …). */
  applyUpdate: (entry: T) => void;
  /** Surface an error from an extra mutation through the shared state. */
  reportError: (action: CrudAction | string, err: unknown, fallbackMessage: string) => void;
}

/**
 * Shared list-CRUD state machine behind useScheduler/useScripts/useSettings:
 * reducer-backed entries, initial fetch + 10s polling while the tab is
 * enabled, and per-action error mapping. Extra per-resource mutations are
 * built in the wrapping hook via applyUpdate/reportError/refreshEntries.
 */
export function useCrudResource<T extends { id: string }, C, U, E>(
  options: CrudResourceOptions<T, C, U, E>,
): CrudResource<T, C, U, E> {
  const [state, dispatch] = useReducer(
    crudReducer as (
      state: CrudState<T, E>,
      action: CrudReducerAction<T, E>,
    ) => CrudState<T, E>,
    { entries: [], loading: true, error: null },
  );

  // Keep option callbacks in a ref so the exposed callbacks stay stable
  // across renders (the original per-resource hooks had empty dep arrays).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const reportError = useCallback((action: CrudAction | string, err: unknown, fallbackMessage: string) => {
    const message = err instanceof Error ? err.message : fallbackMessage;
    dispatch({ type: 'SET_ERROR', error: optionsRef.current.makeError(action, message) });
  }, []);

  const refreshEntries = useCallback(async () => {
    try {
      const entries = await optionsRef.current.fetchAll();
      dispatch({ type: 'LOAD', entries });
    } catch (err: unknown) {
      reportError('fetch', err, optionsRef.current.fallbackMessages.fetch);
    }
  }, [reportError]);

  // Initial fetch on mount (only when enabled)
  const { enabled } = options;
  useEffect(() => {
    if (enabled) {
      void refreshEntries();
    }
  }, [enabled, refreshEntries]);

  // Poll while the tab is active
  usePolling(refreshEntries, options.pollMs ?? 10000, enabled);

  const createEntry = useCallback(async (input: C): Promise<T> => {
    try {
      const entry = await optionsRef.current.create(input);
      dispatch({ type: 'CREATE', entry });
      return entry;
    } catch (err: unknown) {
      reportError('create', err, optionsRef.current.fallbackMessages.create);
      throw err;
    }
  }, [reportError]);

  const updateEntry = useCallback(async (id: string, input: U) => {
    try {
      const entry = await optionsRef.current.update(id, input);
      dispatch({ type: 'UPDATE', entry });
    } catch (err: unknown) {
      reportError('update', err, optionsRef.current.fallbackMessages.update);
      throw err;
    }
  }, [reportError]);

  const deleteEntry = useCallback(async (id: string) => {
    try {
      await optionsRef.current.remove(id);
      dispatch({ type: 'DELETE', id });
    } catch (err: unknown) {
      reportError('delete', err, optionsRef.current.fallbackMessages.delete);
      throw err;
    }
  }, [reportError]);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  const applyUpdate = useCallback((entry: T) => {
    dispatch({ type: 'UPDATE', entry });
  }, []);

  return {
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    refreshEntries,
    createEntry,
    updateEntry,
    deleteEntry,
    clearError,
    applyUpdate,
    reportError,
  };
}
