import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import { resolveDir } from '../../core/data-dir';
import type { CodexReasoningEffort } from '../../core/types';
import {
  CODEX_REASONING_EFFORT_VALUES,
  DEFAULT_CODEX_REASONING_EFFORT,
} from '../../core/runtime-config';

/**
 * Bump when the triage/classify prompts change in a way that should
 * invalidate previous classifications — cards processed with an older
 * version become backfill targets again.
 */
export const WIKI_PROMPT_VERSION = 1;

export const WIKI_SETTING_KEYS = {
  enabled: 'wiki.enabled',
  vaultDir: 'wiki.vault_dir',
  model: 'wiki.model',
  effort: 'wiki.effort',
} as const;

export const WIKI_SETTING_DEFAULTS = {
  // Default OFF: the wiki is opt-in. The worker stays idle until the user
  // explicitly enables it from the WIKI tab (no boot-time auto-seed). The vault
  // path is intentionally blank so onboarding users choose their own directory.
  enabled: 'false',
  vaultDir: '',
  model: 'gpt-5.5',
  effort: DEFAULT_CODEX_REASONING_EFFORT,
} as const;

export interface WikiConfig {
  enabled: boolean;
  vaultDir: string;
  model: string;
  /** Reasoning effort passed to Codex and Claude routes when supported. */
  effort: CodexReasoningEffort;
}

export async function loadWikiConfig(settingsStore: SettingsStore): Promise<WikiConfig> {
  const enabled = await getSettingValueOrDefault(
    settingsStore,
    WIKI_SETTING_KEYS.enabled,
    WIKI_SETTING_DEFAULTS.enabled,
  );
  const vaultDir = await getSettingValueOrDefault(
    settingsStore,
    WIKI_SETTING_KEYS.vaultDir,
    WIKI_SETTING_DEFAULTS.vaultDir,
  );
  const model = await getSettingValueOrDefault(
    settingsStore,
    WIKI_SETTING_KEYS.model,
    WIKI_SETTING_DEFAULTS.model,
  );
  const storedEffort = await getSettingValueOrDefault(
    settingsStore,
    WIKI_SETTING_KEYS.effort,
    WIKI_SETTING_DEFAULTS.effort,
  );
  const effort = CODEX_REASONING_EFFORT_VALUES.includes(storedEffort as CodexReasoningEffort)
    ? (storedEffort as CodexReasoningEffort)
    : DEFAULT_CODEX_REASONING_EFFORT;
  return {
    enabled: enabled === 'true',
    vaultDir: resolveDir(vaultDir),
    model,
    effort,
  };
}
