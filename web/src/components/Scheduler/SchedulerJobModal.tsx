import React, { useState, useRef, useEffect, useCallback } from 'react';
import type {
  CreateSchedulerInput,
  UpdateSchedulerInput,
  SchedulerEntry,
  SchedulerActionType,
} from '../../../../src/core/types';
import { parseCron } from '../../hooks/useSchedulerApi';
import type { CronParseResult } from '../../hooks/useSchedulerApi';
import '../../styles/components.css';
import './Scheduler.css';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';
import { usePersistedDialogSize } from '../../hooks/usePersistedDialogSize';
import { ErrorAlert } from '../shared/ErrorAlert';

interface SchedulerJobModalProps {
  onClose: () => void;
  onSave: (input: CreateSchedulerInput) => Promise<void>;
  onUpdate?: (id: string, input: UpdateSchedulerInput) => Promise<void>;
  editEntry?: SchedulerEntry;
}

export const SchedulerJobModal: React.FC<SchedulerJobModalProps> = ({
  onClose,
  onSave,
  onUpdate,
  editEntry,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(editEntry?.name ?? '');
  const [description, setDescription] = useState(editEntry?.description ?? '');
  const [cronInput, setCronInput] = useState(editEntry?.cron ?? '');
  const [cronPreview, setCronPreview] = useState<CronParseResult | null>(null);
  const [actionType, setActionType] = useState<SchedulerActionType>(editEntry?.action.type ?? 'shell');
  const [command, setCommand] = useState(editEntry?.action.command ?? '');
  const [skillName, setSkillName] = useState(editEntry?.action.skillName ?? '');
  const [skillInput, setSkillInput] = useState(editEntry?.action.skillInput ?? '');
  const [timezone, setTimezone] = useState(editEntry?.timezone ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);

  const isEditing = !!editEntry;

  useModalAccessibility(true, modalRef, onClose);
  usePersistedDialogSize('kanban-scheduler-modal-size', modalRef, { width: 640, height: 560 });

  // Debounced cron parsing
  useEffect(() => {
    if (!cronInput.trim()) {
      setCronPreview(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const result = await parseCron(cronInput.trim());
        setCronPreview(result);
      } catch {
        setCronPreview({ valid: false, error: 'Failed to parse' });
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [cronInput]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  const canSubmit = useCallback(() => {
    if (!name.trim()) return false;
    if (!cronInput.trim()) return false;
    if (cronPreview && !cronPreview.valid) return false;
    if (actionType === 'shell' && !command.trim()) return false;
    if (actionType === 'skill' && !skillName.trim()) return false;
    return true;
  }, [name, cronInput, cronPreview, actionType, command, skillName]);

  const handleSubmit = async () => {
    if (!canSubmit() || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const cronValue = cronPreview && cronPreview.valid ? cronPreview.cron : cronInput.trim();
      const cronDesc = cronPreview && cronPreview.valid ? cronPreview.description : undefined;

      if (isEditing && onUpdate && editEntry) {
        const updates: UpdateSchedulerInput = {
          name: name.trim(),
          description: description.trim(),
          cron: cronValue,
          cronDescription: cronDesc,
          timezone: timezone.trim() || undefined,
          action: {
            type: actionType,
            ...(actionType === 'shell' ? { command: command.trim() } : {}),
            ...(actionType === 'skill' ? { skillName: skillName.trim(), skillInput: skillInput.trim() || undefined } : {}),
          },
        };
        await onUpdate(editEntry.id, updates);
      } else {
        const input: CreateSchedulerInput = {
          name: name.trim(),
          description: description.trim(),
          cron: cronValue,
          cronDescription: cronDesc,
          timezone: timezone.trim() || undefined,
          action: {
            type: actionType,
            ...(actionType === 'shell' ? { command: command.trim() } : {}),
            ...(actionType === 'skill' ? { skillName: skillName.trim(), skillInput: skillInput.trim() || undefined } : {}),
          },
        };
        await onSave(input);
      }
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'The scheduler could not be saved.';
      setSubmitError({
        title: isEditing ? 'Scheduler update failed' : 'Scheduler creation failed',
        message,
      });
      setIsSubmitting(false);
    }
  };

  return (
    <div className="scheduler-modal-overlay" ref={overlayRef}>
      <div
        ref={modalRef}
        className="scheduler-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduler-modal-title"
        tabIndex={-1}
      >
        <div className="scheduler-modal-header">
          <h2 id="scheduler-modal-title" className="scheduler-modal-title">
            {isEditing ? 'Edit Scheduler' : 'New Scheduler'}
          </h2>
          <button
            type="button"
            className="scheduler-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="scheduler-modal-body">
          {submitError && (
            <ErrorAlert
              variant="inline"
              title={submitError.title}
              message={submitError.message}
              onDismiss={() => setSubmitError(null)}
            />
          )}

          <div className="scheduler-modal-grid">
            <div className="scheduler-field">
              <label className="scheduler-label" htmlFor="scheduler-name-input">Name *</label>
              <input
                id="scheduler-name-input"
                ref={firstInputRef}
                className="neo-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g., Health Check"
                disabled={isSubmitting}
              />
            </div>

            <div className="scheduler-field">
              <label className="scheduler-label" htmlFor="scheduler-description-input">Description</label>
              <input
                id="scheduler-description-input"
                className="neo-input"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g., Check server health every 5 minutes"
                disabled={isSubmitting}
              />
            </div>

            <div className="scheduler-field">
              <label className="scheduler-label" htmlFor="scheduler-cron-input">Schedule *</label>
              <span className="scheduler-hint">
                Cron expression (e.g., */5 * * * *) or natural language (e.g., "every 5 minutes", "매 5분마다")
              </span>
              <input
                id="scheduler-cron-input"
                className="neo-input"
                value={cronInput}
                onChange={e => setCronInput(e.target.value)}
                placeholder="*/5 * * * *  or  every 5 minutes"
                disabled={isSubmitting}
              />
              <div className={`scheduler-cron-preview ${
                !cronInput.trim()
                  ? 'scheduler-cron-preview--empty'
                  : cronPreview && cronPreview.valid
                    ? 'scheduler-cron-preview--valid'
                    : cronPreview && !cronPreview.valid
                      ? 'scheduler-cron-preview--invalid'
                      : 'scheduler-cron-preview--empty'
              }`}>
                {!cronInput.trim()
                  ? 'Enter a cron expression or natural language schedule'
                  : cronPreview && cronPreview.valid
                    ? `✓ ${cronPreview.cron} — ${cronPreview.description}`
                    : cronPreview && !cronPreview.valid
                      ? `✕ ${cronPreview.error}`
                      : 'Parsing...'
                }
              </div>
            </div>

            <div className="scheduler-field">
              <label className="scheduler-label" htmlFor="scheduler-timezone-input">Timezone (Optional)</label>
              <input
                id="scheduler-timezone-input"
                className="neo-input"
                value={timezone}
                onChange={e => setTimezone(e.target.value)}
                placeholder="e.g., Asia/Seoul (default: system)"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div className="scheduler-field">
            <div className="scheduler-label">Action Type *</div>
            <div
              className="scheduler-action-type"
              role="radiogroup"
              aria-label="Action type"
            >
              <button
                type="button"
                className={`scheduler-action-type-btn ${actionType === 'shell' ? 'scheduler-action-type-btn--active' : ''}`}
                onClick={() => setActionType('shell')}
                disabled={isSubmitting}
                role="radio"
                aria-checked={actionType === 'shell'}
              >
                🖥 Shell Command
              </button>
              <button
                type="button"
                className={`scheduler-action-type-btn ${actionType === 'skill' ? 'scheduler-action-type-btn--active' : ''}`}
                onClick={() => setActionType('skill')}
                disabled={isSubmitting}
                role="radio"
                aria-checked={actionType === 'skill'}
              >
                🧩 Skill
              </button>
            </div>
          </div>

          {actionType === 'shell' && (
            <div className="scheduler-field scheduler-field--expand">
              <label className="scheduler-label" htmlFor="scheduler-command-input">Shell Command *</label>
              <textarea
                id="scheduler-command-input"
                className="neo-input scheduler-textarea scheduler-textarea--command"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="e.g., curl -s https://example.com/health"
                disabled={isSubmitting}
              />
            </div>
          )}

          {actionType === 'skill' && (
            <>
              <div className="scheduler-skill-warning">
                ⚠ Skill execution consumes LLM tokens. Shell commands are recommended instead.
              </div>
              <div className="scheduler-modal-grid">
                <div className="scheduler-field">
                  <label className="scheduler-label" htmlFor="scheduler-skill-name-input">Skill Name *</label>
                  <input
                    id="scheduler-skill-name-input"
                    className="neo-input"
                    value={skillName}
                    onChange={e => setSkillName(e.target.value)}
                    placeholder="e.g., playwright"
                    disabled={isSubmitting}
                  />
                </div>
                <div className="scheduler-field" />
              </div>
              <div className="scheduler-field scheduler-field--expand">
                <label className="scheduler-label" htmlFor="scheduler-skill-input-textarea">Skill Input (JSON, Optional)</label>
                <textarea
                  id="scheduler-skill-input-textarea"
                  className="neo-input scheduler-textarea scheduler-textarea--skill"
                  value={skillInput}
                  onChange={e => setSkillInput(e.target.value)}
                  placeholder='e.g., {"url": "https://example.com"}'
                  disabled={isSubmitting}
                />
              </div>
            </>
          )}
        </div>

        <div className="scheduler-modal-actions scheduler-modal-actions--sticky">
          <button
            type="button"
            className="neo-button scheduler-modal-btn--cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            CANCEL
          </button>
          <button
            type="button"
            className="neo-button scheduler-modal-btn--save"
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
