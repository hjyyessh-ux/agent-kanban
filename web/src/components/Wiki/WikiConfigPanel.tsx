import { useEffect, useState } from 'react';
import type { RuntimeCatalogEntry } from '../../../../src/core/runtime-config';
import type {
  CodexReasoningEffort,
  WikiConfigDto,
  WikiConfigInput,
  WikiLlmRoute,
} from '../../../../src/core/types';
import {
  buildWikiModelGroups,
  findWikiModelSelection,
  wikiModelSelectionKey,
} from './wiki-model-options';

const EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const CUSTOM = '__custom__';

function routeLabel(config: WikiConfigDto): string {
  return config.route === 'codex' ? 'codex' : 'claude';
}

interface WikiConfigPanelProps {
  config: WikiConfigDto;
  runtimes: RuntimeCatalogEntry[];
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
export function WikiConfigPanel({ config, runtimes, busy, onSave }: WikiConfigPanelProps) {
  const modelGroups = buildWikiModelGroups(runtimes);
  const [model, setModel] = useState(config.model);
  const [route, setRoute] = useState<WikiLlmRoute>(config.route);
  const [modelMode, setModelMode] = useState(
    findWikiModelSelection(modelGroups, config.route, config.model) ?? CUSTOM,
  );
  const [effort, setEffort] = useState<CodexReasoningEffort>(config.effort);
  const [vaultDir, setVaultDir] = useState(config.vaultDir);
  const [saving, setSaving] = useState(false);

  // Resync the form when the saved config changes (e.g. after a successful save).
  useEffect(() => {
    setModel(config.model);
    setRoute(config.route);
    setModelMode(findWikiModelSelection(modelGroups, config.route, config.model) ?? CUSTOM);
    setEffort(config.effort);
    setVaultDir(config.vaultDir);
  }, [config.model, config.route, config.effort, config.vaultDir]);

  const effectiveModel = model.trim();
  const disabled = busy || saving;
  const canSave = !disabled && !!effectiveModel && !!vaultDir.trim();
  const selectedModel = modelGroups
    .find((group) => group.route === route)
    ?.models.find((entry) => entry.id === model);

  const handleSave = async (enabledOverride?: boolean) => {
    setSaving(true);
    try {
      await onSave({
        model: effectiveModel,
        route,
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
            const selection = e.target.value;
            setModelMode(selection);
            if (selection === CUSTOM) return;
            const next = modelGroups
              .flatMap((group) => group.models.map((entry) => ({ route: group.route, model: entry.id })))
              .find((entry) => wikiModelSelectionKey(entry.route, entry.model) === selection);
            if (!next) return;
            setRoute(next.route);
            setModel(next.model);
          }}
          disabled={disabled}
        >
          {modelGroups.map((group) => (
            <optgroup key={group.route} label={`${group.label} CLI`}>
              {group.models.map((entry) => (
                <option
                  key={entry.id}
                  value={wikiModelSelectionKey(group.route, entry.id)}
                >
                  {entry.label === entry.id ? entry.id : `${entry.label} — ${entry.id}`}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>직접 입력…</option>
        </select>
        {modelMode === CUSTOM && (
          <>
            <select
              className="wiki-config-input"
              value={route}
              onChange={(e) => setRoute(e.target.value as WikiLlmRoute)}
              disabled={disabled}
              aria-label="직접 입력 모델 실행 경로"
            >
              <option value="codex">Codex CLI</option>
              <option value="claude">Claude CLI</option>
            </select>
            <input
              className="wiki-config-input"
              type="text"
              value={model}
              placeholder="모델 ID를 입력하세요"
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled}
            />
          </>
        )}
        <span className="wiki-config-hint">
          {selectedModel
            ? `${route === 'codex' ? 'Codex' : 'Claude'} CLI${selectedModel.tier ? ` · ${selectedModel.tier}` : ''}`
            : `${route === 'codex' ? 'Codex' : 'Claude'} CLI로 실행됩니다`}
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
