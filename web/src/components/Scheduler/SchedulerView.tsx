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
        <span className="scheduler-toolbar-title">
          Schedulers ({entries.length})
        </span>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => setShowCreateModal(true)}
        >
          + NEW SCHEDULER
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
          No schedulers yet. Create one to start automating tasks.
        </div>
      ) : (
        <div className="scheduler-list">
          {sortedEntries.map((entry) => (
            <div
              key={entry.id}
              className={`scheduler-item ${entry.status === 'inactive' ? 'scheduler-item--inactive' : ''}`}
              onClick={() => handleEditOpen(entry)}
            >
              <div className="scheduler-item-header">
                <div className="scheduler-item-info">
                  <div className="scheduler-item-title-row">
                    <h3 className="scheduler-item-name">{entry.name}</h3>
                    <span className={`kv2-badge scheduler-badge--${entry.status}`}>
                      {entry.status}
                    </span>
                  </div>
                  {entry.description && (
                    <p className="scheduler-item-desc">{entry.description}</p>
                  )}
                </div>
                <div className="scheduler-item-actions">
                  <button
                    type="button"
                    className={`scheduler-toggle ${entry.status === 'active' ? 'scheduler-toggle--active' : ''}`}
                    onClick={(event) => {
                      stopClickPropagation(event);
                      void onToggleEntry(entry.id);
                    }}
                    role="switch"
                    aria-checked={entry.status === 'active'}
                    title={entry.status === 'active' ? 'Deactivate' : 'Activate'}
                    aria-label={entry.status === 'active' ? 'Deactivate' : 'Activate'}
                  />
                </div>
              </div>

              <div className="scheduler-item-meta">
                <span title={entry.cron} aria-label={`Schedule: ${entry.cronDescription ?? entry.cron}`}>
                  ⏰ {entry.cronDescription ?? entry.cron}
                </span>
                {entry.timezone && (
                  <span aria-label={`Timezone: ${entry.timezone}`}>🌐 {entry.timezone}</span>
                )}
                {entry.nextRunAt && (
                  <span>Next: {new Date(entry.nextRunAt).toLocaleString()}</span>
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
                  <span>
                    Last run: {timeAgo(entry.lastRunAt)}
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
                  ▶ Run Now
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    setHistoryEntry(entry);
                  }}
                >
                  📋 History ({entry.history.length})
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    handleEditOpen(entry);
                  }}
                >
                  ✎ Edit
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
                  onClick={(event) => {
                    stopClickPropagation(event);
                    handleDelete(entry);
                  }}
                >
                  ✕ Delete
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
