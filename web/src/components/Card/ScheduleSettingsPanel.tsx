import React, { useEffect, useMemo, useState } from 'react';
import { formatUtcIsoToKstInput } from '../../../../src/core/scheduling';
import type { KanbanCard } from '../../../../src/core/types';
import {
  buildDefaultScheduleInput,
  formatScheduledKstLabel,
  getScheduledStatusLabel,
  ScheduledDispatchEditor,
  validateScheduleInputKst,
} from '../shared/ScheduledDispatchUi';

interface ScheduleSettingsPanelProps {
  card: KanbanCard;
  disabledReason?: string;
  onSave?: (cardId: string, scheduledAt: string) => Promise<KanbanCard>;
  onCancelSchedule?: (cardId: string) => Promise<KanbanCard> | void;
}

export const ScheduleSettingsPanel: React.FC<ScheduleSettingsPanelProps> = ({
  card,
  disabledReason,
  onSave,
  onCancelSchedule,
}) => {
  const activeReservation = card.scheduledDispatch?.status === 'scheduled'
    || card.scheduledDispatch?.status === 'dispatching';
  const canEdit = card.status === 'todo' && Boolean(onSave);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scheduledAtInput, setScheduledAtInput] = useState(() => (
    card.scheduledDispatch
      ? formatUtcIsoToKstInput(card.scheduledDispatch.scheduledAt)
      : buildDefaultScheduleInput(new Date())
  ));
  const [currentNow, setCurrentNow] = useState(() => new Date());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setScheduledAtInput(
      card.scheduledDispatch
        ? formatUtcIsoToKstInput(card.scheduledDispatch.scheduledAt)
        : buildDefaultScheduleInput(new Date()),
    );
    setEditing(false);
  }, [card.id, card.scheduledDispatch?.scheduledAt, card.scheduledDispatch?.status]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const validation = useMemo(
    () => validateScheduleInputKst(scheduledAtInput, currentNow),
    [currentNow, scheduledAtInput],
  );
  const showBody = expanded || Boolean(card.scheduledDispatch);
  const showEditor = canEdit && showBody && (!card.scheduledDispatch || editing);
  const scheduledAtLabel = card.scheduledDispatch?.scheduledAt
    ? formatScheduledKstLabel(card.scheduledDispatch.scheduledAt)
    : null;
  const dispatchedAtLabel = card.scheduledDispatch?.dispatchedAt
    ? formatScheduledKstLabel(card.scheduledDispatch.dispatchedAt)
    : null;

  const resetEditor = () => {
    setScheduledAtInput(
      card.scheduledDispatch
        ? formatUtcIsoToKstInput(card.scheduledDispatch.scheduledAt)
        : buildDefaultScheduleInput(new Date()),
    );
    setEditing(false);
    if (!card.scheduledDispatch) setExpanded(false);
  };

  return (
    <div className="kv2-queue-panel kv2-schedule-panel">
      <div className="kv2-panel-heading">
        <button
          type="button"
          className="kv2-session-title kv2-panel-toggle"
          aria-expanded={showBody}
          onClick={() => setExpanded((current) => !current)}
        >
          Scheduled Dispatch
          <span className="kv2-chevron" style={{ transform: showBody ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
        </button>
      </div>
      <div className="kv2-session-helper">KST 기준으로 한 번만 자동 dispatch됩니다.</div>
      {disabledReason && (
        <div className="kv2-session-helper kv2-session-helper--warn" role="note">{disabledReason}</div>
      )}

      {showBody && card.scheduledDispatch && (
        <div className="kv2-queue-summary-card">
          <div className="kv2-queue-summary-row">
            <span className="kv2-queue-target-label">Status:</span>
            <strong>{getScheduledStatusLabel(card.scheduledDispatch.status)}</strong>
          </div>
          {scheduledAtLabel && (
            <div className="kv2-queue-summary-row">
              <span className="kv2-queue-target-label">Scheduled:</span>
              <strong>{scheduledAtLabel}</strong>
            </div>
          )}
          {dispatchedAtLabel && (
            <div className="kv2-queue-summary-row">
              <span className="kv2-queue-target-label">Dispatched:</span>
              <strong>{dispatchedAtLabel}</strong>
            </div>
          )}
          {card.scheduledDispatch.error && (
            <div className="kv2-session-helper kv2-session-helper--warn" role="note">
              실패 원인: {card.scheduledDispatch.error}
            </div>
          )}
          {activeReservation && (
            <div className="kv2-session-helper" role="note">
              Start Now는 이 예약을 소비하고 즉시 한 번만 실행합니다.
            </div>
          )}
          {canEdit && !editing && (
            <div className="kv2-schedule-panel-actions kv2-actions-split">
              {activeReservation && onCancelSchedule && (
                <button
                  type="button"
                  className="kv2-btn kv2-btn--subtle-danger kv2-action-cancel"
                  onClick={() => {
                    void Promise.resolve(onCancelSchedule(card.id)).catch(() => undefined);
                  }}
                >
                  Cancel schedule
                </button>
              )}
              <button
                type="button"
                className="kv2-btn kv2-btn--outline"
                onClick={() => setEditing(true)}
                disabled={Boolean(disabledReason)}
              >
                {activeReservation ? 'Reschedule' : 'Schedule again'}
              </button>
            </div>
          )}
        </div>
      )}

      {showEditor && (
        <div className="kv2-session-config-card kv2-schedule-inline-editor">
          <ScheduledDispatchEditor
            currentNow={currentNow}
            inputId={`schedule-card-datetime-${card.id}`}
            value={scheduledAtInput}
            onChange={setScheduledAtInput}
            disabled={isSaving || Boolean(disabledReason)}
          />
          <div className="kv2-schedule-panel-actions kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--ghost kv2-action-cancel" onClick={resetEditor} disabled={isSaving}>
              Cancel
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--primary"
              disabled={isSaving || Boolean(disabledReason) || !validation.scheduledAtUtc}
              onClick={() => {
                if (!onSave || !validation.scheduledAtUtc || isSaving) return;
                setIsSaving(true);
                void onSave(card.id, scheduledAtInput)
                  .then(() => setEditing(false))
                  .catch(() => undefined)
                  .finally(() => setIsSaving(false));
              }}
            >
              {isSaving ? 'Saving...' : activeReservation ? 'Save new time' : 'Schedule'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
