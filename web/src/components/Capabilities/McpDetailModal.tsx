import { useState } from 'react';
import type { McpInventoryItem, McpPlacement, PlacementTarget } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { ScopeChip } from './ScopeChip';
import { DiffPreview } from './DiffPreview';
import {
  copyMcpServer,
  moveMcpServer,
  removeMcpServer,
  freezeMcpApi,
  type McpCopyBody,
  type McpMoveBody,
  type VisibilityChange,
} from '../../hooks/useScopeInventory';

interface McpDetailModalProps {
  item: McpInventoryItem;
  placementTargets: PlacementTarget[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

type ActionMode = 'none' | 'copy' | 'move';
type CapScope = 'user' | 'local' | 'project';

function maskSecret(val: string): string {
  if (val.length <= 8) return '***';
  return val.slice(0, 4) + '***' + val.slice(-4);
}

function maskSecretDef(def: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...def };
  if (result.env && typeof result.env === 'object') {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.env as Record<string, string>)) {
      masked[k] = typeof v === 'string' && v.length > 12 ? maskSecret(v) : v;
    }
    result.env = masked;
  }
  if (result.headers && typeof result.headers === 'object') {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.headers as Record<string, string>)) {
      if (/auth|token|key|secret/i.test(k) && typeof v === 'string' && v.length > 12) {
        masked[k] = maskSecret(v);
      } else {
        masked[k] = v;
      }
    }
    result.headers = masked;
  }
  return result;
}

function scopeLabel(scope: CapScope): string {
  return scope === 'user' ? 'Global (user)' : scope === 'local' ? 'Local' : 'Project';
}

export function McpDetailModal({ item, placementTargets, onClose, onRefresh }: McpDetailModalProps) {
  const [actionMode, setActionMode] = useState<ActionMode>('none');
  const [selectedPlacementId, setSelectedPlacementId] = useState('');
  // Index into item.placements — which placement a Move removes from.
  const [moveSourceIdx, setMoveSourceIdx] = useState(0);

  // For copy/move action
  const [pendingChanges, setPendingChanges] = useState<VisibilityChange[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [secretWarning, setSecretWarning] = useState<string | null>(null);
  const [secretPendingBody, setSecretPendingBody] = useState<McpCopyBody | McpMoveBody | null>(null);

  // For remove per placement
  const [removingPlacement, setRemovingPlacement] = useState<McpPlacement | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Freeze state — tracks which placement row is currently being frozen.
  const [freezingIdx, setFreezingIdx] = useState<number | null>(null);
  const [freezeError, setFreezeError] = useState<string | null>(null);

  const resetAction = () => {
    setActionMode('none');
    setSelectedPlacementId('');
    setMoveSourceIdx(0);
    setPendingChanges(null);
    setActionError(null);
    setSecretWarning(null);
    setSecretPendingBody(null);
  };

  const eligibleTargets = placementTargets.filter(
    (t) => t.kind === 'user' || t.kind === 'local' || t.kind === 'project',
  );

  function buildBody(mode: ActionMode, targetId: string, force = false): McpCopyBody | McpMoveBody | null {
    const target = eligibleTargets.find((t) => t.id === targetId);
    if (!target) return null;
    const toScope = target.kind as CapScope;
    if (mode === 'copy') {
      return {
        toScope,
        targetDir: toScope === 'local' ? target.dir : undefined,
        projectDir: toScope === 'project' ? target.dir : undefined,
        forceSecret: force,
      } satisfies McpCopyBody;
    }
    // move — remove from the user-selected source placement
    const srcPlacement = item.placements[moveSourceIdx] ?? item.placements[0];
    return {
      fromScope: srcPlacement.scope as CapScope,
      // local: projects[dir] key inside ~/.claude.json; project: repo dir holding .mcp.json.
      fromDir: srcPlacement.dir,
      toScope,
      targetDir: toScope === 'local' ? target.dir : undefined,
      projectDir: toScope === 'project' ? target.dir : undefined,
      forceSecret: force,
    } satisfies McpMoveBody;
  }

  const handlePreview = async () => {
    if (!selectedPlacementId || actionMode === 'none') return;
    const body = buildBody(actionMode, selectedPlacementId);
    if (!body) return;

    // copy/move write the target config immediately (the API returns the
    // before/after of the applied change), so confirm before executing.
    const target = eligibleTargets.find((t) => t.id === selectedPlacementId);
    const summary = actionMode === 'copy'
      ? `"${item.name}"을(를) [${target?.kind}] ${target?.label}에 복사합니다.`
      : `"${item.name}"을(를) ${item.placements[moveSourceIdx]?.scope ?? '?'} scope에서 제거하고 [${target?.kind}] ${target?.label}(으)로 이동합니다.`;
    if (!window.confirm(`${summary}\n설정 파일이 즉시 수정됩니다. 계속하시겠습니까?`)) return;

    setApplying(false);
    setActionError(null);
    setSecretWarning(null);

    try {
      const result =
        actionMode === 'copy'
          ? await copyMcpServer(item.name, body as McpCopyBody)
          : await moveMcpServer(item.name, body as McpMoveBody);

      if (result.secretWarning) {
        setSecretWarning(result.message ?? 'Plaintext secret detected in MCP definition.');
        setSecretPendingBody(body);
        return;
      }

      const target = eligibleTargets.find((t) => t.id === selectedPlacementId);
      const fileLabel = target?.dir ?? '';
      setPendingChanges([
        {
          filePath: fileLabel,
          isProjectFile: target?.kind === 'project',
          before: result.before,
          after: result.after,
        },
      ]);
      setSuccessMsg(`${actionMode === 'copy' ? 'Copied' : 'Moved'} successfully. New session required.`);
      await onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Operation failed');
    }
  };

  const handleForceApply = async () => {
    if (!secretPendingBody || actionMode === 'none') return;
    const body = { ...secretPendingBody, forceSecret: true };
    setApplying(true);
    setActionError(null);
    try {
      const result =
        actionMode === 'copy'
          ? await copyMcpServer(item.name, body as McpCopyBody)
          : await moveMcpServer(item.name, body as McpMoveBody);

      const target = eligibleTargets.find((t) => t.id === selectedPlacementId);
      setPendingChanges([
        {
          filePath: target?.dir ?? '',
          isProjectFile: target?.kind === 'project',
          before: result.before,
          after: result.after,
        },
      ]);
      setSecretWarning(null);
      setSecretPendingBody(null);
      setSuccessMsg(`${actionMode === 'copy' ? 'Copied' : 'Moved'} successfully (secret confirmed). New session required.`);
      await onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setApplying(false);
    }
  };

  const handleRemovePlacement = async (placement: McpPlacement) => {
    if (!window.confirm(`${scopeLabel(placement.scope as CapScope)}에서 이 MCP 설정을 제거합니다. 계속하시겠습니까?`)) return;
    setRemovingPlacement(placement);
    setRemoveError(null);
    try {
      await removeMcpServer(item.name, {
        scope: placement.scope as CapScope,
        targetDir: placement.scope === 'local' ? placement.dir : undefined,
        projectDir: placement.scope === 'project' ? placement.dir : undefined,
      });
      setRemovingPlacement(null);
      setSuccessMsg('Removed. New session required.');
      await onRefresh();
    } catch (e: unknown) {
      setRemoveError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setRemovingPlacement(null);
    }
  };

  const handleFreeze = async (placement: McpPlacement, idx: number) => {
    if (placement.scope === 'project') {
      if (!window.confirm('project 항목: git 관리 파일(.mcp.json)이므로 변경이 발생합니다. 계속하시겠습니까?')) return;
    }
    // freezeMcp removes from projects[fromDir] (local) or <fromDir>/.mcp.json (project).
    // Same-name entries in Cold Storage are overwritten with the latest def (see freezeMcp).
    const fromDir = placement.scope === 'local' || placement.scope === 'project'
      ? placement.dir
      : undefined;
    setFreezingIdx(idx);
    setFreezeError(null);
    try {
      await freezeMcpApi(item.name, placement.scope, fromDir);
      setSuccessMsg(`Frozen from ${placement.scope} scope. Cold Storage에서 restore 가능합니다.`);
      await onRefresh();
    } catch (e: unknown) {
      setFreezeError(e instanceof Error ? e.message : 'Freeze failed');
    } finally {
      setFreezingIdx(null);
    }
  };

  const anyAlwaysLoad = item.placements.some((p) => p.alwaysLoad);
  const anyManaged = item.placements.some((p) => p.managed);
  const anySecret = item.placements.some((p) => p.hasPlaintextSecret);
  const maskedDef = anySecret ? maskSecretDef(item.def as Record<string, unknown>) : item.def;

  return (
    <DialogSkeleton
      title={item.name}
      onClose={onClose}
      persistSizeKey="cap-mcp-detail-size"
      defaultSize={{ width: 800, height: 720 }}
      className="cap-detail-dialog"
    >
      <div className="cap-detail-stack">
        {/* Meta */}
        <div className="cap-detail-meta">
          <div className="cap-detail-badges">
            <span className="cap-chip cap-chip--mcp">MCP</span>
            {item.def.type && (
              <span className="cap-chip cap-chip--plain">{String(item.def.type)}</span>
            )}
            {anyAlwaysLoad && (
              <span className="cap-chip cap-chip--alwaysload" title="강제 선로딩">⚡ alwaysLoad</span>
            )}
            {anyManaged && (
              <span className="cap-chip cap-chip--managed" title="plugin/enterprise 제공 — 이동 불가">🔒 managed</span>
            )}
            {anySecret && (
              <span className="cap-chip cap-chip--secret-warn">⚠ secret?</span>
            )}
          </div>
        </div>

        {/* Definition preview */}
        <div className="cap-detail-section">
          <span className="cap-detail-section-title">Definition</span>
          {anySecret && (
            <p className="cap-detail-section-hint cap-detail-section-hint--danger">
              ⚠ 비밀값이 마스킹되어 표시됩니다. 실제 파일에는 원본이 저장됩니다.
            </p>
          )}
          <pre className="mcp-detail-def-preview">
            {JSON.stringify(maskedDef, null, 2)}
          </pre>
        </div>

        {/* Current placements */}
        <div className="cap-detail-section">
          <span className="cap-detail-section-title">Current Placements</span>
          <p className="cap-detail-section-hint">새 세션에서만 변경이 반영됩니다.</p>
          <div className="mcp-detail-placements">
            {item.placements.map((p, i) => (
              <div key={i} className="inv-placement-row">
                <ScopeChip scope={p.scope} alwaysLoad={p.alwaysLoad} managed={p.managed} />
                <div className="inv-placement-where">
                  <span className="inv-placement-loc" title={p.location}>{p.location}</span>
                  {p.dir && (
                    <span className="inv-placement-dir" title={p.dir}>{p.dir}</span>
                  )}
                </div>
                {!p.managed && (
                  <div className="mcp-detail-placement-actions">
                    <button
                      type="button"
                      className="inv-freeze-btn"
                      disabled={freezingIdx === i}
                      onClick={() => void handleFreeze(p, i)}
                      title="이 placement를 Cold Storage로 보관합니다 (같은 이름이 있으면 최신으로 덮어씀)"
                    >
                      {freezingIdx === i ? '…' : '❄ Freeze'}
                    </button>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
                      disabled={removingPlacement === p}
                      onClick={() => void handleRemovePlacement(p)}
                      title={`Remove from ${scopeLabel(p.scope as CapScope)}`}
                    >
                      {removingPlacement === p ? '…' : 'Remove'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {removeError && <p className="cap-detail-error">{removeError}</p>}
          {freezeError && <p className="cap-detail-error">{freezeError}</p>}
        </div>

        {/* Copy / Move section */}
        {!anyManaged && (
          <div className="cap-detail-section">
            <span className="cap-detail-section-title">Copy / Move to Target</span>
            <p className="cap-detail-section-hint">
              Copy: 원본 유지하며 대상에 추가. Move: 원본 제거 후 대상으로 이동.
            </p>
            <div className="cap-detail-action-row cap-detail-action-row--wrap">
              <div className="cap-filter-group" role="group" aria-label="Action type">
                <button
                  type="button"
                  className={`cap-filter-btn${actionMode === 'copy' ? ' cap-filter-btn--active' : ''}`}
                  onClick={() => { resetAction(); setActionMode('copy'); }}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className={`cap-filter-btn${actionMode === 'move' ? ' cap-filter-btn--active' : ''}`}
                  onClick={() => { resetAction(); setActionMode('move'); }}
                >
                  Move
                </button>
              </div>
              {actionMode === 'move' && item.placements.length > 1 && (
                <select
                  className="kv2-select cap-detail-select"
                  value={moveSourceIdx}
                  onChange={(e) => setMoveSourceIdx(Number(e.target.value))}
                  aria-label="Move source placement"
                  title="어느 placement에서 제거할지 선택합니다"
                >
                  {item.placements.map((p, i) => (
                    <option key={i} value={i}>
                      from [{p.scope}] {p.dir ?? p.location}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="kv2-select cap-detail-select"
                value={selectedPlacementId}
                onChange={(e) => {
                  setSelectedPlacementId(e.target.value);
                  setPendingChanges(null);
                  setActionError(null);
                  setSecretWarning(null);
                }}
                disabled={actionMode === 'none'}
                aria-label="Target placement"
              >
                <option value="">— select target —</option>
                {eligibleTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    [{t.kind}] {t.label} ({t.dir})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="kv2-btn kv2-btn--primary kv2-btn--small"
                disabled={!selectedPlacementId || actionMode === 'none' || applying}
                onClick={() => void handlePreview()}
              >
                Apply
              </button>
              {actionMode !== 'none' && (
                <button
                  type="button"
                  className="kv2-btn kv2-btn--ghost kv2-btn--small"
                  onClick={resetAction}
                >
                  Cancel
                </button>
              )}
            </div>

            {/* Secret warning */}
            {secretWarning && (
              <div className="mcp-detail-secret-danger">
                <strong>⚠ Secret 경고</strong>
                <p>{secretWarning}</p>
                <p className="cap-detail-section-hint">
                  권장: env 값을 <code>$ENV_VAR</code> 참조로 변경한 후 진행하세요.
                </p>
                <div className="cap-detail-action-row">
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--danger kv2-btn--small"
                    onClick={() => void handleForceApply()}
                    disabled={applying}
                  >
                    {applying ? '적용 중...' : '위험 감수하고 진행'}
                  </button>
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--ghost kv2-btn--small"
                    onClick={resetAction}
                    disabled={applying}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}

            {/* Applied-change diff (copy/move already wrote the file) */}
            {pendingChanges && !secretWarning && (
              <DiffPreview
                changes={pendingChanges}
                applying={false}
                error={null}
                resultMode
                onApply={() => { setPendingChanges(null); }}
                onCancel={() => setPendingChanges(null)}
              />
            )}

            {actionError && <p className="cap-detail-error">{actionError}</p>}
          </div>
        )}

        {/* Success message */}
        {successMsg && (
          <p className="cap-detail-success">✓ {successMsg}</p>
        )}
      </div>
    </DialogSkeleton>
  );
}
