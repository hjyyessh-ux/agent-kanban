import React, { useState, useCallback } from 'react';
import type {
  CreateSettingsInput,
  UpdateSettingsInput,
  SettingsEntry,
} from '../../../../src/core/types';
import './Settings.css';
import { DialogSkeleton } from '../Card/DialogSkeleton';
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
  const [key, setKey] = useState(editEntry?.key ?? '');
  const [value, setValue] = useState(editEntry?.value ?? '');
  const [description, setDescription] = useState(editEntry?.description ?? '');
  const [category, setCategory] = useState(editEntry?.category ?? '');
  const [masked, setMasked] = useState(editEntry?.masked ?? true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);

  const isEditing = !!editEntry;

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
    <DialogSkeleton
      title={isEditing ? 'Edit Setting' : 'New Setting'}
      onClose={onClose}
      persistSizeKey="kanban-settings-modal-size"
      defaultSize={{ width: 560, height: 480 }}
      className="kv2-dialog--form"
    >
      <div className="settings-modal-body">
        {submitError && (
          <ErrorAlert
            variant="inline"
            title={submitError.title}
            message={submitError.message}
            onDismiss={() => setSubmitError(null)}
          />
        )}

        {/* Key */}
        <div className="settings-field">
          <label className="kv2-label" htmlFor="settings-key-input">Key *</label>
          <span className="settings-hint">
            Environment variable name (e.g., GOOGLE_AUTH_TOKEN)
          </span>
          <input
            id="settings-key-input"
            className="kv2-input"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="e.g., GOOGLE_AUTH_TOKEN"
            disabled={isSubmitting}
          />
        </div>

        {/* Value */}
        <div className="settings-field">
          <label className="kv2-label" htmlFor="settings-value-input">
            Value {isEditing ? '' : '*'}
          </label>
          {isEditing && (
            <span className="settings-hint">
              Leave blank to keep the current value
            </span>
          )}
          <textarea
            id="settings-value-input"
            className="kv2-textarea"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={isEditing ? 'Enter a new value to replace it' : 'Secret value'}
            rows={3}
            disabled={isSubmitting}
          />
        </div>

        {/* Description */}
        <div className="settings-field">
          <label className="kv2-label" htmlFor="settings-description-input">Description *</label>
          <input
            id="settings-description-input"
            className="kv2-input"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g., Google API authentication token"
            disabled={isSubmitting}
          />
        </div>

        {/* Category */}
        <div className="settings-field">
          <label className="kv2-label" htmlFor="settings-category-input">Category (Optional)</label>
          <input
            id="settings-category-input"
            className="kv2-input"
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
      </div>

      {/* Actions */}
      <div className="kv2-dialog-actions settings-modal-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--outline settings-modal-btn"
          onClick={onClose}
          disabled={isSubmitting}
        >
          CANCEL
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary settings-modal-btn"
          onClick={handleSubmit}
          disabled={isSubmitting || !canSubmit()}
        >
          {isEditing ? 'UPDATE' : 'CREATE'}
        </button>
      </div>
    </DialogSkeleton>
  );
};
