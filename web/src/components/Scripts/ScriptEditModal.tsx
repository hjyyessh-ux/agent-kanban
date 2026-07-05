import React, { useState, useRef } from 'react';
import type { CreateScriptInput, UpdateScriptInput, ScriptEntry } from '../../../../src/core/types';
import '../../styles/components.css';
import './Scripts.css';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';
import { usePersistedDialogSize } from '../../hooks/usePersistedDialogSize';

interface ScriptEditModalProps {
  onClose: () => void;
  onSave: (input: CreateScriptInput) => Promise<void>;
  onUpdate?: (id: string, input: UpdateScriptInput) => Promise<void>;
  editEntry?: ScriptEntry;
}

export function ScriptEditModal({ onClose, onSave, onUpdate, editEntry }: ScriptEditModalProps) {
  const [name, setName] = useState(editEntry?.name || '');
  const [description, setDescription] = useState(editEntry?.description || '');
  const [language, setLanguage] = useState(editEntry?.language || 'bash');
  const [content, setContent] = useState(editEntry?.content || '');
  const [projectDir, setProjectDir] = useState(editEntry?.projectDir || '');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useModalAccessibility(true, modalRef, onClose);
  usePersistedDialogSize('kanban-scripts-modal-size', modalRef, { width: 800, height: 600 });


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;

    try {
      setIsSubmitting(true);
      const input: CreateScriptInput = {
        name,
        description,
        language,
        content,
        projectDir: projectDir || undefined
      };

      if (editEntry && onUpdate) {
        await onUpdate(editEntry.id, input);
      } else {
        await onSave(input);
      }
      onClose();
    } catch (err) {
      console.error('Failed to save script:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = name.trim().length > 0 && content.trim().length > 0;

  return (
    <div
      className="scripts-modal-overlay"
      ref={overlayRef}
      onPointerDown={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        ref={modalRef}
        className="scripts-modal neo-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-modal-title"
        tabIndex={-1}
      >
        <div className="scripts-modal-header">
          <h2 id="script-modal-title" className="scripts-modal-title">
            {editEntry ? 'Edit Script' : 'Create Script'}
          </h2>
          <button className="scripts-modal-close neo-button neo-button--sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="scripts-modal-form">
          <div className="scripts-modal-body">
            <div className="scripts-modal-grid">
              <div className="scripts-field">
                <label className="scripts-label" htmlFor="script-name-input">Name *</label>
                <input
                  id="script-name-input"
                  ref={firstInputRef}
                  className="neo-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Deploy to Production"
                  disabled={isSubmitting}
                />
              </div>

              <div className="scripts-field">
                <label className="scripts-label" htmlFor="script-language-select">Language</label>
                <select
                  id="script-language-select"
                  className="neo-select"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={isSubmitting}
                >
                  <option value="bash">Bash</option>
                  <option value="sh">Shell</option>
                  <option value="python">Python</option>
                  <option value="node">Node.js</option>
                </select>
              </div>

              <div className="scripts-field">
                <label className="scripts-label" htmlFor="script-description-input">Description</label>
                <input
                  id="script-description-input"
                  className="neo-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this script do?"
                  disabled={isSubmitting}
                />
              </div>

              <div className="scripts-field">
                <label className="scripts-label" htmlFor="script-project-dir-input">Project Directory (Optional)</label>
                <input
                  id="script-project-dir-input"
                  className="neo-input"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="/path/to/project"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            <div className="scripts-field scripts-field--expand">
              <label className="scripts-label" htmlFor="script-content-input">Script Content *</label>
              <textarea
                id="script-content-input"
                className="neo-input scripts-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="#!/bin/bash\necho 'Hello World'"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div className="scripts-modal-actions scripts-modal-actions--sticky">
            <button
              type="button"
              className="neo-button neo-button--secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="neo-button neo-button--primary"
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? 'Saving...' : editEntry ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
