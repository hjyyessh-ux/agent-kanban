import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';
import { DEFAULT_CLAUDE_MODEL } from '../../core/runtime-config';
import type { WorksConfig, WorksConfigDto, WorksConfigInput } from '../../core/types';
import { resolveWikiLlmRoute } from '../wiki/wiki-llm';

/**
 * Works-scoped settings keys. Mirrors `WIKI_SETTING_KEYS` but under the `works.*`
 * namespace so the Works Summary LLM stays fully independent of the wiki's model.
 */
export const WORKS_SETTING_KEYS = {
  summaryModel: 'works.summary_model',
  summaryLines: 'works.summary_lines',
  assignPreferSameDir: 'works.assign_prefer_same_dir',
  assignSuggestResumeChain: 'works.assign_suggest_resume_chain',
  staleDays: 'works.stale_days',
  doneConfirm: 'works.done_confirm',
} as const;

export const WORKS_SETTING_DEFAULTS = {
  // Default to the standard Claude balance model — Summary generation is opt-in
  // per Work (a button click), so there is no boot-time work; sane defaults let
  // the panel render immediately without a setup gate.
  summaryModel: DEFAULT_CLAUDE_MODEL,
  summaryLines: '4',
  assignPreferSameDir: 'true',
  assignSuggestResumeChain: 'true',
  staleDays: '5',
  // Completing a Work bulk-archives every card under it and cannot be undone,
  // so the confirmation is on unless the user turns it off — the default used to
  // be `false`, which made a single click on the list row's primary button
  // destroy an unbounded number of cards with no prompt and no undo.
  doneConfirm: 'true',
} as const;

/** Allowed Summary line counts — kept in one place for route + config validation. */
export const WORKS_SUMMARY_LINE_OPTIONS = [3, 4, 5] as const;
export type WorksSummaryLineCount = (typeof WORKS_SUMMARY_LINE_OPTIONS)[number];

export function isWorksSummaryLineCount(n: unknown): n is WorksSummaryLineCount {
  return typeof n === 'number' && (WORKS_SUMMARY_LINE_OPTIONS as readonly number[]).includes(n);
}

function parseLines(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return isWorksSummaryLineCount(n) ? n : 4;
}

function parseStaleDays(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}

export async function loadWorksConfig(settingsStore: SettingsStore): Promise<WorksConfig> {
  const [model, lines, preferSameDir, suggestResume, staleDays, doneConfirm] = await Promise.all([
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.summaryModel, WORKS_SETTING_DEFAULTS.summaryModel),
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.summaryLines, WORKS_SETTING_DEFAULTS.summaryLines),
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.assignPreferSameDir, WORKS_SETTING_DEFAULTS.assignPreferSameDir),
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.assignSuggestResumeChain, WORKS_SETTING_DEFAULTS.assignSuggestResumeChain),
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.staleDays, WORKS_SETTING_DEFAULTS.staleDays),
    getSettingValueOrDefault(settingsStore, WORKS_SETTING_KEYS.doneConfirm, WORKS_SETTING_DEFAULTS.doneConfirm),
  ]);
  return {
    summaryModel: model.trim() || WORKS_SETTING_DEFAULTS.summaryModel,
    summaryLines: parseLines(lines),
    assignPreferSameDir: preferSameDir === 'true',
    assignSuggestResumeChain: suggestResume === 'true',
    staleDays: parseStaleDays(staleDays),
    doneConfirm: doneConfirm === 'true',
  };
}

const WORKS_SETTING_KEY_SET = new Set<string>(Object.values(WORKS_SETTING_KEYS));

/** Config + `configured` flag + derived LLM route, for the Works settings panel. */
export async function loadWorksConfigDto(settingsStore: SettingsStore): Promise<WorksConfigDto> {
  const entries = await settingsStore.getEntries();
  const configured = entries.some(e => WORKS_SETTING_KEY_SET.has(e.key));
  const config = await loadWorksConfig(settingsStore);
  return { ...config, configured, route: resolveWikiLlmRoute(config.summaryModel) };
}

/**
 * Persist works settings from the panel. Only provided fields are written
 * (creating the keys on first save), so a partial update never clobbers others.
 */
export async function saveWorksConfig(
  settingsStore: SettingsStore,
  input: WorksConfigInput,
): Promise<WorksConfigDto> {
  const opts = { category: 'works' as const, masked: false };

  if (typeof input.summaryModel === 'string' && input.summaryModel.trim()) {
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.summaryModel, input.summaryModel.trim(), {
      ...opts,
      description: 'Model for Work summary generation (gpt-* → codex CLI, otherwise claude CLI)',
    });
  }
  if (input.summaryLines !== undefined) {
    const lines = isWorksSummaryLineCount(input.summaryLines) ? input.summaryLines : 4;
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.summaryLines, String(lines), {
      ...opts,
      description: 'Number of lines in a generated Work summary (3-5)',
    });
  }
  if (typeof input.assignPreferSameDir === 'boolean') {
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.assignPreferSameDir, input.assignPreferSameDir ? 'true' : 'false', {
      ...opts,
      description: 'Prefer same-projectDir active Works when suggesting Inbox assignments',
    });
  }
  if (typeof input.assignSuggestResumeChain === 'boolean') {
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.assignSuggestResumeChain, input.assignSuggestResumeChain ? 'true' : 'false', {
      ...opts,
      description: 'Auto-suggest the same Work for resume-chain (resumeSessionId) sessions',
    });
  }
  if (input.staleDays !== undefined && Number.isFinite(input.staleDays) && input.staleDays >= 1) {
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.staleDays, String(Math.floor(input.staleDays)), {
      ...opts,
      description: 'Days an active Work can run before the board flags it ⚠ stale',
    });
  }
  if (typeof input.doneConfirm === 'boolean') {
    await settingsStore.upsertByKey(WORKS_SETTING_KEYS.doneConfirm, input.doneConfirm ? 'true' : 'false', {
      ...opts,
      description: 'Show a confirmation dialog before bulk-archiving a Work\'s cards on complete',
    });
  }

  return loadWorksConfigDto(settingsStore);
}
