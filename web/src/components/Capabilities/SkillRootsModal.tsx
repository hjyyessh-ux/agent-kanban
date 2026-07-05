import { useEffect, useRef, useState } from 'react';
import type { SkillRoot, SkillRuntime } from '../../../../src/core/types';
import { usePersistedDialogSize } from '../../hooks/usePersistedDialogSize';

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
  // True only when a press *starts* on the backdrop itself. Prevents a drag that
  // starts inside the modal (resize handle, text selection) and releases on the
  // overlay from firing the overlay's click → onClose.
  const pressedOnOverlay = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);

  usePersistedDialogSize('cap-skill-roots-size', modalRef, DEFAULT_SIZE);

  // Close on Escape, matching New/Import/Detail modals (consistency fix).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

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
    <div
      className="cap-roots-overlay"
      onMouseDown={(e) => { pressedOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnOverlay.current) onClose();
        pressedOnOverlay.current = false;
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Skill Directories"
    >
      <div
        className="cap-roots-modal cap-roots-modal--resizable"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cap-roots-header">
          <h2 className="cap-roots-title">Skill Directories</h2>
          <button
            type="button"
            className="scripts-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

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
              <span className={`neo-badge cap-badge--${root.agent}`}>{root.agent}</span>
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
                className="neo-button neo-button--danger neo-button--sm"
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
              className="neo-input"
              placeholder="~/.custom/skills"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd();
              }}
              style={{ flex: 1 }}
            />
            <select
              className="neo-input"
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
              className="neo-button"
              onClick={() => void handleAdd()}
              disabled={adding || !newDir.trim()}
            >
              {adding ? 'Adding...' : '+ Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
