import { useState } from 'react';
import type { SkillRoot, SkillRuntime } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { RuntimeBadge } from '../Board/BoardCardSections';

const DEFAULT_SIZE = { width: 680, height: 540 };

interface SkillRootsModalProps {
  roots: SkillRoot[];
  loading: boolean;
  onClose: () => void;
  onAdd: (input: Omit<SkillRoot, 'id'>) => Promise<SkillRoot>;
  onUpdate: (id: string, patch: Partial<Omit<SkillRoot, 'id'>>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

const AGENT_OPTIONS: SkillRuntime[] = ['claude', 'codex', 'opencode'];

export function SkillRootsModal({
  roots,
  loading,
  onClose,
  onAdd,
  onUpdate,
  onRemove,
}: SkillRootsModalProps) {
  const [newDir, setNewDir] = useState('');
  const [newAgent, setNewAgent] = useState<SkillRuntime>('claude');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    const dir = newDir.trim();
    if (!dir) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd({ dir, agent: newAgent, source: `${newAgent}-custom`, enabled: true });
      setNewDir('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add directory');
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (root: SkillRoot) => {
    setError(null);
    try {
      await onUpdate(root.id, { enabled: !root.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm('Remove this skill directory? Skills from this path will be evicted.')) {
      return;
    }
    setRemovingId(id);
    setError(null);
    try {
      await onRemove(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <DialogSkeleton
      title="Skill Directories"
      onClose={onClose}
      persistSizeKey="cap-skill-roots-size"
      defaultSize={DEFAULT_SIZE}
    >
      {error && <p className="cap-roots-error">{error}</p>}

      <div className="cap-roots-list">
        {loading && roots.length === 0 && (
          <p className="cap-roots-empty">Loading...</p>
        )}
        {!loading && roots.length === 0 && (
          <p className="cap-roots-empty">No directories configured.</p>
        )}
        {roots.map((root) => (
          <div key={root.id} className="cap-root-item">
            <RuntimeBadge runtime={root.agent} />
            <span className="cap-root-dir" title={root.dir}>
              {root.dir}
            </span>
            <label className="cap-root-toggle">
              <input
                type="checkbox"
                checked={root.enabled}
                onChange={() => void handleToggle(root)}
              />
              {root.enabled ? 'On' : 'Off'}
            </label>
            <button
              type="button"
              className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
              onClick={() => void handleRemove(root.id)}
              disabled={removingId === root.id}
              aria-label={`Remove ${root.dir}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="cap-roots-add">
        <p className="cap-roots-add-title">Add Directory</p>
        <div className="cap-roots-add-row">
          <input
            type="text"
            className="kv2-input"
            placeholder="~/.custom/skills"
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
            style={{ flex: 1 }}
          />
          <select
            className="kv2-select"
            value={newAgent}
            onChange={(e) => setNewAgent(e.target.value as SkillRuntime)}
            style={{ width: 'auto' }}
          >
            {AGENT_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            onClick={() => void handleAdd()}
            disabled={adding || !newDir.trim()}
          >
            {adding ? 'Adding...' : '+ Add'}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
}
