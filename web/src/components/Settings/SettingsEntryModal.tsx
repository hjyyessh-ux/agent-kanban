import React, { useState, useRef, useCallback } from 'react';
import type {
  CreateSettingsInput,
  UpdateSettingsInput,
  SettingsEntry,
} from '../../../../src/core/types';
import '../../styles/components.css';
import './Settings.css';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';
import { usePersistedDialogSize } from '../../hooks/usePersistedDialogSize';
import { ErrorAlert } from '../shared/ErrorAlert';

interface SettingsEntryModalProps {
  onClose: () => void;
  onSave: (input: CreateSettingsInput) => Promise<void>;
  onUpdate?: (id: string, input: UpdateSettingsInput) => Promise<void>;
  editEntry?: SettingsEntry;
}

export const SettingsEntryModal: React.FC<SettingsEntryModalProps> = ({
  onClose,
  onSave,
  onUpdate,
  editEntry,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const [key, setKey] = useState(editEntry?.key ?? '');
  const [value, setValue] = useState(editEntry?.value ?? '');
  const [description, setDescription] = useState(editEntry?.description ?? '');
  const [category, setCategory] = useState(editEntry?.category ?? '');
  const [masked, setMasked] = useState(editEntry?.masked ?? true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);

  const isEditing = !!editEntry;

  useModalAccessibility(true, modalRef, onClose);
  usePersistedDialogSize('kanban-settings-modal-size', modalRef, { width: 560, height: 480 });

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  const canSubmit = useCallback(() => {
    if (!key.trim()) return false;
    // On create the value is required; on edit a blank value means "keep the
    // existing (possibly masked) secret unchanged".
    if (!isEditing && !value.trim()) return false;
    if (!description.trim()) return false;
    return true;
  }, [key, value, description, isEditing]);

  const handleSubmit = async () => {
    if (!canSubmit() || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (isEditing && onUpdate && editEntry) {
        const updates: UpdateSettingsInput = {
          key: key.trim(),
          description: description.trim(),
          category: category.trim() || undefined,
          masked,
        };
        // Only send `value` when the user actually entered one; a blank field
        // keeps the existing secret (which is never sent back to the client).
        const trimmedValue = value.trim();
        if (trimmedValue) updates.value = trimmedValue;
        await onUpdate(editEntry.id, updates);
      } else {
        const input: CreateSettingsInput = {
          key: key.trim(),
          value: value.trim(),
          description: description.trim(),
          category: category.trim() || undefined,
          masked,
        };
        await onSave(input);
      }
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'The setting could not be saved.';
      setSubmitError({
        title: isEditing ? 'Setting update failed' : 'Setting creation failed',
        message,
      });
      setIsSubmitting(false);
    }
  };

  return (
    <div className="settings-modal-overlay" ref={overlayRef}>
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
      >
        <div className="settings-modal-header">
          <h2 id="settings-modal-title" className="settings-modal-title">
            {isEditing ? 'Edit Setting' : 'New Setting'}
          </h2>
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {submitError && (
          <div style={{ padding: '0 20px 12px' }}>
            <ErrorAlert
              variant="inline"
              title={submitError.title}
              message={submitError.message}
              onDismiss={() => setSubmitError(null)}
            />
          </div>
        )}

        {/* Key */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-key-input">Key *</label>
          <span className="settings-hint">
            Environment variable name (e.g., GOOGLE_AUTH_TOKEN)
          </span>
          <input
            id="settings-key-input"
            ref={firstInputRef}
            className="neo-input"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="e.g., GOOGLE_AUTH_TOKEN"
            disabled={isSubmitting}
          />
        </div>

        {/* Value */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-value-input">
            Value {isEditing ? '' : '*'}
          </label>
          {isEditing && (
            <span className="settings-hint">
              Leave blank to keep the current value
            </span>
          )}
          <textarea
            id="settings-value-input"
            className="neo-input"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={isEditing ? 'Enter a new value to replace it' : 'Secret value'}
            rows={3}
            disabled={isSubmitting}
          />
        </div>

        {/* Description */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-description-input">Description *</label>
          <input
            id="settings-description-input"
            className="neo-input"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g., Google API authentication token"
            disabled={isSubmitting}
          />
        </div>

        {/* Category */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-category-input">Category (Optional)</label>
          <input
            id="settings-category-input"
            className="neo-input"
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="e.g., api_keys, tokens, credentials"
            disabled={isSubmitting}
          />
        </div>

        {/* Masked Toggle */}
        <div className="settings-field">
          <label className="settings-masked-toggle">
            <input
              type="checkbox"
              className="settings-masked-checkbox"
              checked={masked}
              onChange={e => setMasked(e.target.checked)}
              disabled={isSubmitting}
            />
            Mask value in UI (recommended for secrets)
          </label>
        </div>

        {/* Actions */}
        <div className="settings-modal-actions">
          <button
            type="button"
            className="neo-button"
            style={{ flex: 1, background: 'var(--color-bg)', color: 'var(--color-text)' }}
            onClick={onClose}
            disabled={isSubmitting}
          >
            CANCEL
          </button>
          <button
            type="button"
            className="neo-button"
            style={{ flex: 1 }}
            onClick={handleSubmit}
            disabled={isSubmitting || !canSubmit()}
          >
            {isEditing ? 'UPDATE' : 'CREATE'}
          </button>
        </div>
      </div>
    </div>
  );
};
