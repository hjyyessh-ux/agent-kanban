import { useState } from 'react';
import type { DiscoveredSkill, SkillVisibility } from '../../../../src/core/types';
import type { McpPlacement } from '../../../../src/core/types';
import {
  previewSkillVisibility,
  patchSkillVisibility,
  previewMcpAlwaysLoad,
  patchMcpAlwaysLoad,
  type SkillOverrideValue,
  type VisibilityChange,
} from '../../hooks/useScopeInventory';
import { DiffPreview } from './DiffPreview';

// ─── Skill visibility control ────────────────────────────────────

const OVERRIDE_OPTIONS: Array<{ value: SkillOverrideValue | null; label: string; title: string }> = [
  { value: null, label: 'default', title: '설정 없음 (Claude Code 기본값)' },
  { value: 'on', label: 'on', title: 'description + name 모두 context에 포함' },
  { value: 'name-only', label: 'name-only', title: 'name만 포함, description 제외 (토큰 절약)' },
  { value: 'user-invocable-only', label: 'user-only', title: '사용자 호출(/name)에만 표시' },
  { value: 'off', label: 'off', title: 'context에서 완전히 제외' },
];

interface SkillVisibilityControlProps {
  skill: DiscoveredSkill & SkillVisibility;
  onApplied: () => void;
}

export function SkillVisibilityControl({ skill, onApplied }: SkillVisibilityControlProps) {
  const [pendingOverride, setPendingOverride] = useState<SkillOverrideValue | null | undefined>(undefined);
  const [pendingDMI, setPendingDMI] = useState<boolean | undefined>(undefined);
  const [previewChanges, setPreviewChanges] = useState<VisibilityChange[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Plugin/system skills cannot use skillOverrides
  const isPluginControlled = skill.runtime !== 'claude' || skill.source.includes('system');

  async function fetchPreview(
    overrideVal: SkillOverrideValue | null | undefined,
    dmiVal: boolean | undefined,
  ) {
    const patch: Parameters<typeof previewSkillVisibility>[1] = { scope: 'user' };
    if (overrideVal !== undefined) patch.override = overrideVal;
    if (dmiVal !== undefined) patch.disableModelInvocation = dmiVal;

    if (!patch.override && patch.disableModelInvocation === undefined) {
      setPreviewChanges(null);
      return;
    }

    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const result = await previewSkillVisibility(skill.id, patch);
      setPreviewChanges(result.changes);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview 실패');
      setPreviewChanges(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  function handleOverrideClick(value: SkillOverrideValue | null) {
    if (isPluginControlled) return;
    setPendingOverride(value);
    void fetchPreview(value, pendingDMI);
  }

  function handleDmiToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.checked;
    setPendingDMI(val);
    void fetchPreview(pendingOverride, val);
  }

  async function handleApply() {
    const patch: Parameters<typeof patchSkillVisibility>[1] = { scope: 'user' };
    if (pendingOverride !== undefined) patch.override = pendingOverride;
    if (pendingDMI !== undefined) patch.disableModelInvocation = pendingDMI;

    setApplying(true);
    setApplyError(null);
    try {
      await patchSkillVisibility(skill.id, patch);
      setPreviewChanges(null);
      setPendingOverride(undefined);
      setPendingDMI(undefined);
      onApplied();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : '적용 실패');
    } finally {
      setApplying(false);
    }
  }

  function handleCancel() {
    setPendingOverride(undefined);
    setPendingDMI(undefined);
    setPreviewChanges(null);
    setPreviewError(null);
    setApplyError(null);
  }

  const effectiveOverride = pendingOverride !== undefined ? pendingOverride : skill.override;
  const effectiveDMI = pendingDMI !== undefined ? pendingDMI : (skill.disableModelInvocation ?? false);

  return (
    <div className="vis-control">
      <div className="vis-control-section">
        <div className="vis-control-label">
          skillOverrides
          {isPluginControlled && (
            <span className="vis-control-disabled-hint" title="plugin/system skill — skillOverrides 무효">
              {' '}(비활성: plugin skill)
            </span>
          )}
        </div>
        <div className="vis-seg-group" role="group" aria-label="Skill override">
          {OVERRIDE_OPTIONS.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              className={`vis-seg-btn${effectiveOverride === opt.value ? ' vis-seg-btn--active' : ''}`}
              title={opt.title}
              disabled={isPluginControlled}
              onClick={() => handleOverrideClick(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {skill.runtime === 'claude' && skill.filePath && (
        <div className="vis-control-section">
          <label className="vis-control-checkbox-label">
            <input
              type="checkbox"
              className="vis-control-checkbox"
              checked={effectiveDMI}
              onChange={handleDmiToggle}
            />
            <span>
              <code>disable-model-invocation</code>
              <span className="vis-control-hint"> — description을 context에서 제거, /name 수동 호출 유지</span>
            </span>
          </label>
        </div>
      )}

      {loadingPreview && <div className="vis-control-loading">미리보기 로딩 중...</div>}
      {previewError && <div className="vis-control-error">{previewError}</div>}

      {previewChanges && (
        <DiffPreview
          changes={previewChanges}
          applying={applying}
          error={applyError}
          onApply={() => void handleApply()}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}

// ─── MCP alwaysLoad control ──────────────────────────────────────

interface McpAlwaysLoadControlProps {
  mcpName: string;
  placement: McpPlacement;
  onApplied: () => void;
}

export function McpAlwaysLoadControl({ mcpName, placement, onApplied }: McpAlwaysLoadControlProps) {
  const [pendingValue, setPendingValue] = useState<boolean | undefined>(undefined);
  const [previewChanges, setPreviewChanges] = useState<VisibilityChange[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  if (placement.managed) {
    return (
      <div className="vis-control vis-control--disabled">
        <span className="vis-control-hint">managed placement — alwaysLoad 변경 불가</span>
      </div>
    );
  }

  if (placement.scope === 'local') {
    return (
      <div className="vis-control vis-control--disabled">
        <span className="vis-control-hint">local scope — Phase 3에서 지원 예정</span>
      </div>
    );
  }

  async function fetchPreview(value: boolean) {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const result = await previewMcpAlwaysLoad(mcpName, {
        location: placement.location,
        scope: placement.scope as 'user' | 'project',
        alwaysLoad: value,
      });
      setPreviewChanges(result.changes);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview 실패');
      setPreviewChanges(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  function handleToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.checked;
    setPendingValue(val);
    void fetchPreview(val);
  }

  async function handleApply() {
    if (pendingValue === undefined) return;
    setApplying(true);
    setApplyError(null);
    try {
      await patchMcpAlwaysLoad(mcpName, {
        location: placement.location,
        scope: placement.scope as 'user' | 'project',
        alwaysLoad: pendingValue,
      });
      setPreviewChanges(null);
      setPendingValue(undefined);
      onApplied();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : '적용 실패');
    } finally {
      setApplying(false);
    }
  }

  function handleCancel() {
    setPendingValue(undefined);
    setPreviewChanges(null);
    setPreviewError(null);
    setApplyError(null);
  }

  const effectiveValue = pendingValue !== undefined ? pendingValue : placement.alwaysLoad;

  return (
    <div className="vis-control">
      <div className="vis-control-section">
        <label className="vis-control-checkbox-label">
          <input
            type="checkbox"
            className="vis-control-checkbox"
            checked={effectiveValue}
            onChange={handleToggle}
          />
          <span>
            <span className="vis-alwaysload-label">⚡ alwaysLoad</span>
            <span className="vis-control-hint"> — tool-search를 무시하고 강제 선로딩 (해제 시 토큰 절약)</span>
          </span>
        </label>
        {effectiveValue && (
          <div className="vis-control-warn">
            alwaysLoad 활성 상태: 이 MCP의 tool schema가 매 요청마다 선로딩됩니다.
          </div>
        )}
      </div>

      {loadingPreview && <div className="vis-control-loading">미리보기 로딩 중...</div>}
      {previewError && <div className="vis-control-error">{previewError}</div>}

      {previewChanges && (
        <DiffPreview
          changes={previewChanges}
          applying={applying}
          error={applyError}
          onApply={() => void handleApply()}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
