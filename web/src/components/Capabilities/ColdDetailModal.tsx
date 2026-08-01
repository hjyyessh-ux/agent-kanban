import { useEffect, useState } from 'react';
import type { ColdManifestEntry, PlacementTarget, SkillRoot } from '../../../../src/core/types';
import { CardMarkdown } from '../Card/CardMarkdown';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { ScopeChip } from './ScopeChip';
import { ColdEntryActions } from './ColdEntryActions';
import { maskSecretDef, stripFrontmatter, timeAgo } from './capability-format';
import { fetchColdEntryDetail, type ColdEntryDetail } from '../../hooks/useScopeInventory';

interface ColdDetailModalProps {
  entry: ColdManifestEntry;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onClose: () => void;
  onRestored: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

type PanelMode = 'preview' | 'raw';

export function ColdDetailModal({
  entry,
  skillRoots,
  placementTargets,
  onClose,
  onRestored,
  onDeleted,
}: ColdDetailModalProps) {
  const [detail, setDetail] = useState<ColdEntryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('preview');

  useEffect(() => {
    let active = true;
    fetchColdEntryDetail(entry.kind, entry.ref)
      .then((d) => { if (active) setDetail(d); })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : 'Failed to load entry');
      });
    return () => { active = false; };
  }, [entry.kind, entry.ref]);

  const defJson = detail?.def ? JSON.stringify(maskSecretDef(detail.def), null, 2) : null;

  return (
    <DialogSkeleton
      title={entry.ref}
      onClose={onClose}
      persistSizeKey="cap-cold-detail-size"
      defaultSize={{ width: 800, height: 720 }}
      className="cap-detail-dialog"
    >
      <div className="cap-detail-stack">
        {/* Meta */}
        <div className="cap-detail-meta">
          <div className="cap-detail-badges">
            <span className={`cap-chip cap-chip--${entry.kind}`}>
              {entry.kind === 'skill' ? '❄ skill' : '❄ MCP'}
            </span>
            {entry.runtime && <RuntimeBadge runtime={entry.runtime} />}
            <ScopeChip scope={entry.sourceScope} />
            <span className="cold-item__age">frozen {timeAgo(entry.createdAt)}</span>
          </div>
          <p className="cap-detail-desc">
            Cold Storage에 보관 중입니다. agent 설정에서는 분리된 상태이며, 아래에서 원하는 위치로 복원할 수 있습니다.
          </p>
          <div className="cap-detail-dir">{entry.sourcePath}</div>
          {entry.projectRoot && <div className="cap-detail-dir">project: {entry.projectRoot}</div>}
        </div>

        {/* Content toggle (skill only — MCP has a single JSON view) */}
        {entry.kind === 'skill' && detail?.content && (
          <div className="cap-detail-toggle-row">
            <div className="cap-filter-group" role="group" aria-label="View mode">
              {(['preview', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`cap-filter-btn${mode === m ? ' cap-filter-btn--active' : ''}`}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                >
                  {m === 'preview' ? 'Preview' : 'Raw'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="cap-detail-body">
          {loadError ? (
            <p className="cap-detail-error">{loadError}</p>
          ) : !detail ? (
            <div className="cap-detail-loading">Loading...</div>
          ) : entry.kind === 'skill' ? (
            detail.content ? (
              mode === 'preview' ? (
                <div className="cap-detail-preview">
                  <CardMarkdown text={stripFrontmatter(detail.content)} />
                </div>
              ) : (
                <pre className="mcp-detail-def-preview">{detail.content}</pre>
              )
            ) : (
              <p className="cap-detail-empty">
                보관된 폴더에 SKILL.md가 없습니다 — 파일은 {entry.sourcePath} 에서 옮겨져 그대로 보존되어 있습니다.
              </p>
            )
          ) : defJson ? (
            <pre className="mcp-detail-def-preview">{defJson}</pre>
          ) : (
            <p className="cap-detail-empty">보관된 MCP 정의를 찾을 수 없습니다.</p>
          )}
        </div>

        {/* Restore / Delete */}
        <div className="cap-detail-section">
          <span className="cap-detail-section-title">Restore / Delete</span>
          <p className="cap-detail-section-hint">
            복원 위치를 선택하면 {entry.kind === 'mcp'
              ? '적용 전에 설정 파일 변경 내용을 먼저 확인할 수 있습니다.'
              : '선택한 skill 디렉토리(root)로 다시 옮겨집니다.'}
            {' '}Delete는 영구 삭제이며 되돌릴 수 없습니다.
          </p>
          <ColdEntryActions
            entry={entry}
            skillRoots={skillRoots}
            placementTargets={placementTargets}
            onRestored={async () => { await onRestored(); onClose(); }}
            onDeleted={async () => { await onDeleted(); onClose(); }}
          />
        </div>
      </div>
    </DialogSkeleton>
  );
}
