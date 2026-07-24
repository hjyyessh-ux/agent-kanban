import { useCallback } from 'react';
import type { SchedulerEntry, CreateSchedulerInput, UpdateSchedulerInput, SchedulerRun } from '../../../src/core/types';
import {
  fetchSchedulers,
  createScheduler as apiCreateScheduler,
  updateScheduler as apiUpdateScheduler,
  deleteScheduler as apiDeleteScheduler,
  toggleScheduler as apiToggleScheduler,
  runScheduler as apiRunScheduler,
} from './useSchedulerApi';
import { useCrudResource } from './useCrudResource';
import { createUiAlert, type UiAlert } from './uiAlert';

const ERROR_TITLES: Record<string, string> = {
  fetch: 'Scheduler list unavailable',
  create: 'Could not create scheduler',
  update: 'Scheduler update failed',
  delete: 'Could not delete scheduler',
  toggle: 'Scheduler state change failed',
  run: 'Scheduler run failed',
};

export function useScheduler(enabled: boolean): {
  entries: SchedulerEntry[];
  loading: boolean;
  error: UiAlert | null;
  createEntry: (input: CreateSchedulerInput) => Promise<SchedulerEntry>;
  updateEntry: (id: string, input: UpdateSchedulerInput) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  toggleEntry: (id: string) => Promise<void>;
  runEntry: (id: string) => Promise<SchedulerRun>;
  refreshEntries: () => Promise<void>;
  clearError: () => void;
} {
  const resource = useCrudResource<SchedulerEntry, CreateSchedulerInput, UpdateSchedulerInput, UiAlert>({
    enabled,
    fetchAll: fetchSchedulers,
    create: apiCreateScheduler,
    update: apiUpdateScheduler,
    remove: apiDeleteScheduler,
    fallbackMessages: {
      fetch: 'Failed to fetch schedulers',
      create: 'Failed to create scheduler',
      update: 'Failed to update scheduler',
      delete: 'Failed to delete scheduler',
    },
    makeError: (action, message) =>
      createUiAlert(ERROR_TITLES[action] ?? 'Scheduler error', message, 'Refresh schedulers'),
  });

  const { applyUpdate, reportError, refreshEntries } = resource;

  const toggleEntry = useCallback(async (id: string) => {
    try {
      const entry = await apiToggleScheduler(id);
      applyUpdate(entry);
    } catch (err: unknown) {
      reportError('toggle', err, 'Failed to toggle scheduler');
      throw err;
    }
  }, [applyUpdate, reportError]);

  const runEntry = useCallback(async (id: string): Promise<SchedulerRun> => {
    try {
      const run = await apiRunScheduler(id);
      // Refresh to get updated lastRunAt, lastRunStatus, history
      await refreshEntries();
      return run;
    } catch (err: unknown) {
      reportError('run', err, 'Failed to run scheduler');
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
    toggleEntry,
    runEntry,
    refreshEntries: resource.refreshEntries,
    clearError: resource.clearError,
  };
}
