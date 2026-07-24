import React, { useEffect, useMemo, useState } from 'react';
import { formatUtcIsoToKstInput } from '../../../../src/core/scheduling';
import type { KanbanCard } from '../../../../src/core/types';
import { DialogSkeleton } from './DialogSkeleton';
import {
  buildDefaultScheduleInput,
  ScheduledDispatchEditor,
  validateScheduleInputKst,
} from '../shared/ScheduledDispatchUi';

interface ScheduleCardDialogProps {
  card: KanbanCard;
  onClose: () => void;
  onSave: (scheduledAt: string) => Promise<void>;
}

export const ScheduleCardDialog: React.FC<ScheduleCardDialogProps> = ({
  card,
  onClose,
  onSave,
}) => {
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
  }, [card.id, card.scheduledDispatch?.scheduledAt]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const validation = useMemo(
    () => validateScheduleInputKst(scheduledAtInput, currentNow),
    [scheduledAtInput, currentNow],
  );

  return (
    <DialogSkeleton
      title={card.scheduledDispatch?.status === 'scheduled' ? 'Reschedule Task' : 'Schedule Task'}
      onClose={onClose}
      width="480px"
      className="kv2-dialog--schedule"
    >
      <div className="kv2-schedule-dialog">
        <ScheduledDispatchEditor
          currentNow={currentNow}
          inputId="schedule-card-datetime"
          value={scheduledAtInput}
          onChange={setScheduledAtInput}
        />

        <div className="kv2-dialog-actions kv2-dialog-actions--compact">
          <button type="button" className="kv2-btn kv2-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            disabled={isSaving || !validation.scheduledAtUtc}
            onClick={() => {
              if (!validation.scheduledAtUtc || isSaving) return;
              setIsSaving(true);
              void onSave(scheduledAtInput).finally(() => setIsSaving(false));
            }}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
};
