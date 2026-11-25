import type { SettingsStore } from '../../core/settings-store';
import { runtimeOptionDefaultsFromSettings, type RuntimeOptionDefaults } from '../../core/runtime-options';

/**
 * Reads the Settings "실행 기본값" at dispatch time. No store (tests, minimal
 * hosts) → built-in defaults plus the legacy Codex bypass env fallback.
 */
export async function loadRuntimeOptionDefaults(settingsStore?: SettingsStore): Promise<RuntimeOptionDefaults> {
  const entries = settingsStore ? await settingsStore.getEntries() : [];
  const values = new Map(entries.map(entry => [entry.key, entry.value]));
  return runtimeOptionDefaultsFromSettings(key => values.get(key), process.env);
}
