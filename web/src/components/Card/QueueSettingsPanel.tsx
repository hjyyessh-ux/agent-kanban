import React, { useState } from 'react';
import { KanbanCard, QueueSessionMode } from '../../../../src/core/types';
import { RuntimeBadge } from '../Board/BoardCardSections';

const queueStatusLabel = (status: string): string =>
  status === 'in_progress' ? 'In Progress' : 'Todo';

interface QueueTargetListProps {
  id?: string;
  value: string;
  options: KanbanCard[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

// Session Resume 리스트와 동일한 모양을 공유하는 큐 대상 선택 리스트.
// New Task(CreateCardDialog)와 Detail(QueueSettingsPanel) 양쪽에서 재사용한다.
export const QueueTargetList: React.FC<QueueTargetListProps> = ({
  id,
  value,
  options,
  disabled = false,
  onChange,
}) => (
  <div id={id} className="kv2-session-list kv2-queue-target-picker">
    <div className={`kv2-session-item${!value ? ' kv2-session-item--selected' : ''}`}>
      <div className="kv2-session-item-info">
        <div className="kv2-session-item-text">
          <span className="kv2-session-item-title">Start independently</span>
          <div className="kv2-session-item-meta">
            <span className="kv2-session-card-id">No queue target</span>
          </div>
        </div>
      </div>
      <div className="kv2-session-item-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-btn--session-select"
          onClick={() => onChange('')}
          disabled={disabled || !value}
        >
          {value ? 'SELECT' : 'SELECTED'}
        </button>
      </div>
    </div>

    {options.length === 0 ? (
      <span style={{ color: 'var(--kv2-neutral-400)', fontSize: 'var(--kv2-text-md)' }}>
        No queue targets available
      </span>
    ) : (
      options.map((candidate) => {
        const selected = value === candidate.id;
        return (
          <div
            key={candidate.id}
            className={`kv2-session-item${selected ? ' kv2-session-item--selected' : ''}`}
          >
            <div className="kv2-session-item-info">
              <RuntimeBadge runtime={candidate.agentRuntime ?? 'opencode'} />
              <div className="kv2-session-item-text">
                <span className="kv2-session-item-title">{candidate.title}</span>
                <div className="kv2-session-item-meta">
                  <span className="kv2-session-card-id">Card {candidate.id}</span>
                  <span className={`kv2-session-status-badge kv2-session-status-badge--${candidate.status}`}>
                    {queueStatusLabel(candidate.status)}
                  </span>
                </div>
              </div>
            </div>
            <div className="kv2-session-item-actions">
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--session-select"
                onClick={() => onChange(selected ? '' : candidate.id)}
                disabled={disabled}
              >
                {selected ? 'SELECTED' : 'SELECT'}
              </button>
            </div>
          </div>
        );
      })
    )}
  </div>
);

interface QueueSessionModePickerProps {
  value: QueueSessionMode;
  disabled?: boolean;
  onChange: (value: QueueSessionMode) => void;
}

export const QueueSessionModePicker: React.FC<QueueSessionModePickerProps> = ({
  value,
  disabled = false,
  onChange,
}) => (
  <div className="kv2-queue-mode">
    <div className="kv2-queue-mode-header">
      <span className="kv2-queue-mode-title">Session Mode</span>
      <span className="kv2-queue-mode-help">큐 실행 방식을 선택합니다.</span>
    </div>
    <div className="kv2-radio-group">
      <label className="kv2-radio-label">
        <input
          type="radio"
          checked={value === 'new_session'}
          onChange={() => onChange('new_session')}
          disabled={disabled}
        />
        <span className="kv2-radio-text">
          <span className="kv2-radio-title">New Session</span>
          <span className="kv2-radio-desc">새 세션으로 시작합니다.</span>
        </span>
      </label>
      <label className="kv2-radio-label">
        <input
          type="radio"
          checked={value === 'continue_queued_after_session'}
          onChange={() => onChange('continue_queued_after_session')}
          disabled={disabled}
        />
        <span className="kv2-radio-text">
          <span className="kv2-radio-title">Continue After Session</span>
          <span className="kv2-radio-desc">앞 카드의 세션에서 이어갑니다.</span>
        </span>
      </label>
    </div>
  </div>
);

interface QueueSettingsPanelProps {
  card: KanbanCard;
  allCards?: KanbanCard[];
  queueModeSummary: { title: string; description: string };
  queueTargetId: string;
  queueSessionMode: QueueSessionMode;
  onQueueTargetChange: (value: string) => void;
  onQueueSessionModeChange: (value: QueueSessionMode) => void;
  onQueue?: (cardId: string, afterCardId: string, sessionMode: QueueSessionMode) => Promise<KanbanCard> | void;
  onUnqueue?: (cardId: string) => Promise<KanbanCard> | void;
  defaultExpanded?: boolean;
}

export const QueueSettingsPanel: React.FC<QueueSettingsPanelProps> = ({
  card,
  allCards,
  queueModeSummary,
  queueTargetId,
  queueSessionMode,
  onQueueTargetChange,
  onQueueSessionModeChange,
  onQueue,
  onUnqueue,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const queueTargets = allCards?.filter(
    (candidate) =>
      !candidate.parentCardId
      && candidate.id !== card.id
      && (candidate.status === 'in_progress' || candidate.status === 'todo'),
  ) ?? [];

  const queuedAfterTitle = card.queuedAfterCardId
    ? allCards?.find((candidate) => candidate.id === card.queuedAfterCardId)?.title
    : undefined;

  const isQueued = Boolean(card.queuedAfterCardId);
  const showBody = expanded || isQueued;

  return (
    <div className="kv2-queue-panel">
      <div className="kv2-panel-heading">
        <button
          type="button"
          className="kv2-session-title"
          style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
          aria-expanded={showBody}
          onClick={() => setExpanded((current) => !current)}
        >
          Queue After
          <span className="kv2-chevron" style={{ transform: showBody ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
        </button>
        {isQueued && (
          <span className="kv2-badge kv2-badge--queue">
            ⏭ {card.queuePosition === 1 ? 'NEXT' : `#${card.queuePosition}`}
          </span>
        )}
      </div>
      <div className="kv2-session-helper">선택한 작업이 끝난 뒤 이 작업을 이어서 시작합니다.</div>

      {showBody && isQueued ? (
        <div className="kv2-queue-summary-card">
          <div className="kv2-queue-summary-row">
            <span className="kv2-queue-target-label">Target:</span>
            <strong>🔗 {queuedAfterTitle ?? card.queuedAfterCardId}</strong>
          </div>
          <div className="kv2-queue-mode-summary">
            <span className="kv2-queue-mode-label">Session Mode:</span>
            <span>{queueModeSummary.title}</span>
          </div>
          {onUnqueue && (
            <button
              type="button"
              className="kv2-btn kv2-btn--queue-remove"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => {
                void onUnqueue(card.id);
              }}
            >
              Remove from Queue
            </button>
          )}
        </div>
      ) : null}

      {showBody && !isQueued && onQueue ? (
        <div className="kv2-session-config-card">
          <QueueTargetList
            id="detail-queue-select"
            value={queueTargetId}
            options={queueTargets}
            onChange={onQueueTargetChange}
          />

          {queueTargetId && (
            <>
              <QueueSessionModePicker
                value={queueSessionMode}
                onChange={onQueueSessionModeChange}
              />

              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--sidebar-secondary"
                onClick={() => {
                  void onQueue(card.id, queueTargetId, queueSessionMode);
                  onQueueTargetChange('');
                }}
              >
                SAVE QUEUE SETTINGS
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};
