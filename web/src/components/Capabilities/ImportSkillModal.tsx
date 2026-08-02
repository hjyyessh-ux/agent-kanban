import { useRef, useState } from 'react';
import type { SkillRoot } from '../../../../src/core/types';
import { importSkill } from '../../hooks/useSkillsApi';
import { DialogSkeleton } from '../Card/DialogSkeleton';

interface ImportSkillModalProps {
  skillRoots: SkillRoot[];
  onClose: () => void;
  onImported: () => void;
}

function sanitizeName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'imported-skill';
}

export function ImportSkillModal({ skillRoots, onClose, onImported }: ImportSkillModalProps) {
  const enabledRoots = skillRoots.filter((r) => r.enabled);
  const [targetRootId, setTargetRootId] = useState(enabledRoots[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptFile = (f: File) => {
    setFile(f);
    const derived = sanitizeName(f.name);
    setName(derived);
    setNameError(validateName(derived));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) acceptFile(f);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  };

  const validateName = (v: string) => {
    if (!v) return 'Name is required';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return 'Only lowercase letters, digits, hyphens.';
    return null;
  };

  const handleNameChange = (v: string) => {
    setName(v);
    setNameError(validateName(v));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) { setError('Select a file first'); return; }
    const err = validateName(name);
    if (err) { setNameError(err); return; }
    if (!targetRootId) { setError('Select a target directory'); return; }
    setImporting(true);
    setError(null);
    try {
      await importSkill(file, targetRootId, name);
      onImported();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <DialogSkeleton title="Import Skill" onClose={onClose} width="560px">
        <form onSubmit={(e) => void handleSubmit(e)} className="cap-new-skill-form">
          {/* Drop zone */}
          <div
            className={`cap-dropzone${dragging ? ' cap-dropzone--drag' : ''}${file ? ' cap-dropzone--filled' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            aria-label="Drop a SKILL.md file or click to browse"
          >
            {file ? (
              <span className="cap-dropzone-name">{file.name}</span>
            ) : (
              <>
                <span className="cap-dropzone-icon">📄</span>
                <span>Drop a <code>SKILL.md</code> here or <u>browse</u></span>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
          </div>

          {/* Name */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="import-name">
              Skill name <span className="cap-field-hint">[a-z0-9-]</span>
            </label>
            <input
              id="import-name"
              type="text"
              className={`kv2-input${nameError ? ' kv2-input--error' : ''}`}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="derived from filename"
              autoComplete="off"
              spellCheck={false}
            />
            {nameError && <p className="cap-field-error">{nameError}</p>}
          </div>

          {/* Target root */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="import-root">Target directory</label>
            {enabledRoots.length === 0 ? (
              <p className="cap-roots-error">No enabled skill directories.</p>
            ) : (
              <select
                id="import-root"
                className="kv2-select"
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

          {error && <p className="cap-roots-error">{error}</p>}

          <div className="cap-new-skill-footer kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--ghost kv2-action-cancel" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="kv2-btn kv2-btn--primary"
              disabled={importing || !file || Boolean(nameError) || enabledRoots.length === 0}
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
          </div>
      </form>
    </DialogSkeleton>
  );
}
