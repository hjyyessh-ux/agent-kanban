import { useEffect, useState } from 'react';
import type { WorksConfigDto, WorksConfigInput } from '../../../../src/core/types';
import './Works.css';

/**
 * Curated Summary models per runtime. Kept in sync with the backend routing
 * (`resolveWikiLlmRoute`: gpt-* → codex CLI, otherwise claude CLI) — the runtime
 * select only filters this list; the persisted value is the model id alone, from
 * which the backend re-derives the route. Mirrors WikiConfigPanel's approach of
 * hardcoding a short list instead of importing the backend catalog.
 */
const MODELS_BY_RUNTIME: Record<'claude' | 'codex', { value: string; label: string }[]> = {
  claude: [
    { value: 'claude-sonnet-5', label: 'Sonnet 5 — 균형 (권장)' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8 — 최고 품질' },
    { value: 'claude-opus-5', label: 'Opus 5 — 1M 컨텍스트' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — 가장 빠름' },
  ],
  codex: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol — frontier' },
    { value: 'gpt-5.5', label: 'GPT-5.5 — 범용' },
  ],
};

const LINE_OPTIONS = [3, 4, 5] as const;
const STALE_OPTIONS = [3, 5, 7, 10, 14] as const;

function runtimeOf(model: string): 'claude' | 'codex' {
  return model.startsWith('gpt') ? 'codex' : 'claude';
}

interface WorksConfigPanelProps {
  config: WorksConfigDto;
  busy: boolean;
  onSave: (input: WorksConfigInput) => Promise<void>;
}

/**
 * Works settings (mockup screen ④). Reached via the ⚙ gear at the top-right of
 * the Works tab. Manages the Summary LLM (independent of the wiki), summary line
 * count, Inbox assignment suggestion toggles, the complete-behavior choice, and
 * the stale-Work threshold. All fields have sane defaults, so there is no setup
 * gate — the form always renders.
 */
export function WorksConfigPanel({ config, busy, onSave }: WorksConfigPanelProps) {
  const [runtime, setRuntime] = useState<'claude' | 'codex'>(runtimeOf(config.summaryModel));
  const [model, setModel] = useState(config.summaryModel);
  const [summaryLines, setSummaryLines] = useState(config.summaryLines);
  const [preferSameDir, setPreferSameDir] = useState(config.assignPreferSameDir);
  const [suggestResume, setSuggestResume] = useState(config.assignSuggestResumeChain);
  const [doneConfirm, setDoneConfirm] = useState(config.doneConfirm);
  const [staleDays, setStaleDays] = useState(config.staleDays);
  const [saving, setSaving] = useState(false);

  // Resync when the saved config changes (e.g. after a successful save).
  useEffect(() => {
    setRuntime(runtimeOf(config.summaryModel));
    setModel(config.summaryModel);
    setSummaryLines(config.summaryLines);
    setPreferSameDir(config.assignPreferSameDir);
    setSuggestResume(config.assignSuggestResumeChain);
    setDoneConfirm(config.doneConfirm);
    setStaleDays(config.staleDays);
  }, [config]);

  const disabled = busy || saving;
  const models = MODELS_BY_RUNTIME[runtime];
  // A custom model (from a prior manual save) that isn't in the curated list.
  const modelInList = models.some((m) => m.value === model);

  const handleRuntimeChange = (next: 'claude' | 'codex') => {
    setRuntime(next);
    setModel(MODELS_BY_RUNTIME[next][0].value);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        summaryModel: model,
        summaryLines,
        assignPreferSameDir: preferSameDir,
        assignSuggestResumeChain: suggestResume,
        doneConfirm,
        staleDays,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="works-config">
      <div className="works-config-header">
        <h3 className="works-config-title">⚙ Works 설정</h3>
        <span className="works-config-meta">
          Summary는 wiki와 독립된 works 전용 모델로 생성됩니다 · route {config.route}
        </span>
      </div>

      <div className="works-config-form">
        <label className="works-config-field">
          <span className="works-config-label">
            Summary 모델
            <span className="works-config-sub">works.summary_model — wiki 모델과 독립</span>
          </span>
          <div className="works-config-model">
            <select
              className="works-config-input"
              value={runtime}
              onChange={(e) => handleRuntimeChange(e.target.value as 'claude' | 'codex')}
              disabled={disabled}
              aria-label="Summary 런타임"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <select
              className="works-config-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled}
              aria-label="Summary 모델"
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
              {!modelInList && <option value={model}>{model} (사용자 지정)</option>}
            </select>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            Summary 줄 수
            <span className="works-config-sub">works.summary_lines · 3~5줄</span>
          </span>
          <div className="works-config-pill" role="radiogroup" aria-label="Summary 줄 수">
            {LINE_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={summaryLines === n}
                className={`works-config-pill-btn${summaryLines === n ? ' works-config-pill-btn--on' : ''}`}
                onClick={() => setSummaryLines(n)}
                disabled={disabled}
              >
                {n}줄
              </button>
            ))}
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            배정 추천
            <span className="works-config-sub">Inbox에서 기존 Work 추천 기준</span>
          </span>
          <div className="works-config-checks">
            <label className="works-config-check">
              <input
                type="checkbox"
                checked={preferSameDir}
                onChange={(e) => setPreferSameDir(e.target.checked)}
                disabled={disabled}
              />
              같은 projectDir의 active Work 우선
            </label>
            <label className="works-config-check">
              <input
                type="checkbox"
                checked={suggestResume}
                onChange={(e) => setSuggestResume(e.target.checked)}
                disabled={disabled}
              />
              resume 체인(resumeSessionId)이면 같은 Work 자동 추천
            </label>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            완료 시 동작
            <span className="works-config-sub">Work done → 산하 카드 처리</span>
          </span>
          <div className="works-config-checks" role="radiogroup" aria-label="완료 시 동작">
            <label className="works-config-check">
              <input
                type="radio"
                name="works-done-confirm"
                checked={!doneConfirm}
                onChange={() => setDoneConfirm(false)}
                disabled={disabled}
              />
              일괄 done→archive + wiki 파이프라인 트리거
            </label>
            <label className="works-config-check">
              <input
                type="radio"
                name="works-done-confirm"
                checked={doneConfirm}
                onChange={() => setDoneConfirm(true)}
                disabled={disabled}
              />
              archive 전 확인 다이얼로그 표시
            </label>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            오래된 Work 경고
            <span className="works-config-sub">works.stale_days</span>
          </span>
          <select
            className="works-config-input"
            value={staleDays}
            onChange={(e) => setStaleDays(Number(e.target.value))}
            disabled={disabled}
          >
            {STALE_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}일 이상 미완료 시 ⚠ 표시</option>
            ))}
          </select>
        </label>
      </div>

      <div className="works-config-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => { void handleSave(); }}
          disabled={disabled}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
