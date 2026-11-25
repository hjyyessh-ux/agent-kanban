import React, { useId, useMemo, useState } from 'react';
import type { SettingsEntry } from '../../../../src/core/types';
import { CLAUDE_EFFORT_VALUES, CODEX_REASONING_EFFORT_VALUES, CODEX_SANDBOX_VALUES } from '../../../../src/core/runtime-config';
import {
  BUILTIN_RUNTIME_OPTION_DEFAULTS,
  CLAUDE_EFFORT_SETTING_KEY,
  CLAUDE_PERMISSION_MODE_SETTING_KEY,
  CLAUDE_PERMISSION_MODE_VALUES,
  CLAUDE_SKIP_PERMISSIONS_SETTING_KEY,
  CODEX_BYPASS_SETTING_KEY,
  CODEX_REASONING_EFFORT_SETTING_KEY,
  CODEX_SANDBOX_SETTING_KEY,
  CODEX_SKIP_GIT_REPO_CHECK_SETTING_KEY,
  claudeOptionArgs,
  codexOptionArgs,
  resolveClaudeOptions,
  resolveCodexOptions,
  runtimeOptionDefaultsFromSettings,
} from '../../../../src/core/runtime-options';
import { upsertSettingByKey } from '../../hooks/useSettingsApi';
import { RUNTIME_DEFAULTS_COPY as COPY } from '../../constants/copy';

interface RuntimeDefaultsPanelProps {
  entries: SettingsEntry[];
  onSaved: () => Promise<void>;
}

type GroupId = 'claude' | 'codex';

const DANGER_VALUES = new Set(['bypassPermissions', 'danger-full-access']);
const CLAUDE_EFFORT_CHOICES = ['auto', ...CLAUDE_EFFORT_VALUES];

interface ChoiceRowProps {
  label: string;
  settingKey: string;
  values: readonly string[];
  value: string;
  builtin: string;
  disabled?: boolean;
  hint?: string;
  lockedHint?: string;
  onChange: (value: string) => void;
}

const ChoiceRow: React.FC<ChoiceRowProps> = ({
  label, settingKey, values, value, builtin, disabled, hint, lockedHint, onChange,
}) => {
  const labelId = useId();
  return (
    <div className={`settings-rd-row${disabled ? ' is-locked' : ''}`}>
      <div className="settings-rd-row-head">
        <span className="settings-rd-label" id={labelId}>{label}</span>
        <code className="settings-rd-key">{settingKey}</code>
      </div>
      <div className="settings-rd-choices" role="radiogroup" aria-labelledby={labelId}>
        {values.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={`settings-rd-choice${value === option ? ' is-selected' : ''}${DANGER_VALUES.has(option) ? ' is-danger' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option)}
          >
            {option}
            {option === builtin && <span className="settings-rd-builtin">{COPY.defaultBadge}</span>}
          </button>
        ))}
      </div>
      {disabled && lockedHint ? (
        <p className="settings-rd-hint settings-rd-hint--locked">🔒 {lockedHint}</p>
      ) : hint ? (
        <p className="settings-rd-hint">{hint}</p>
      ) : null}
    </div>
  );
};

interface SwitchRowProps {
  label: string;
  settingKey: string;
  checked: boolean;
  danger?: boolean;
  hint: string;
  onChange: (checked: boolean) => void;
}

const SwitchRow: React.FC<SwitchRowProps> = ({ label, settingKey, checked, danger, hint, onChange }) => (
  <div className={`settings-rd-switch${danger ? ' settings-rd-switch--danger' : ''}${danger && checked ? ' is-on' : ''}`}>
    <div className="settings-rd-switch-info">
      <span className="settings-rd-label">{label}</span>
      <code className="settings-rd-key">{settingKey}</code>
      <p className="settings-rd-hint">{hint}</p>
    </div>
    <button
      type="button"
      className={`settings-toggle-switch ${checked ? 'settings-toggle-switch--on' : ''}${danger && checked ? ' settings-toggle-switch--danger' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" />
      <span className="settings-toggle-label">{checked ? 'ON' : 'OFF'}</span>
    </button>
  </div>
);

/**
 * Settings "실행 기본값": the server-side permission/effort defaults applied to
 * cards whose request omits (or sends invalid) `claudeOptions`/`codexOptions`.
 * Collapsed by default — shows the current values as chips.
 */
export const RuntimeDefaultsPanel: React.FC<RuntimeDefaultsPanelProps> = ({ entries, onSaved }) => {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [savedGroup, setSavedGroup] = useState<GroupId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();

  const defaults = useMemo(() => {
    const values = new Map(entries.map((entry) => [entry.key, entry.value]));
    return runtimeOptionDefaultsFromSettings((key) => pending[key] ?? values.get(key));
  }, [entries, pending]);
  const { claude, codex } = defaults;

  const save = async (group: GroupId, key: string, value: string) => {
    setPending((current) => ({ ...current, [key]: value }));
    setError(null);
    setSavedGroup(null);
    try {
      await upsertSettingByKey(key, value);
      await onSaved();
      setSavedGroup(group);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : COPY.saveFailed);
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const claudePreview = ['claude', '-p', ...claudeOptionArgs(resolveClaudeOptions(undefined, claude))].join(' ');
  const codexPreview = ['codex', 'exec', ...codexOptionArgs(resolveCodexOptions(undefined, codex))].join(' ');
  const builtin = BUILTIN_RUNTIME_OPTION_DEFAULTS;

  const chips: Array<{ runtime: GroupId; label: string; value: string; danger?: boolean }> = [
    claude.dangerouslySkipPermissions
      ? { runtime: 'claude', label: 'Claude', value: 'skip permissions', danger: true }
      : { runtime: 'claude', label: 'Claude', value: claude.permissionMode, danger: DANGER_VALUES.has(claude.permissionMode) },
    { runtime: 'claude', label: 'effort', value: claude.effort },
    codex.bypassApprovalsAndSandbox
      ? { runtime: 'codex', label: 'Codex', value: 'bypass sandbox', danger: true }
      : { runtime: 'codex', label: 'Codex', value: codex.sandbox, danger: DANGER_VALUES.has(codex.sandbox) },
    { runtime: 'codex', label: 'effort', value: codex.reasoningEffort },
    { runtime: 'codex', label: 'git check', value: codex.skipGitRepoCheck ? 'skip' : 'required' },
  ];

  return (
    <div className="settings-model-filter settings-rd" data-testid="runtime-defaults-panel">
      <button
        type="button"
        className="settings-rd-fold"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="settings-rd-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="settings-network-title">{COPY.title}</span>
        <span className="settings-rd-fold-action">{expanded ? COPY.collapse : COPY.expand}</span>
      </button>
      <p className="settings-network-desc">{COPY.description}</p>

      {!expanded && (
        <div className="settings-rd-chips" aria-label={`${COPY.title} 요약`}>
          {chips.map((chip, index) => (
            <span
              key={`${chip.runtime}-${chip.label}-${index}`}
              className={`settings-rd-chip settings-rd-chip--${chip.runtime}${chip.danger ? ' is-danger' : ''}`}
            >
              <b>{chip.label}</b>{chip.value}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="settings-rd-groups" id={bodyId}>
          <section
            className={`settings-rd-group settings-rd-group--claude${claude.dangerouslySkipPermissions ? ' is-danger' : ''}`}
            aria-label="Claude"
          >
            <header className="settings-rd-group-head">
              <span className="settings-rd-group-title">Claude</span>
              {savedGroup === 'claude' && <span className="kv2-badge kv2-badge--saved">{COPY.saved}</span>}
            </header>
            <ChoiceRow
              label={COPY.permissionMode}
              settingKey={CLAUDE_PERMISSION_MODE_SETTING_KEY}
              values={CLAUDE_PERMISSION_MODE_VALUES}
              value={claude.permissionMode}
              builtin={builtin.claude.permissionMode}
              disabled={claude.dangerouslySkipPermissions}
              lockedHint={COPY.lockedBySkip}
              onChange={(value) => void save('claude', CLAUDE_PERMISSION_MODE_SETTING_KEY, value)}
            />
            <SwitchRow
              label={COPY.skipPermissions}
              settingKey={CLAUDE_SKIP_PERMISSIONS_SETTING_KEY}
              checked={claude.dangerouslySkipPermissions}
              danger
              hint={COPY.skipPermissionsHint}
              onChange={(checked) => void save('claude', CLAUDE_SKIP_PERMISSIONS_SETTING_KEY, String(checked))}
            />
            <ChoiceRow
              label={COPY.claudeEffort}
              settingKey={CLAUDE_EFFORT_SETTING_KEY}
              values={CLAUDE_EFFORT_CHOICES}
              value={claude.effort}
              builtin={builtin.claude.effort}
              hint={COPY.claudeEffortHint}
              onChange={(value) => void save('claude', CLAUDE_EFFORT_SETTING_KEY, value)}
            />
            <div className="settings-rd-preview">
              <span>{COPY.preview}</span>
              <code data-testid="runtime-defaults-claude-preview">{claudePreview}</code>
            </div>
          </section>

          <section
            className={`settings-rd-group settings-rd-group--codex${codex.bypassApprovalsAndSandbox ? ' is-danger' : ''}`}
            aria-label="Codex"
          >
            <header className="settings-rd-group-head">
              <span className="settings-rd-group-title">Codex</span>
              {savedGroup === 'codex' && <span className="kv2-badge kv2-badge--saved">{COPY.saved}</span>}
            </header>
            <ChoiceRow
              label={COPY.sandbox}
              settingKey={CODEX_SANDBOX_SETTING_KEY}
              values={CODEX_SANDBOX_VALUES}
              value={codex.sandbox}
              builtin={builtin.codex.sandbox}
              disabled={codex.bypassApprovalsAndSandbox}
              hint={COPY.sandboxHint}
              lockedHint={COPY.lockedByBypass}
              onChange={(value) => void save('codex', CODEX_SANDBOX_SETTING_KEY, value)}
            />
            <SwitchRow
              label={COPY.bypass}
              settingKey={CODEX_BYPASS_SETTING_KEY}
              checked={codex.bypassApprovalsAndSandbox}
              danger
              hint={COPY.bypassHint}
              onChange={(checked) => void save('codex', CODEX_BYPASS_SETTING_KEY, String(checked))}
            />
            <SwitchRow
              label={COPY.skipGitRepoCheck}
              settingKey={CODEX_SKIP_GIT_REPO_CHECK_SETTING_KEY}
              checked={codex.skipGitRepoCheck}
              hint={COPY.skipGitRepoCheckHint}
              onChange={(checked) => void save('codex', CODEX_SKIP_GIT_REPO_CHECK_SETTING_KEY, String(checked))}
            />
            <ChoiceRow
              label={COPY.reasoningEffort}
              settingKey={CODEX_REASONING_EFFORT_SETTING_KEY}
              values={CODEX_REASONING_EFFORT_VALUES}
              value={codex.reasoningEffort}
              builtin={builtin.codex.reasoningEffort}
              onChange={(value) => void save('codex', CODEX_REASONING_EFFORT_SETTING_KEY, value)}
            />
            <div className="settings-rd-preview">
              <span>{COPY.preview}</span>
              <code data-testid="runtime-defaults-codex-preview">{codexPreview}</code>
            </div>
          </section>
        </div>
      )}

      {error && <p className="settings-guidelines-error" role="alert">{error}</p>}
    </div>
  );
};
