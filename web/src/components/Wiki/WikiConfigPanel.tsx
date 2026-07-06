import { useEffect, useState } from 'react';
import type { CodexReasoningEffort, WikiConfigDto, WikiConfigInput } from '../../../../src/core/types';

/**
 * Curated model presets with route + description. `gpt-*` runs through the codex
 * CLI, everything else through the claude CLI (see wiki-llm.ts). "직접 입력"
 * falls back to a free-text field for any other model id.
 */
const MODEL_PRESETS: { value: string; desc: string }[] = [
  { value: 'gpt-5.5', desc: 'codex · 최고 품질, 느림 (기본값)' },
  { value: 'opus', desc: 'claude · 최고 성능, 느리고 비쌈' },
  { value: 'sonnet', desc: 'claude · 품질·속도 균형 (권장)' },
  { value: 'haiku', desc: 'claude · 가장 빠르고 저렴, 대량 백필용' },
];
const MODEL_VALUES = MODEL_PRESETS.map((m) => m.value);
const EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const CUSTOM = '__custom__';

function routeLabel(config: WikiConfigDto): string {
  const route = config.route ?? (config.model.startsWith('gpt') ? 'codex' : 'claude');
  return route === 'codex' ? 'codex' : 'claude';
}

interface WikiConfigPanelProps {
  config: WikiConfigDto;
  busy: boolean;
  onSave: (input: WikiConfigInput) => Promise<void>;
}

/**
 * Explicit wiki configuration for the WIKI tab. Until the user saves, the wiki
 * has no settings entries (no boot-time auto-seed) and this renders a setup
 * prompt. Once configured, it shows an enable/disable toggle plus the editable
 * form inside the page-level options drawer. Enabling triggers the worker
 * immediately (server-side kick).
 */
export function WikiConfigPanel({ config, busy, onSave }: WikiConfigPanelProps) {
  const [model, setModel] = useState(config.model);
  const [modelMode, setModelMode] = useState(MODEL_VALUES.includes(config.model) ? config.model : CUSTOM);
  const [effort, setEffort] = useState<CodexReasoningEffort>(config.effort);
  const [vaultDir, setVaultDir] = useState(config.vaultDir);
  const [saving, setSaving] = useState(false);

  // Resync the form when the saved config changes (e.g. after a successful save).
  useEffect(() => {
    setModel(config.model);
    setModelMode(MODEL_VALUES.includes(config.model) ? config.model : CUSTOM);
    setEffort(config.effort);
    setVaultDir(config.vaultDir);
  }, [config.model, config.effort, config.vaultDir]);

  const effectiveModel = (modelMode === CUSTOM ? model : modelMode).trim();
  const disabled = busy || saving;
  const canSave = !disabled && !!effectiveModel && !!vaultDir.trim();

  const handleSave = async (enabledOverride?: boolean) => {
    setSaving(true);
    try {
      await onSave({
        model: effectiveModel,
        effort,
        vaultDir: vaultDir.trim(),
        ...(enabledOverride !== undefined ? { enabled: enabledOverride } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <div className="wiki-config-form">
      <label className="wiki-config-field wiki-config-field--model">
        <span className="wiki-config-label">발화 모델</span>
        <select
          className="wiki-config-input"
          value={modelMode}
          onChange={(e) => {
            setModelMode(e.target.value);
            if (e.target.value !== CUSTOM) setModel(e.target.value);
          }}
          disabled={disabled}
        >
          {MODEL_PRESETS.map((m) => <option key={m.value} value={m.value}>{`${m.value} — ${m.desc}`}</option>)}
          <option value={CUSTOM}>직접 입력…</option>
        </select>
        {modelMode === CUSTOM && (
          <input
            className="wiki-config-input"
            type="text"
            value={model}
            placeholder="예: gpt-5.5, opus, sonnet"
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
          />
        )}
        <span className="wiki-config-hint">
          {MODEL_PRESETS.find((m) => m.value === modelMode)?.desc ?? 'gpt-* → codex CLI, 그 외 → claude CLI'}
        </span>
      </label>

      <label className="wiki-config-field wiki-config-field--effort">
        <span className="wiki-config-label">Effort</span>
        <select
          className="wiki-config-input"
          value={effort}
          onChange={(e) => setEffort(e.target.value as CodexReasoningEffort)}
          disabled={disabled}
        >
          {EFFORTS.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
        </select>
        <span className="wiki-config-hint">Claude는 --effort, Codex는 model_reasoning_effort로 전달됩니다</span>
      </label>

      <label className="wiki-config-field wiki-config-field--vault">
        <span className="wiki-config-label">Obsidian 저장 폴더</span>
        <input
          className="wiki-config-input"
          type="text"
          value={vaultDir}
          placeholder="/path/to/your-obsidian-vault/AgentKanbanWiki"
          onChange={(e) => setVaultDir(e.target.value)}
          disabled={disabled}
        />
        <span className="wiki-config-hint">
          Obsidian vault 안의 Wiki 전용 폴더를 직접 입력하세요. 없으면 활성화 시 생성됩니다.
        </span>
      </label>
    </div>
  );

  if (!config.configured) {
    return (
      <div className="wiki-config wiki-config--setup">
        <h3 className="wiki-config-title">LLM 위키 설정</h3>
        <p className="wiki-config-desc">
          아카이브된 done 카드를 문서로 만들려면 저장 폴더를 직접 지정하세요.
          저장 후 pending archive부터 처리합니다.
        </p>
        {form}
        <div className="wiki-config-actions">
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            onClick={() => { void handleSave(true); }}
            disabled={!canSave}
          >
            {saving ? '저장 중…' : '경로 저장하고 활성화'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wiki-config">
      <div className="wiki-config-header">
        <div className="wiki-config-summary">
          <button
            type="button"
            className={`settings-toggle-switch ${config.enabled ? 'settings-toggle-switch--on' : ''}`}
            onClick={() => { void handleSave(!config.enabled); }}
            role="switch"
            aria-checked={config.enabled}
            aria-label="위키 활성화 토글"
            disabled={disabled}
          >
            <span className="settings-toggle-knob" />
            <span className="settings-toggle-label">{config.enabled ? 'ON' : 'OFF'}</span>
          </button>
          <span className="wiki-config-meta">
            {config.enabled ? '활성화됨' : '비활성'} · {routeLabel(config)} · model {config.model} · effort {config.effort}
          </span>
        </div>
      </div>
      {form}
      <div className="wiki-config-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => { void handleSave(); }}
          disabled={!canSave}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
