import React, { useState } from 'react';
import type { CreateScriptInput, UpdateScriptInput, ScriptEntry } from '../../../../src/core/types';
import './Scripts.css';
import { DialogSkeleton } from '../Card/DialogSkeleton';

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
    <DialogSkeleton
      title={editEntry ? 'Edit Script' : 'Create Script'}
      onClose={onClose}
      persistSizeKey="kanban-scripts-modal-size"
      defaultSize={{ width: 800, height: 600 }}
      className="kv2-dialog--form"
    >
      <form onSubmit={handleSubmit} className="scripts-modal-form">
        <div className="scripts-modal-body">
          <div className="scripts-modal-grid">
            <div className="scripts-field">
              <label className="kv2-label" htmlFor="script-name-input">Name *</label>
              <input
                id="script-name-input"
                className="kv2-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Deploy to Production"
                disabled={isSubmitting}
              />
            </div>

            <div className="scripts-field">
              <label className="kv2-label" htmlFor="script-language-select">Language</label>
              <select
                id="script-language-select"
                className="kv2-select"
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
              <label className="kv2-label" htmlFor="script-description-input">Description</label>
              <input
                id="script-description-input"
                className="kv2-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this script do?"
                disabled={isSubmitting}
              />
            </div>

            <div className="scripts-field">
              <label className="kv2-label" htmlFor="script-project-dir-input">Project Directory (Optional)</label>
              <input
                id="script-project-dir-input"
                className="kv2-input"
                value={projectDir}
                onChange={(e) => setProjectDir(e.target.value)}
                placeholder="/path/to/project"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div className="scripts-field scripts-field--expand">
            <label className="kv2-label" htmlFor="script-content-input">Script Content *</label>
            <textarea
              id="script-content-input"
              className="kv2-textarea scripts-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="#!/bin/bash\necho 'Hello World'"
              disabled={isSubmitting}
            />
          </div>
        </div>

        <div className="kv2-dialog-actions scripts-modal-actions">
          <button
            type="button"
            className="kv2-btn kv2-btn--outline scripts-modal-btn"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="kv2-btn kv2-btn--primary scripts-modal-btn"
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? 'Saving...' : editEntry ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </DialogSkeleton>
  );
}
