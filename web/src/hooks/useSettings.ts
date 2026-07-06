import type { SettingsEntry, CreateSettingsInput, UpdateSettingsInput } from '../../../src/core/types';
import {
  fetchSettings,
  createSetting as apiCreateSetting,
  updateSetting as apiUpdateSetting,
  deleteSetting as apiDeleteSetting,
} from './useSettingsApi';
import { useCrudResource } from './useCrudResource';
import { createUiAlert, type UiAlert } from './uiAlert';

const ERROR_TITLES: Record<string, string> = {
  fetch: 'Settings unavailable',
  create: 'Could not create setting',
  update: 'Setting update failed',
  delete: 'Could not delete setting',
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
  const resource = useCrudResource<SettingsEntry, CreateSettingsInput, UpdateSettingsInput, UiAlert>({
    enabled,
    fetchAll: fetchSettings,
    create: apiCreateSetting,
    update: apiUpdateSetting,
    remove: apiDeleteSetting,
    fallbackMessages: {
      fetch: 'Failed to fetch settings',
      create: 'Failed to create setting',
      update: 'Failed to update setting',
      delete: 'Failed to delete setting',
    },
    makeError: (action, message) =>
      createUiAlert(ERROR_TITLES[action] ?? 'Settings error', message, 'Refresh settings'),
  });

  return {
    entries: resource.entries,
    loading: resource.loading,
    error: resource.error,
    createEntry: resource.createEntry,
    updateEntry: resource.updateEntry,
    deleteEntry: resource.deleteEntry,
    refreshEntries: resource.refreshEntries,
    clearError: resource.clearError,
  };
}
