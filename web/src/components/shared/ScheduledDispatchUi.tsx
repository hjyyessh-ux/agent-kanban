import React, { useMemo } from 'react';
import { formatUtcIsoToKstInput, validateScheduledAtKstInput } from '../../../../src/core/scheduling';
import type { ScheduledDispatchState, ScheduledDispatchStatus } from '../../../../src/core/types';

const KST_LABEL_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface ScheduleValidationState {
  error: string | null;
  scheduledAtUtc: string | null;
}

export function formatScheduledKstLabel(value: string): string {
  return `${formatUtcIsoToKstInput(value).replace('T', ' ')} KST`;
}

export function formatScheduledPreview(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '유효한 KST 날짜/시간을 입력하세요.';
  }
  return `${KST_LABEL_FORMATTER.format(date)} KST`;
}

export function formatCurrentKstLabel(now: Date): string {
  return formatScheduledKstLabel(now.toISOString());
}

export function buildDefaultScheduleInput(now: Date): string {
  const roundedMs = Math.ceil((now.getTime() + 10 * 60 * 1000) / (5 * 60 * 1000)) * (5 * 60 * 1000);
  return formatUtcIsoToKstInput(new Date(roundedMs).toISOString());
}

export function validateScheduleInputKst(input: string, now: Date): ScheduleValidationState {
  try {
    return {
      error: null,
      scheduledAtUtc: validateScheduledAtKstInput(input, now),
    };
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : 'scheduledAt must be a future KST datetime',
      scheduledAtUtc: null,
    };
  }
}

export function isScheduledBadgeVisible(
  scheduledDispatch: Pick<ScheduledDispatchState, 'status'> | null | undefined,
): boolean {
  return scheduledDispatch?.status === 'scheduled';
}

export function getScheduledStatusLabel(status: ScheduledDispatchStatus): string {
  switch (status) {
    case 'scheduled':
      return 'Scheduled';
    case 'dispatching':
      return 'Dispatching';
    case 'dispatched':
      return 'Dispatched';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

interface ScheduledDispatchEditorProps {
  currentNow: Date;
  inputId: string;
  inputLabel?: string;
  noteLabel?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export const ScheduledDispatchEditor: React.FC<ScheduledDispatchEditorProps> = ({
  currentNow,
  inputId,
  inputLabel = 'KST date/time',
  noteLabel,
  value,
  disabled = false,
  onChange,
}) => {
  const validation = useMemo(
    () => validateScheduleInputKst(value, currentNow),
    [currentNow, value],
  );

  const previewText = validation.scheduledAtUtc
    ? formatScheduledPreview(validation.scheduledAtUtc)
    : '유효한 KST 날짜/시간을 입력하세요.';

  return (
    <>
      <div className="kv2-form-group">
        <label className="kv2-label" htmlFor={inputId}>{inputLabel}</label>
        <input
          id={inputId}
          className="kv2-input"
          type="datetime-local"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={validation.error ? 'true' : 'false'}
          disabled={disabled}
        />
        <div className="kv2-schedule-dialog-note">현재 KST: {formatCurrentKstLabel(currentNow)}</div>
        {noteLabel ? <div className="kv2-schedule-dialog-note">{noteLabel}</div> : null}
      </div>

      <div className={`kv2-schedule-preview${validation.error ? ' is-invalid' : ''}`}>
        <div className="kv2-schedule-preview-label">Readable preview</div>
        <div className="kv2-schedule-preview-value">{previewText}</div>
        {validation.error && (
          <div className="kv2-schedule-preview-error" role="alert">
            {validation.error}
          </div>
        )}
      </div>
    </>
  );
};

const ScheduledDispatchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <rect x="2.25" y="3.5" width="10.5" height="10.25" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5.25 2.5V5.25M9.75 2.5V5.25M2.75 7H12.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="13.75" cy="13.75" r="4" fill="var(--kv2-surface)" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13.75 11.85V13.75L15.15 14.55" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface ScheduledDispatchBadgeProps {
  ariaLabel: string;
  className?: string;
}

export const ScheduledDispatchBadge: React.FC<ScheduledDispatchBadgeProps> = ({
  ariaLabel,
  className,
}) => (
  <span
    className={['kv2-scheduled-badge', className].filter(Boolean).join(' ')}
    role="img"
    aria-label={ariaLabel}
    title={ariaLabel}
  >
    <ScheduledDispatchIcon />
  </span>
);
