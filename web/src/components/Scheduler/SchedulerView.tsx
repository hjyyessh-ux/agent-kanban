import React, { useState } from 'react';
import type { SchedulerEntry, CreateSchedulerInput, UpdateSchedulerInput } from '../../../../src/core/types';
import { SchedulerJobModal } from './SchedulerJobModal';
import { SchedulerHistoryPanel } from './SchedulerHistoryPanel';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import './Scheduler.css';

interface SchedulerViewProps {
  entries: SchedulerEntry[];
  loading: boolean;
  error: UiAlert | null;
  onCreateEntry: (input: CreateSchedulerInput) => Promise<SchedulerEntry>;
  onUpdateEntry: (id: string, input: UpdateSchedulerInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onToggleEntry: (id: string) => Promise<void>;
  onRunEntry: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
}

const timeAgo = (isoString: string) => {
  const date = new Date(isoString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return 'just now';
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d ago`;
};

export const SchedulerView: React.FC<SchedulerViewProps> = ({
  entries,
  loading,
  error,
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onToggleEntry,
  onRunEntry,
  onRefresh,
  onClearError,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEntry, setEditEntry] = useState<SchedulerEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<SchedulerEntry | null>(null);

  const handleCreate = async (input: CreateSchedulerInput) => {
    await onCreateEntry(input);
  };

  const handleUpdate = async (id: string, input: UpdateSchedulerInput) => {
    await onUpdateEntry(id, input);
  };

  const handleDelete = (entry: SchedulerEntry) => {
    if (window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) {
      void onDeleteEntry(entry.id);
    }
  };

  const handleEditOpen = (entry: SchedulerEntry) => {
    setEditEntry(entry);
  };

  const stopClickPropagation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  // Sort: active first, then by createdAt desc
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="scheduler-view">
      <div className="scheduler-toolbar">
        <div className="scheduler-toolbar-heading">
          <h2 className="scheduler-toolbar-title">Scheduler</h2>
          <p className="scheduler-toolbar-subtitle">
            정해진 시간에 shell command나 skill을 자동으로 실행합니다. {entries.length}개 등록됨
          </p>
        </div>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => setShowCreateModal(true)}
        >
          + 새 Scheduler
        </button>
      </div>

      {error && (
        <ErrorAlert
          className="error-banner"
          title={error.title}
          message={error.message}
          actionLabel={error.actionLabel}
          onAction={() => {
            void onRefresh();
          }}
          onDismiss={onClearError}
        />
      )}

      {loading && entries.length === 0 ? (
        <div className="loading-spinner" role="status" aria-live="polite" />
      ) : entries.length === 0 ? (
        <div className="scheduler-empty">
          아직 등록된 Scheduler가 없습니다. 반복 작업을 자동화할 일정을 만들어 보세요.
        </div>
      ) : (
        <div className="scheduler-list">
          {sortedEntries.map((entry) => (
            <div
              key={entry.id}
              className={`scheduler-item ${entry.status === 'inactive' ? 'scheduler-item--inactive' : ''}`}
              onClick={() => handleEditOpen(entry)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleEditOpen(entry);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${entry.name} scheduler details`}
            >
              <div className="scheduler-item-header">
                <div className="scheduler-item-info">
                  <div className="scheduler-item-title-row">
                    <h3 className="scheduler-item-name">{entry.name}</h3>
                    <span className={`kv2-badge scheduler-badge--${entry.status}`}>
                      {entry.status === 'active' ? '활성' : '정지'}
                    </span>
                  </div>
                  {entry.description && (
                    <p className="scheduler-item-desc">{entry.description}</p>
                  )}
                </div>
                <div className="scheduler-item-actions">
                  <span className="scheduler-toggle-label">
                    {entry.status === 'active' ? '자동 실행 중' : '일시 정지됨'}
                  </span>
                  <button
                    type="button"
                    className={`scheduler-toggle ${entry.status === 'active' ? 'scheduler-toggle--active' : ''}`}
                    onClick={(event) => {
                      stopClickPropagation(event);
                      void onToggleEntry(entry.id);
                    }}
                    role="switch"
                    aria-checked={entry.status === 'active'}
                    title={entry.status === 'active' ? '자동 실행 일시 정지' : '자동 실행 활성화'}
                    aria-label={entry.status === 'active' ? '자동 실행 일시 정지' : '자동 실행 활성화'}
                  />
                </div>
              </div>

              <div className="scheduler-item-meta">
                <span className="scheduler-meta-group" title={entry.cron} aria-label={`Schedule: ${entry.cronDescription ?? entry.cron}`}>
                  <strong>일정</strong>
                  <span>{entry.cronDescription ?? entry.cron}</span>
                </span>
                {entry.timezone && (
                  <span className="scheduler-meta-group" aria-label={`Timezone: ${entry.timezone}`}>
                    <strong>시간대</strong>
                    <span>{entry.timezone}</span>
                  </span>
                )}
                {entry.nextRunAt && (
                  <span className="scheduler-meta-group">
                    <strong>다음 실행</strong>
                    <span>{new Date(entry.nextRunAt).toLocaleString()}</span>
                  </span>
                )}
              </div>

              <div className="scheduler-item-meta scheduler-item-command">
                <span
                  className={`kv2-badge scheduler-badge--${entry.action.type}`}
                  aria-label={entry.action.type === 'shell' ? 'Action type: shell' : 'Action type: skill'}
                >
                  {entry.action.type === 'shell' ? '🖥 shell' : '🧩 skill'}
                </span>
                {entry.action.type === 'shell' && entry.action.command && (
                  <span title={entry.action.command}>
                    $ {entry.action.command.length > 50 ? entry.action.command.substring(0, 50) + '...' : entry.action.command}
                  </span>
                )}
                {entry.action.type === 'skill' && entry.action.skillName && (
                  <span>🧩 {entry.action.skillName}</span>
                )}
              </div>

              <div className="scheduler-item-meta">
                {entry.lastRunAt && (
                  <span className="scheduler-meta-group">
                    <strong>최근 실행</strong>
                    <span>{timeAgo(entry.lastRunAt)}</span>
                    {entry.lastRunStatus && (
                      <> — <span className={`kv2-badge scheduler-badge--${entry.lastRunStatus}`}>{entry.lastRunStatus}</span></>
                    )}
                  </span>
                )}
              </div>

              <div className="scheduler-item-footer">
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    void onRunEntry(entry.id);
                  }}
                >
                  ▶ 지금 실행
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    setHistoryEntry(entry);
                  }}
                >
                  📋 기록 ({entry.history.length})
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    handleEditOpen(entry);
                  }}
                >
                  ✎ 수정
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    handleDelete(entry);
                  }}
                >
                  ✕ 삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <SchedulerJobModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
        />
      )}

      {/* Edit Modal */}
      {editEntry && (
        <SchedulerJobModal
          onClose={() => setEditEntry(null)}
          onSave={handleCreate}
          onUpdate={handleUpdate}
          editEntry={editEntry}
        />
      )}

      {/* History Panel */}
      {historyEntry && (
        <SchedulerHistoryPanel
          entry={historyEntry}
          onClose={() => setHistoryEntry(null)}
        />
      )}
    </div>
  );
};
