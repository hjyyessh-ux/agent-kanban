import { useEffect, useRef, useState } from 'react';
import type { WorksConfigDto, WorksConfigInput } from '../../../../src/core/types';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../../../src/core/runtime-config';
import './Works.css';

/**
 * Summary model choices per runtime, taken from the runtime catalog.
 *
 * The list used to be a hand-written literal here, which broke the project's
 * "never hardcode agent labels/models outside `agent-config.ts` /
 * `runtime-config.ts`" rule in the way that rule exists to prevent: it drifted.
 * It offered `claude-opus-4-8` and `gpt-5.5` while the catalog had moved on, and
 * a model retired from the catalog stayed selectable here.
 *
 * The runtime select only *filters*; the persisted value is the model id alone,
 * from which the backend re-derives the route (`resolveWikiLlmRoute`: `gpt-*` →
 * codex CLI, otherwise claude CLI).
 */
const MODELS_BY_RUNTIME = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
} satisfies Record<'claude' | 'codex', readonly { id: string; label: string }[]>;

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

/** The form's editable state — one object so "is this dirty" is one comparison. */
export interface FormState {
  model: string;
  summaryLines: number;
  preferSameDir: boolean;
  suggestResume: boolean;
  doneConfirm: boolean;
  staleDays: number;
}

export function formOf(config: WorksConfigDto): FormState {
  return {
    model: config.summaryModel,
    summaryLines: config.summaryLines,
    preferSameDir: config.assignPreferSameDir,
    suggestResume: config.assignSuggestResumeChain,
    doneConfirm: config.doneConfirm,
    staleDays: config.staleDays,
  };
}

export function sameForm(a: FormState, b: FormState): boolean {
  return a.model === b.model
    && a.summaryLines === b.summaryLines
    && a.preferSameDir === b.preferSameDir
    && a.suggestResume === b.suggestResume
    && a.doneConfirm === b.doneConfirm
    && a.staleDays === b.staleDays;
}

/**
 * What a newly-arrived config should do to the form, as a pure rule.
 *
 * `current` is what is on screen, `baseline` is the config it was seeded from,
 * `next` is what just arrived. The form is *dirty* when it has drifted from its
 * baseline, and a dirty form keeps its edits: the Works tab polls every 10
 * seconds and hands over a fresh `WorksConfigDto` object each time, so a plain
 * `useEffect([config]) → setState(config)` reverted whatever the user was in the
 * middle of typing, on a timer. A clean form still accepts the new values, so a
 * change made elsewhere is not ignored either.
 */
export function resyncForm(current: FormState, baseline: FormState, next: FormState): FormState {
  return sameForm(current, baseline) ? next : current;
}

/**
 * Works settings, reached via the ⚙ gear at the top-right of the Works tab.
 * Manages the Summary LLM (independent of the wiki), summary line count, the
 * Inbox assignment ranking, the complete-behaviour choice, and the stale-Work
 * threshold. All fields have sane defaults, so there is no setup gate — the form
 * always renders.
 *
 * Copy rule for this panel: **it names things the way the screen does.** The
 * labels used to be the setting keys and wire fields (`works.summary_model`,
 * `projectDir`, `resumeSessionId`), which describe the storage rather than the
 * behaviour and are unreadable to anyone who has not read the source. Every
 * key is still discoverable — `docs/works.md` has the table — it is just not
 * what the label says.
 */
export function WorksConfigPanel({ config, busy, onSave }: WorksConfigPanelProps) {
  const [form, setForm] = useState<FormState>(() => formOf(config));
  const [runtime, setRuntime] = useState<'claude' | 'codex'>(runtimeOf(config.summaryModel));
  const [saving, setSaving] = useState(false);

  /**
   * Resync from the server *only while the form is clean*.
   *
   * `useEffect([config])` used to overwrite the whole form on every arrival of
   * the config — and the Works tab polls, so a new `config` object landed every
   * 10 seconds whether or not anything had changed. Half-made edits were
   * reverted mid-interaction. `baseline` is the config the form was seeded from,
   * so "dirty" is a real comparison rather than a guess, and a config that
   * genuinely changed elsewhere still lands here once the user has no pending
   * edits to lose.
   */
  const baseline = useRef<FormState>(formOf(config));
  useEffect(() => {
    const next = formOf(config);
    setForm((current) => {
      const resolved = resyncForm(current, baseline.current, next);
      baseline.current = next;
      if (resolved !== current) setRuntime(runtimeOf(resolved.model));
      return resolved;
    });
  }, [config]);

  const disabled = busy || saving;
  const models = MODELS_BY_RUNTIME[runtime];
  // A custom model (from a prior manual save) that isn't in the catalog.
  const modelInList = models.some((m) => m.id === form.model);
  const dirty = !sameForm(form, baseline.current);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleRuntimeChange = (next: 'claude' | 'codex') => {
    setRuntime(next);
    patch('model', MODELS_BY_RUNTIME[next][0].id);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        summaryModel: form.model,
        summaryLines: form.summaryLines,
        assignPreferSameDir: form.preferSameDir,
        assignSuggestResumeChain: form.suggestResume,
        doneConfirm: form.doneConfirm,
        staleDays: form.staleDays,
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
          요약은 Wiki와 따로 설정합니다 — 여기서 고른 모델만 Works 요약에 쓰입니다.
        </span>
      </div>

      <div className="works-config-form">
        <label className="works-config-field">
          <span className="works-config-label">
            요약에 쓸 모델
            <span className="works-config-sub">Wiki 요약 모델과 별개로 동작합니다</span>
          </span>
          <div className="works-config-model">
            <select
              className="kv2-select works-config-select"
              value={runtime}
              onChange={(e) => handleRuntimeChange(e.target.value as 'claude' | 'codex')}
              disabled={disabled}
              aria-label="요약 실행 도구"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <select
              className="kv2-select works-config-select"
              value={form.model}
              onChange={(e) => patch('model', e.target.value)}
              disabled={disabled}
              aria-label="요약에 쓸 모델"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
              {!modelInList && <option value={form.model}>{form.model} (직접 지정한 모델)</option>}
            </select>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            요약 길이
            <span className="works-config-sub">연결된 세션을 몇 줄로 정리할지</span>
          </span>
          <div className="works-config-pill" role="radiogroup" aria-label="요약 길이">
            {LINE_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={form.summaryLines === n}
                className={`kv2-btn kv2-btn--small${form.summaryLines === n ? ' kv2-btn--primary' : ''}`}
                onClick={() => patch('summaryLines', n)}
                disabled={disabled}
              >
                {n}줄
              </button>
            ))}
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            Inbox 추천 순서
            <span className="works-config-sub">
              세션을 배정할 때 어떤 Work를 위에 올릴지
            </span>
          </span>
          <div className="works-config-checks">
            <label className="works-config-check">
              <input
                type="checkbox"
                checked={form.preferSameDir}
                onChange={(e) => patch('preferSameDir', e.target.checked)}
                disabled={disabled}
              />
              같은 폴더에서 나온 Work를 먼저 추천
            </label>
            <label className="works-config-check">
              {/* "resume 체인" named only one of the three things this covers:
                  the lineage is a resumed session *or* a subagent's parent *or*
                  a queue chain (`buildSessionChainMap`). */}
              <input
                type="checkbox"
                checked={form.suggestResume}
                onChange={(e) => patch('suggestResume', e.target.checked)}
                disabled={disabled}
              />
              이어서 실행한 세션(이어하기 · 하위 에이전트 · 큐)이면 그 Work를 먼저 추천
            </label>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            Work를 완료할 때
            <span className="works-config-sub">
              완료하면 그 Work의 카드를 한꺼번에 끝내고 보관함으로 넘깁니다
            </span>
          </span>
          <div className="works-config-checks" role="radiogroup" aria-label="Work를 완료할 때">
            <label className="works-config-check">
              <input
                type="radio"
                name="works-done-confirm"
                checked={!form.doneConfirm}
                onChange={() => patch('doneConfirm', false)}
                disabled={disabled}
              />
              묻지 않고 바로 보관 (되돌릴 수 없습니다)
            </label>
            <label className="works-config-check">
              <input
                type="radio"
                name="works-done-confirm"
                checked={form.doneConfirm}
                onChange={() => patch('doneConfirm', true)}
                disabled={disabled}
              />
              보관하기 전에 한 번 확인 (기본값)
            </label>
          </div>
        </label>

        <label className="works-config-field">
          <span className="works-config-label">
            오래된 Work 경고
            <span className="works-config-sub">며칠째 끝나지 않으면 ⚠ 표시를 붙일지</span>
          </span>
          <select
            className="kv2-select"
            value={form.staleDays}
            onChange={(e) => patch('staleDays', Number(e.target.value))}
            disabled={disabled}
          >
            {STALE_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}일 넘게 진행 중이면 ⚠ 표시</option>
            ))}
          </select>
        </label>
      </div>

      {/* Same footer geometry as every other kv2 form: escape hatch on the left,
          forward progress on the right. */}
      <div className="works-config-actions kv2-actions-split">
        <div className="kv2-actions-danger">
          <button
            type="button"
            className="kv2-btn kv2-btn--small kv2-btn--ghost"
            disabled={disabled || !dirty}
            onClick={() => {
              setForm(baseline.current);
              setRuntime(runtimeOf(baseline.current.model));
            }}
          >
            되돌리기
          </button>
        </div>
        <div className="kv2-actions-primary">
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            // `onSave` reports through the shared Works error alert and rethrows.
            onClick={() => { void handleSave().catch(() => {}); }}
            disabled={disabled}
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
