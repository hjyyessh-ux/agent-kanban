import { useState } from 'react';
import type { ColdManifestEntry } from '../../hooks/useScopeInventory';
import type { SkillRoot, PlacementTarget } from '../../../../src/core/types';
import {
  useColdStorage,
  restoreSkillColdApi,
  restoreMcpColdApi,
  deleteColdApi,
} from '../../hooks/useScopeInventory';

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
        await restoreMcpColdApi(
          entry.ref,
          target.kind === 'project' ? 'project' : target.kind === 'local' ? 'local' : 'user',
          target.kind === 'local' ? target.dir : undefined,
          target.kind === 'project' ? target.dir : undefined,
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
    (t) => t.kind === 'user' || t.kind === 'local' || t.kind === 'project',
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
          onChange={(e) => { setRestoreTarget(e.target.value); setError(null); }}
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
          {restoring ? '…' : 'Restore'}
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
      <div className="cap-empty cold-empty">
        <p className="cold-empty__icon">❄</p>
        <p>Cold Storage is empty.</p>
        <p className="cold-empty__hint">
          Freeze a skill or MCP from the Inventory view to remove it from the active context.
        </p>
      </div>
    );
  }

  return (
    <div className="cold-drawer">
      <div className="cold-drawer__hint">
        <p>
          Frozen items are removed from the agent context (agents cannot read them). Restore to
          bring them back. Delete is permanent.
        </p>
      </div>

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
