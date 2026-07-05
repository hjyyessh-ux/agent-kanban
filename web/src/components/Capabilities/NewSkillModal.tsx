import { useEffect, useRef, useState } from 'react';
import type { SkillRoot, SkillRuntime } from '../../../../src/core/types';
import { createSkill } from '../../hooks/useSkillsApi';

const DEFAULT_INSTRUCTIONS = `# skill-name

## What it does

Describe the skill's purpose.

## When to use it

Describe the trigger conditions.

## Instructions

Step-by-step instructions for the agent.
`;

interface NewSkillModalProps {
  skillRoots: SkillRoot[];
  defaultAgent?: SkillRuntime;
  onClose: () => void;
  onCreated: () => void;
}

export function NewSkillModal({ skillRoots, defaultAgent, onClose, onCreated }: NewSkillModalProps) {
  const enabledRoots = skillRoots.filter((r) => r.enabled);
  const defaultRoot = enabledRoots.find((r) => r.agent === defaultAgent) ?? enabledRoots[0];

  const [name, setName] = useState('');
  const [targetRootId, setTargetRootId] = useState(defaultRoot?.id ?? '');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const validateName = (v: string) => {
    if (!v) return 'Name is required';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return 'Only lowercase letters, digits, hyphens. Must start with a letter or digit.';
    return null;
  };

  const handleNameChange = (v: string) => {
    setName(v);
    setNameError(validateName(v));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const err = validateName(name);
    if (err) { setNameError(err); return; }
    if (!targetRootId) { setError('Select a target directory'); return; }
    setSaving(true);
    setError(null);
    try {
      await createSkill({ name, targetRootId, description, instructions });
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="cap-roots-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="New Skill"
    >
      <div className="cap-roots-modal cap-new-skill-modal">
        <div className="cap-roots-header">
          <h2 className="cap-roots-title">New Skill</h2>
          <button type="button" className="neo-button neo-button--ghost neo-button--sm" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="cap-new-skill-form">
          {/* Name */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="skill-name">
              Name <span className="cap-field-hint">[a-z0-9-]</span>
            </label>
            <input
              id="skill-name"
              ref={nameRef}
              type="text"
              className={`neo-input${nameError ? ' neo-input--error' : ''}`}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="my-skill"
              autoComplete="off"
              spellCheck={false}
            />
            {nameError && <p className="cap-field-error">{nameError}</p>}
          </div>

          {/* Target root */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="skill-root">Target directory</label>
            {enabledRoots.length === 0 ? (
              <p className="cap-roots-error">No enabled skill directories. Add one via the ⚙ button.</p>
            ) : (
              <select
                id="skill-root"
                className="neo-input"
                value={targetRootId}
                onChange={(e) => setTargetRootId(e.target.value)}
              >
                {enabledRoots.map((r) => (
                  <option key={r.id} value={r.id}>
                    [{r.agent}] {r.dir}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Description */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="skill-desc">Description</label>
            <input
              id="skill-desc"
              type="text"
              className="neo-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary of what this skill does"
            />
          </div>

          {/* Instructions */}
          <div className="cap-field cap-field--grow">
            <label className="cap-field-label" htmlFor="skill-instructions">
              SKILL.md content
            </label>
            <textarea
              id="skill-instructions"
              className="neo-input cap-detail-textarea cap-new-skill-body"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              spellCheck={false}
            />
          </div>

          {error && <p className="cap-roots-error">{error}</p>}

          <div className="cap-new-skill-footer">
            <button type="button" className="neo-button neo-button--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="neo-button"
              disabled={saving || enabledRoots.length === 0 || Boolean(nameError)}
            >
              {saving ? 'Creating...' : 'Create Skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
