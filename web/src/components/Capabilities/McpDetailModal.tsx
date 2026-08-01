import { useState } from 'react';
import type { McpInventoryItem, McpPlacement, PlacementTarget } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { ScopeChip } from './ScopeChip';
import { DiffPreview } from './DiffPreview';
import { McpAlwaysLoadControl } from './VisibilityControl';
import { RuntimeBadge } from '../Board/BoardCardSections';
import {
  copyMcpServer,
  moveMcpServer,
  previewCopyMcpServer,
  previewMoveMcpServer,
  removeMcpServer,
  previewRemoveMcpServer,
  freezeMcpApi,
  previewFreezeMcpApi,
  type McpCopyBody,
  type McpMoveBody,
  type VisibilityChange,
} from '../../hooks/useScopeInventory';
import { maskSecretDef } from './capability-format';

interface McpDetailModalProps {
  item: McpInventoryItem;
  placementTargets: PlacementTarget[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

type ActionMode = 'none' | 'copy' | 'move';
type CapScope = 'user' | 'local' | 'project';

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
  const [pendingBody, setPendingBody] = useState<McpCopyBody | McpMoveBody | null>(null);

  // For remove per placement
  const [removingPlacement, setRemovingPlacement] = useState<McpPlacement | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Freeze state — tracks which placement row is currently being frozen.
  const [freezingIdx, setFreezingIdx] = useState<number | null>(null);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [placementPreview, setPlacementPreview] = useState<{
    kind: 'remove' | 'freeze'; placement: McpPlacement; idx: number; changes: VisibilityChange[];
  } | null>(null);

  const resetAction = () => {
    setActionMode('none');
    setSelectedPlacementId('');
    setMoveSourceIdx(0);
    setPendingChanges(null);
    setActionError(null);
    setSecretWarning(null);
    setSecretPendingBody(null);
    setPendingBody(null);
  };

  const eligibleTargets = placementTargets.filter(
    (t) => t.runtime === item.runtime &&
      (t.kind === 'user' || t.kind === 'local' || t.kind === 'project'),
  );

  function buildBody(mode: ActionMode, targetId: string, force = false): McpCopyBody | McpMoveBody | null {
    const target = eligibleTargets.find((t) => t.id === targetId);
    if (!target) return null;
    const toScope = target.kind as CapScope;
    if (mode === 'copy') {
      return {
        runtime: item.runtime,
        inventoryIdentity: item.identity,
        sourcePlacementIdentity: item.placements[moveSourceIdx]?.identity ?? item.placements[0]?.identity,
        targetId: target.id,
        toScope,
        targetDir: toScope === 'local' ? target.dir : undefined,
        projectDir: toScope === 'project' ? target.dir : undefined,
        forceSecret: force,
      } satisfies McpCopyBody;
    }
    // move — remove from the user-selected source placement
    const srcPlacement = item.placements[moveSourceIdx] ?? item.placements[0];
    return {
      runtime: item.runtime,
      inventoryIdentity: item.identity,
      sourcePlacementIdentity: srcPlacement.identity,
      targetId: target.id,
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

    setApplying(false);
    setActionError(null);
    setSecretWarning(null);

    try {
      const result =
        actionMode === 'copy'
          ? await previewCopyMcpServer(item.name, body as McpCopyBody)
          : await previewMoveMcpServer(item.name, body as McpMoveBody);

      if (result.secretWarning) {
        setSecretWarning(result.message ?? 'Plaintext secret detected in MCP definition.');
        setSecretPendingBody(body);
        return;
      }

      setPendingChanges(result.changes);
      setPendingBody(body);
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
          ? await previewCopyMcpServer(item.name, body as McpCopyBody)
          : await previewMoveMcpServer(item.name, body as McpMoveBody);
      setPendingChanges(result.changes);
      setPendingBody(body);
      setSecretWarning(null);
      setSecretPendingBody(null);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    if (!pendingBody || actionMode === 'none') return;
    if (actionMode === 'move' && pendingChanges?.some((change) => change.isProjectFile) &&
      !window.confirm('project 설정 파일이 변경됩니다. 미리 본 diff를 적용하시겠습니까?')) return;
    setApplying(true);
    setActionError(null);
    try {
      if (actionMode === 'copy') await copyMcpServer(item.name, pendingBody as McpCopyBody);
      else await moveMcpServer(item.name, pendingBody as McpMoveBody);
      setSuccessMsg(`${actionMode === 'copy' ? 'Copied' : 'Moved'} successfully. New session required.`);
      resetAction();
      await onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setApplying(false);
    }
  };

  const handleRemovePlacement = async (placement: McpPlacement) => {
    setRemovingPlacement(placement);
    setRemoveError(null);
    try {
      const result = await previewRemoveMcpServer(item.name, {
        runtime: item.runtime,
        inventoryIdentity: item.identity,
        placementIdentity: placement.identity,
        scope: placement.scope as CapScope,
        targetDir: placement.scope === 'local' ? placement.dir : undefined,
        projectDir: placement.scope === 'project' ? placement.dir : undefined,
      });
      setPlacementPreview({ kind: 'remove', placement, idx: item.placements.indexOf(placement), changes: result.changes });
    } catch (e: unknown) {
      setRemoveError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setRemovingPlacement(null);
    }
  };

  const handleFreeze = async (placement: McpPlacement, idx: number) => {
    // freezeMcp removes from projects[fromDir] (local) or <fromDir>/.mcp.json (project).
    // Same-name entries in Cold Storage are overwritten with the latest def (see freezeMcp).
    const fromDir = placement.scope === 'local' || placement.scope === 'project'
      ? placement.dir
      : undefined;
    setFreezingIdx(idx);
    setFreezeError(null);
    try {
      const result = await previewFreezeMcpApi(item.name, placement.scope, fromDir, item.runtime, placement.identity);
      setPlacementPreview({ kind: 'freeze', placement, idx, changes: result.changes });
    } catch (e: unknown) {
      setFreezeError(e instanceof Error ? e.message : 'Freeze failed');
    } finally {
      setFreezingIdx(null);
    }
  };

  const applyPlacementPreview = async () => {
    if (!placementPreview) return;
    const { kind, placement, idx } = placementPreview;
    if (placement.scope === 'project' &&
      !window.confirm(`project 설정 파일에서 MCP를 ${kind === 'freeze' ? 'freeze' : 'remove'}합니다. 미리 본 diff를 적용하시겠습니까?`)) return;
    setApplying(true);
    try {
      if (kind === 'remove') {
        await removeMcpServer(item.name, {
          runtime: item.runtime, inventoryIdentity: item.identity, placementIdentity: placement.identity,
          scope: placement.scope as CapScope,
          targetDir: placement.scope === 'local' ? placement.dir : undefined,
          projectDir: placement.scope === 'project' ? placement.dir : undefined,
        });
        setSuccessMsg('Removed. New session required.');
      } else {
        const fromDir = placement.scope === 'local' || placement.scope === 'project' ? placement.dir : undefined;
        setFreezingIdx(idx);
        await freezeMcpApi(item.name, placement.scope, fromDir, item.runtime, placement.identity);
        setSuccessMsg(`Frozen from ${placement.scope} scope. Cold Storage에서 restore 가능합니다.`);
      }
      setPlacementPreview(null);
      await onRefresh();
    } catch (e: unknown) {
      if (kind === 'remove') setRemoveError(e instanceof Error ? e.message : 'Remove failed');
      else setFreezeError(e instanceof Error ? e.message : 'Freeze failed');
    } finally {
      setApplying(false);
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
            <RuntimeBadge runtime={item.runtime} />
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
              <div key={p.identity}>
              <div className="inv-placement-row">
                <ScopeChip scope={p.scope} alwaysLoad={p.alwaysLoad} managed={p.managed} />
                <div className="inv-placement-where">
                  <span className="inv-placement-loc" title={p.location}>{p.location}</span>
                  {p.dir && (
                    <span className="inv-placement-dir" title={p.dir}>{p.dir}</span>
                  )}
                  {item.runtime === 'codex' && (
                    <span className="inv-placement-dir">
                      {p.configLayer ?? p.scope}{p.effective ? ' · effective' : p.overriddenBy ? ` · overridden by ${p.overriddenBy}` : ''}
                      {p.appliesToDir ? ` · applies to ${p.appliesToDir}` : ''}
                    </span>
                  )}
                </div>
                {!p.managed && (
                  <div className="mcp-detail-placement-actions">
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--small cold-freeze-btn"
                      disabled={freezingIdx === i}
                      onClick={() => void handleFreeze(p, i)}
                      title="이 placement를 Cold Storage로 보관합니다 (같은 이름이 있으면 최신으로 덮어씀)"
                    >
                      {freezingIdx === i ? '보관 중…' : '❄ Freeze to storage'}
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
              <McpAlwaysLoadControl
                mcpName={item.name}
                placement={p}
                onApplied={() => void onRefresh()}
              />
              </div>
            ))}
          </div>
          {removeError && <p className="cap-detail-error">{removeError}</p>}
          {freezeError && <p className="cap-detail-error">{freezeError}</p>}
          {placementPreview && (
            <DiffPreview
              changes={placementPreview.changes}
              applying={applying}
              error={placementPreview.kind === 'remove' ? removeError : freezeError}
              onApply={() => void applyPlacementPreview()}
              onCancel={() => setPlacementPreview(null)}
            />
          )}
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
                Preview
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

            {/* Previewed change; Apply performs the mutation. */}
            {pendingChanges && !secretWarning && (
              <DiffPreview
                changes={pendingChanges}
                applying={applying}
                error={actionError}
                onApply={() => void handleApply()}
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
