import { useState } from 'react';
import type { ColdManifestEntry, PlacementTarget, SkillRoot } from '../../../../src/core/types';
import {
  restoreSkillColdApi,
  restoreMcpColdApi,
  previewRestoreMcpColdApi,
  deleteColdApi,
  type VisibilityChange,
} from '../../hooks/useScopeInventory';
import { DiffPreview } from './DiffPreview';

interface ColdEntryActionsProps {
  entry: ColdManifestEntry;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onRestored: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

/**
 * Restore-to-target + permanent-delete controls for one cold storage entry.
 * Shared by the list row and the detail dialog so both stay in sync.
 */
export function ColdEntryActions({
  entry,
  skillRoots,
  placementTargets,
  onRestored,
  onDeleted,
}: ColdEntryActionsProps) {
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
    <>
      <div className="cold-item__actions">
        <select
          className="kv2-select cold-item__select"
          aria-label="Restore target"
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
    </>
  );
}
