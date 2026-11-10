import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ClaudePermissionMode, CodexReasoningEffort, CodexSandboxMode } from "../../../../src/core/types";
import {
  RUN_PRESET_LIMIT,
  addRunPreset,
  effortOptions,
  findRunPreset,
  moveRunPreset,
  permissionOptions,
  presetForRuntime,
  presetOptionLine,
  removeRunPreset,
  replaceRunPreset,
  sameRunPreset,
  splitModelLabel,
  type ClaudePresetEffort,
  type PresetRuntime,
  type RunPreset,
} from "./runPresets";

export interface PresetRuntimeModel {
  id: string;
  label: string;
  tier?: string;
}

export interface PresetRuntimeEntry {
  runtime: PresetRuntime;
  label: string;
  models: readonly PresetRuntimeModel[];
}

export interface RunPresetDefaults {
  claudePermission: ClaudePermissionMode;
  claudeEffort: ClaudePresetEffort;
  codexSandbox: CodexSandboxMode;
  codexEffort: CodexReasoningEffort;
}

interface RunPresetFieldProps {
  value: RunPreset;
  onChange: (next: RunPreset) => void;
  runtimes: readonly PresetRuntimeEntry[];
  presets: readonly RunPreset[];
  onPresetsChange: (next: RunPreset[]) => void;
  /** Starting values when the picker switches runtime. */
  defaults: RunPresetDefaults;
  disabled?: boolean;
}

type PickerMode = { kind: "select" } | { kind: "add" } | { kind: "edit"; index: number };

const RUNTIME_ICON: Record<PresetRuntime, string> = { claude: "C", codex: "X" };

export function presetModelLabel(runtimes: readonly PresetRuntimeEntry[], preset: Pick<RunPreset, "runtime" | "model">): { name: string; tag?: string } {
  const model = runtimes.find((entry) => entry.runtime === preset.runtime)?.models.find((m) => m.id === preset.model);
  return model ? splitModelLabel(model.label) : { name: preset.model };
}

export function presetTitle(runtimes: readonly PresetRuntimeEntry[], preset: RunPreset): string {
  const runtimeLabel = runtimes.find((entry) => entry.runtime === preset.runtime)?.label ?? preset.runtime;
  const { name, tag } = presetModelLabel(runtimes, preset);
  return `${runtimeLabel} · ${name}${tag ? ` ${tag}` : ""} · ${presetOptionLine(preset)}`;
}

/** Models grouped by catalog tier, in catalog order (`opus`, `sonnet` … / `frontier`, `general` …). */
function groupByTier(models: readonly PresetRuntimeModel[]): Array<[string, PresetRuntimeModel[]]> {
  const groups = new Map<string, PresetRuntimeModel[]>();
  for (const model of models) {
    const key = model.tier ?? "";
    const list = groups.get(key) ?? [];
    list.push(model);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

function RuntimeIcon({ runtime }: { runtime: PresetRuntime }) {
  return <span className={`kv2-run-preset-ico kv2-run-preset-ico--${runtime}`} aria-hidden="true">{RUNTIME_ICON[runtime]}</span>;
}

function SegmentGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; short: string; danger?: boolean }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="kv2-run-preset-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.value}
          className={[
            "kv2-run-preset-seg-btn",
            option.value === value ? "is-on" : "",
            option.danger ? "is-danger" : "",
          ].filter(Boolean).join(" ")}
          onClick={() => onChange(option.value)}
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}

/**
 * NEW TASK `실행 프리셋`: favorite chips (runtime · model · permission · effort)
 * in a fixed 3×2 grid, plus `모든 모델` — a two-column picker that applies a
 * one-off combination or saves it. `편집` turns chips into ✎ ◀ ▶ × controls and
 * empty slots into `＋ 즐겨찾기 추가`.
 */
export const RunPresetField: React.FC<RunPresetFieldProps> = ({
  value,
  onChange,
  runtimes,
  presets,
  onPresetsChange,
  defaults,
  disabled = false,
}) => {
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [draft, setDraft] = useState<RunPreset>(value);
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const allBtnRef = useRef<HTMLButtonElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);

  const selectedIndex = findRunPreset(presets, value);
  const isFull = presets.length >= RUN_PRESET_LIMIT;

  const announce = (message: string) => setStatus(message);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);

  const openPicker = (mode: PickerMode) => {
    if (disabled) return;
    setDraft(mode.kind === "edit" ? presets[mode.index] : value);
    setReplacing(false);
    setPicker(mode);
  };

  const closePicker = () => {
    const mode = picker;
    setPicker(null);
    setReplacing(false);
    (mode?.kind === "select" ? allBtnRef : editBtnRef).current?.focus();
  };

  // Focus the selected model when the picker opens.
  useEffect(() => {
    if (!picker) return;
    const list = modelListRef.current;
    const target = list?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLButtonElement>("button");
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    // Only on open / runtime switch — not on every draft tweak.
  }, [picker, draft.runtime]);

  // Outside click closes the picker (the dialog itself stays open).
  useEffect(() => {
    if (!picker) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPicker(null);
        setReplacing(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);

  // ⌥1–⌥6 apply a favorite while the dialog is open.
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const match = /^Digit([1-6])$/.exec(event.code);
      if (!match) return;
      const preset = presets[Number(match[1]) - 1];
      if (!preset || editing) return;
      event.preventDefault();
      onChange(preset);
    };
    // Capture phase: DialogSkeleton stops keydown propagation at the dialog.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [disabled, editing, onChange, presets]);

  const draftRuntime = runtimes.find((entry) => entry.runtime === draft.runtime);
  const groups = useMemo(() => groupByTier(draftRuntime?.models ?? []), [draftRuntime]);
  const starredModels = useMemo(
    () => new Set(presets.filter((p) => p.runtime === draft.runtime).map((p) => p.model)),
    [draft.runtime, presets],
  );

  const draftDupIndex = findRunPreset(presets, draft);
  const draftIsDuplicate = draftDupIndex >= 0 && !(picker?.kind === "edit" && draftDupIndex === picker.index);

  const switchRuntime = (runtime: PresetRuntime) => {
    if (runtime === draft.runtime) return;
    const firstModel = runtimes.find((entry) => entry.runtime === runtime)?.models[0]?.id ?? "";
    setDraft(presetForRuntime(runtime, firstModel, defaults));
    setReplacing(false);
  };

  const setDraftModel = (model: string) => setDraft((current) => ({ ...current, model }) as RunPreset);
  const setDraftPermission = (permission: string) => setDraft((current) => ({ ...current, permission }) as RunPreset);
  const setDraftEffort = (effort: string) => setDraft((current) => ({ ...current, effort }) as RunPreset);

  const commitPicker = () => {
    if (!picker || !draft.model) return;
    if (picker.kind === "select") {
      onChange(draft);
      closePicker();
      return;
    }
    if (picker.kind === "add") {
      const result = addRunPreset(presets, draft);
      if (result.kind !== "added") return;
      onPresetsChange(result.presets);
      announce(`즐겨찾기 추가됨 (${result.presets.length}/${RUN_PRESET_LIMIT})`);
      closePicker();
      return;
    }
    const next = replaceRunPreset(presets, picker.index, draft);
    if (!next) return;
    onPresetsChange(next);
    if (sameRunPreset(value, presets[picker.index])) onChange(draft);
    announce(`⌥${picker.index + 1} 수정됨`);
    closePicker();
  };

  const addDraftFromSelect = () => {
    const result = addRunPreset(presets, draft);
    if (result.kind === "added") {
      onPresetsChange(result.presets);
      announce(`즐겨찾기 추가됨 (${result.presets.length}/${RUN_PRESET_LIMIT})`);
    } else if (result.kind === "full") {
      setReplacing(true);
    }
  };

  const replaceSlot = (index: number) => {
    const next = replaceRunPreset(presets, index, draft);
    if (!next) return;
    onPresetsChange(next);
    setReplacing(false);
    announce(`⌥${index + 1} 교체됨`);
  };

  const saveCurrent = () => {
    const result = addRunPreset(presets, value);
    if (result.kind === "added") {
      onPresetsChange(result.presets);
      announce(`즐겨찾기 저장됨 (${result.presets.length}/${RUN_PRESET_LIMIT})`);
      return;
    }
    if (result.kind === "full") {
      setDraft(value);
      setPicker({ kind: "select" });
      setReplacing(true);
    }
  };

  const onPickerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Close only the picker — DialogSkeleton would otherwise close the whole dialog.
      event.preventDefault();
      event.stopPropagation();
      if (replacing) setReplacing(false);
      else closePicker();
      return;
    }
    const target = event.target as HTMLElement;
    if (!target.dataset.model) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = Array.from(modelListRef.current?.querySelectorAll<HTMLButtonElement>("[data-model]") ?? []);
      const index = buttons.indexOf(target as HTMLButtonElement) + (event.key === "ArrowDown" ? 1 : -1);
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, index))];
      if (next?.dataset.model) {
        setDraftModel(next.dataset.model);
        next.focus();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitPicker();
    }
  };

  const onChipKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + presets.length) % presets.length;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-preset-index="${next}"]`)?.focus();
  };

  const showTemp = !editing && selectedIndex < 0;
  const pickerTitle = picker?.kind === "add"
    ? "즐겨찾기 추가"
    : picker?.kind === "edit"
      ? `즐겨찾기 ⌥${picker.index + 1} 수정`
      : "모든 모델";

  return (
    <div ref={rootRef} className={`kv2-run-preset${editing ? " is-editing" : ""}${replacing ? " is-replacing" : ""}`}>
      <div className="kv2-run-preset-head">
        <span className="kv2-create-label" id="create-card-run-preset-label">실행 프리셋</span>
        <span className={`kv2-run-preset-count${isFull ? " is-full" : ""}`} aria-label={`즐겨찾기 ${presets.length}/${RUN_PRESET_LIMIT}`}>
          ★ {presets.length}/{RUN_PRESET_LIMIT}
        </span>
        {showTemp && (
          // Only the combo text may shrink — the label and the save button never wrap or squeeze.
          <span className="kv2-run-preset-temp" title={`즐겨찾기에 없는 조합\n${presetTitle(runtimes, value)}`}>
            <span className="kv2-run-preset-temp-tag">현재 선택</span>
            <span className="kv2-run-preset-temp-text">{presetTitle(runtimes, value)}</span>
            <button
              type="button"
              className="kv2-run-preset-temp-save"
              onClick={saveCurrent}
              disabled={disabled}
              aria-label={`현재 조합 즐겨찾기에 저장: ${presetTitle(runtimes, value)}`}
            >
              ☆ 저장
            </button>
          </span>
        )}
        <span className="kv2-run-preset-spacer" />
        <button
          ref={allBtnRef}
          type="button"
          className={`kv2-run-preset-head-btn kv2-run-preset-head-btn--all${picker?.kind === "select" ? " is-on" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={picker?.kind === "select"}
          onClick={() => (picker?.kind === "select" ? closePicker() : openPicker({ kind: "select" }))}
          disabled={disabled}
        >
          모든 모델 ▾
        </button>
        <button
          ref={editBtnRef}
          type="button"
          className={`kv2-run-preset-head-btn${editing ? " is-on" : ""}`}
          aria-pressed={editing}
          onClick={() => {
            setPicker(null);
            setReplacing(false);
            setEditing((current) => !current);
          }}
          disabled={disabled}
        >
          {editing ? "완료" : "편집"}
        </button>
      </div>

      <div
        className="kv2-run-preset-grid"
        role={editing ? "group" : "radiogroup"}
        aria-labelledby="create-card-run-preset-label"
      >
        {presets.map((preset, index) => {
          const { name, tag } = presetModelLabel(runtimes, preset);
          const title = presetTitle(runtimes, preset);
          const body = (
            <>
              <RuntimeIcon runtime={preset.runtime} />
              <span className="kv2-run-preset-name">
                {name}
                {tag && <small className="kv2-run-preset-tag">{tag}</small>}
              </span>
              <span className="kv2-run-preset-opts">{presetOptionLine(preset)}</span>
            </>
          );
          if (editing) {
            return (
              <div key={`${index}-${title}`} className={`kv2-run-preset-chip kv2-run-preset-chip--${preset.runtime} is-editing`} title={title}>
                <button
                  type="button"
                  className="kv2-run-preset-chip-main"
                  onClick={() => openPicker({ kind: "edit", index })}
                  aria-label={`⌥${index + 1} 수정: ${title}`}
                  disabled={disabled}
                >
                  {body}
                </button>
                <span className="kv2-run-preset-ctl">
                  <button type="button" onClick={() => openPicker({ kind: "edit", index })} aria-label={`⌥${index + 1} 수정`} disabled={disabled}>✎</button>
                  <button type="button" onClick={() => onPresetsChange(moveRunPreset(presets, index, -1))} aria-label={`⌥${index + 1} 왼쪽으로`} disabled={disabled || index === 0}>◀</button>
                  <button type="button" onClick={() => onPresetsChange(moveRunPreset(presets, index, 1))} aria-label={`⌥${index + 1} 오른쪽으로`} disabled={disabled || index === presets.length - 1}>▶</button>
                  <button
                    type="button"
                    className="is-remove"
                    onClick={() => {
                      onPresetsChange(removeRunPreset(presets, index));
                      announce("즐겨찾기 삭제됨");
                    }}
                    aria-label={`⌥${index + 1} 삭제`}
                    disabled={disabled}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          }
          const on = index === selectedIndex;
          return (
            <button
              key={`${index}-${title}`}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on || (selectedIndex < 0 && index === 0) ? 0 : -1}
              data-preset-index={index}
              className={`kv2-run-preset-chip kv2-run-preset-chip--${preset.runtime}${on ? " is-on" : ""}`}
              title={`${title}\n⌥${index + 1}`}
              onClick={() => onChange(preset)}
              onKeyDown={(event) => onChipKeyDown(event, index)}
              disabled={disabled}
            >
              {body}
              <span className="kv2-run-preset-key" aria-hidden="true">⌥{index + 1}</span>
            </button>
          );
        })}
        {Array.from({ length: RUN_PRESET_LIMIT - presets.length }, (_, slot) => (
          editing ? (
            <button
              key={`slot-${slot}`}
              type="button"
              className="kv2-run-preset-slot is-add"
              onClick={() => openPicker({ kind: "add" })}
              disabled={disabled}
            >
              ＋ 즐겨찾기 추가
            </button>
          ) : (
            <button
              key={`slot-${slot}`}
              type="button"
              className="kv2-run-preset-slot"
              tabIndex={-1}
              onClick={() => setEditing(true)}
              disabled={disabled}
              aria-label="빈 슬롯 — 편집에서 즐겨찾기 추가"
            >
              {presets.length === 0 && slot === 0 ? "편집에서 즐겨찾기 추가" : ""}
            </button>
          )
        ))}
      </div>

      <span className="kv2-run-preset-status" role="status" aria-live="polite">{status}</span>

      {picker && draftRuntime && (
        <div className="kv2-run-preset-picker" role="dialog" aria-label={pickerTitle} onKeyDown={onPickerKeyDown}>
          <div className="kv2-run-preset-picker-head">
            <span>{pickerTitle}</span>
            <span className="kv2-run-preset-spacer" />
            <kbd>↑↓</kbd><kbd>Enter</kbd><kbd>Esc</kbd>
          </div>
          <div className="kv2-run-preset-two">
            <div className="kv2-run-preset-runtimes" role="radiogroup" aria-label="Runtime">
              {runtimes.map((entry) => (
                <button
                  key={entry.runtime}
                  type="button"
                  role="radio"
                  aria-checked={entry.runtime === draft.runtime}
                  className={`kv2-run-preset-rt${entry.runtime === draft.runtime ? " is-on" : ""}`}
                  onClick={() => switchRuntime(entry.runtime)}
                >
                  <RuntimeIcon runtime={entry.runtime} />
                  {entry.label}
                  <small>{entry.models.length}</small>
                </button>
              ))}
            </div>
            <div className="kv2-run-preset-models" ref={modelListRef} role="listbox" aria-label="모델">
              {groups.map(([tier, models]) => (
                <div key={tier || "models"} role="group" aria-label={tier || draftRuntime.label}>
                  {tier && <div className="kv2-run-preset-tier">{tier.toUpperCase()}</div>}
                  {models.map((model) => {
                    const { name, tag } = splitModelLabel(model.label);
                    const on = model.id === draft.model;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        data-model={model.id}
                        className={`kv2-run-preset-model${on ? " is-on" : ""}`}
                        onClick={() => setDraftModel(model.id)}
                        onDoubleClick={() => {
                          setDraftModel(model.id);
                          if (picker.kind === "select") {
                            onChange({ ...draft, model: model.id } as RunPreset);
                            closePicker();
                          }
                        }}
                      >
                        <span className="kv2-run-preset-dot" aria-hidden="true" />
                        <span className="kv2-run-preset-model-name">
                          {name} <small>{model.id}</small>
                        </span>
                        <small>{tag ?? ""}</small>
                        <span className="kv2-run-preset-model-star" aria-label={starredModels.has(model.id) ? "즐겨찾기에 있음" : undefined}>
                          {starredModels.has(model.id) ? "★" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="kv2-run-preset-opts-grid">
            <span className="kv2-run-preset-opts-label">{draft.runtime === "claude" ? "PERMISSION" : "SANDBOX"}</span>
            <SegmentGroup
              label={draft.runtime === "claude" ? "Permission" : "Sandbox"}
              options={permissionOptions(draft.runtime)}
              value={draft.permission}
              onChange={setDraftPermission}
            />
            <span className="kv2-run-preset-opts-label">EFFORT</span>
            <SegmentGroup
              label="Effort"
              options={effortOptions(draft.runtime)}
              value={draft.effort}
              onChange={setDraftEffort}
            />
          </div>
          {replacing && (
            <div className="kv2-run-preset-replace">
              <div className="kv2-run-preset-replace-title">즐겨찾기가 가득 찼어요 ({RUN_PRESET_LIMIT}/{RUN_PRESET_LIMIT}) — 바꿀 항목을 고르세요</div>
              <div className="kv2-run-preset-replace-grid">
                {presets.map((preset, index) => (
                  <button
                    key={`r-${index}`}
                    type="button"
                    title={presetTitle(runtimes, preset)}
                    onClick={() => replaceSlot(index)}
                  >
                    ⌥{index + 1} {presetModelLabel(runtimes, preset).name} · {presetOptionLine(preset)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="kv2-run-preset-picker-foot">
            <span className={`kv2-run-preset-picker-msg${draftIsDuplicate && picker.kind !== "select" ? " is-warn" : ""}`}>
              {picker.kind === "select"
                ? (replacing ? "노란 목록에서 교체할 칩 선택" : "적용 = 이번 태스크에만")
                : draftIsDuplicate
                  ? "같은 4가지 조합이 이미 있어요"
                  : picker.kind === "add"
                    ? `★ ${presets.length}/${RUN_PRESET_LIMIT} → ${presets.length + 1}/${RUN_PRESET_LIMIT}`
                    : "칩 내용만 바뀌고 순서(⌥번호)는 유지"}
            </span>
            <span className="kv2-run-preset-spacer" />
            {picker.kind === "select" && (
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--small"
                onClick={addDraftFromSelect}
                disabled={draftIsDuplicate || replacing || !draft.model}
              >
                {draftIsDuplicate ? "★ 이미 즐겨찾기" : isFull ? "☆ 교체해서 추가" : "☆ 즐겨찾기에도 추가"}
              </button>
            )}
            <button type="button" className="kv2-btn kv2-btn--ghost kv2-btn--small" onClick={closePicker}>
              취소
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--primary kv2-btn--small"
              onClick={commitPicker}
              disabled={!draft.model || (picker.kind !== "select" && draftIsDuplicate)}
            >
              {picker.kind === "select" ? "적용" : picker.kind === "add" ? "★ 즐겨찾기에 추가" : "★ 저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
