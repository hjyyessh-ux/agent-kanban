import { useState } from 'react';
import type { ColdManifestEntry } from '../../hooks/useScopeInventory';
import type { SkillRoot, PlacementTarget } from '../../../../src/core/types';
import {
  useColdStorage,
  restoreSkillColdApi,
  restoreMcpColdApi,
  previewRestoreMcpColdApi,
  deleteColdApi,
  type VisibilityChange,
} from '../../hooks/useScopeInventory';
import { DiffPreview } from './DiffPreview';

interface StorageDrawerProps {
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onRefresh: () => Promise<void>;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface EntryCardProps {
  entry: ColdManifestEntry;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onRestored: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

function EntryCard({ entry, skillRoots, placementTargets, onRestored, onDeleted }: EntryCardProps) {
  const [restoreTarget, setRestoreTarget] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreChanges, setRestoreChanges] = useState<VisibilityChange[] | null>(null);

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    setError(null);
    try {
      if (entry.kind === 'skill') {
        await restoreSkillColdApi(entry.ref, restoreTarget);
      } else {
        const target = placementTargets.find((t) => t.id === restoreTarget);
        if (!target) throw new Error('Target not found');
        const args = [
          entry.ref,
          target.kind === 'project' ? 'project' : target.kind === 'local' ? 'local' : 'user',
          target.kind === 'local' ? target.dir : undefined,
          target.kind === 'project' ? target.dir : undefined,
          entry.runtime === 'codex' ? 'codex' : 'claude',
        ] as const;
        if (!restoreChanges) {
          const preview = await previewRestoreMcpColdApi(...args);
          setRestoreChanges(preview.changes);
          return;
        }
        await restoreMcpColdApi(
          ...args,
        );
      }
      await onRestored();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setRestoring(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Permanently delete "${entry.ref}" from cold storage? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteColdApi(entry.kind, entry.ref);
      await onDeleted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const skillTargets = skillRoots.filter((r) => r.enabled);
  const mcpTargets = placementTargets.filter(
    (t) => (t.kind === 'user' || t.kind === 'local' || t.kind === 'project') &&
      t.runtime === (entry.runtime === 'codex' ? 'codex' : 'claude'),
  );

  return (
    <div className="cold-item">
      <div className="cold-item__header">
        <div className="cold-item__badges">
          <span className={`kv2-badge cold-item__kind-badge cold-item__kind-badge--${entry.kind}`}>
            {entry.kind === 'skill' ? '❄ skill' : '❄ MCP'}
          </span>
          {entry.runtime && (
            <span className={`kv2-badge cap-badge--${entry.runtime}`}>{entry.runtime}</span>
          )}
          <span className="kv2-badge cold-item__scope-badge">{entry.sourceScope}</span>
        </div>
        <span className="cold-item__ref">{entry.ref}</span>
        <span className="cold-item__age">{timeAgo(entry.createdAt)}</span>
      </div>

      <div className="cold-item__actions">
        <select
          className="kv2-select cold-item__select"
          value={restoreTarget}
          onChange={(e) => { setRestoreTarget(e.target.value); setRestoreChanges(null); setError(null); }}
        >
          <option value="">— restore to... —</option>
          {entry.kind === 'skill'
            ? skillTargets.map((r) => (
                <option key={r.id} value={r.id}>
                  [{r.agent}] {r.dir}
                </option>
              ))
            : mcpTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  [{t.kind}] {t.label}
                </option>
              ))}
        </select>
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-btn--small"
          disabled={!restoreTarget || restoring}
          onClick={() => void handleRestore()}
        >
          {restoring ? '…' : entry.kind === 'mcp' && restoreChanges ? 'Apply' : entry.kind === 'mcp' ? 'Preview' : 'Restore'}
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </div>

      {error && <p className="cap-roots-error cold-item__error">{error}</p>}
      {restoreChanges && (
        <DiffPreview
          changes={restoreChanges}
          applying={restoring}
          error={error}
          onApply={() => void handleRestore()}
          onCancel={() => setRestoreChanges(null)}
        />
      )}
    </div>
  );
}

export function StorageDrawer({ skillRoots, placementTargets, onRefresh }: StorageDrawerProps) {
  const cold = useColdStorage(true);

  const handleRestored = async () => {
    await cold.refresh();
    await onRefresh();
  };

  const handleDeleted = async () => {
    await cold.refresh();
  };

  const skillEntries = cold.entries.filter((e) => e.kind === 'skill');
  const mcpEntries = cold.entries.filter((e) => e.kind === 'mcp');

  if (cold.loading && cold.entries.length === 0) {
    return (
      <div className="scripts-loading">
                <p>Loading cold storage...</p>
      </div>
    );
  }

  if (cold.error) {
    return (
      <div className="cap-empty">
        <p>⚠ {cold.error}</p>
      </div>
    );
  }

  if (cold.entries.length === 0) {
    return (
      <div className="cold-drawer">
        <StorageIntroduction />
        <div className="cap-empty cold-empty">
          <p className="cold-empty__icon" aria-hidden="true">❄</p>
          <p className="cold-empty__title">아직 보관된 항목이 없습니다</p>
          <p className="cold-empty__hint">
            Inventory에서 <strong>Freeze to storage</strong>를 누르면 skill이나 MCP를
            삭제하지 않고 이곳에 보관할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="cold-drawer">
      <StorageIntroduction />

      {skillEntries.length > 0 && (
        <section className="cold-section">
          <div className="cold-section__label">
            Skills
            <span className="kv2-badge cold-section__count">{skillEntries.length}</span>
          </div>
          <div className="cold-section__list">
            {skillEntries.map((entry) => (
              <EntryCard
                key={entry.ref}
                entry={entry}
                skillRoots={skillRoots}
                placementTargets={placementTargets}
                onRestored={handleRestored}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        </section>
      )}

      {mcpEntries.length > 0 && (
        <section className="cold-section">
          <div className="cold-section__label">
            MCP Servers
            <span className="kv2-badge cold-section__count">{mcpEntries.length}</span>
          </div>
          <div className="cold-section__list">
            {mcpEntries.map((entry) => (
              <EntryCard
                key={entry.ref}
                entry={entry}
                skillRoots={skillRoots}
                placementTargets={placementTargets}
                onRestored={handleRestored}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StorageIntroduction() {
  return (
    <section className="cold-intro" aria-labelledby="cold-intro-title">
      <div className="cold-intro__heading">
        <span className="cold-intro__icon" aria-hidden="true">❄</span>
        <div>
          <h2 id="cold-intro-title">Cold Storage</h2>
          <p>지금은 쓰지 않지만 나중에 다시 필요할 capability를 보관하는 곳입니다.</p>
        </div>
      </div>
      <div className="cold-intro__steps" aria-label="Cold Storage 동작 방식">
        <div className="cold-intro__step">
          <strong>1. Freeze</strong>
          <span>agent 설정에서 분리</span>
        </div>
        <span className="cold-intro__arrow" aria-hidden="true">→</span>
        <div className="cold-intro__step">
          <strong>2. Keep</strong>
          <span>파일과 설정을 안전하게 보관</span>
        </div>
        <span className="cold-intro__arrow" aria-hidden="true">→</span>
        <div className="cold-intro__step">
          <strong>3. Restore</strong>
          <span>원하는 위치로 다시 활성화</span>
        </div>
      </div>
      <p className="cold-intro__warning">
        Freeze는 삭제가 아닙니다. <strong>Delete만 영구 삭제</strong>이며 되돌릴 수 없습니다.
      </p>
    </section>
  );
}
