import React, { useState } from 'react';
import type {
  CreateSchedulerInput,
  SchedulerEntry,
  SchedulerRun,
  UpdateSchedulerInput,
} from '../../../../src/core/types';
import { SchedulerHistoryPanel } from './SchedulerHistoryPanel';
import { SchedulerJobModal, SchedulerTimezoneNotice } from './SchedulerJobModal';
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
  onRunEntry: (id: string) => Promise<SchedulerRun>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  onOpenCard?: (cardId: string) => void;
}

const KST_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatKstDateTime(iso: string): string {
  return `${KST_FORMATTER.format(new Date(iso))} KST`;
}

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return '방금 전';
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}분 전`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}시간 전`;
  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}일 전`;
}

function getPromptRuntimeLabel(entry: SchedulerEntry): string {
  if (entry.action.type !== 'prompt') return '';
  const runtime = entry.action.agentRuntime ?? 'opencode';
  return runtime === 'opencode' ? 'Opencode' : runtime === 'codex' ? 'Codex' : 'Claude';
}

function getPromptModelLabel(entry: SchedulerEntry): string {
  if (entry.action.type !== 'prompt') return '';
  return entry.action.model ?? 'Default model';
}

export const SchedulerEntryCard: React.FC<{
  entry: SchedulerEntry;
  onToggleEntry: (id: string) => Promise<void>;
  onRunEntry: (id: string) => Promise<SchedulerRun>;
  onEditEntry: (entry: SchedulerEntry) => void;
  onDeleteEntry: (entry: SchedulerEntry) => void;
  onOpenHistory: (entry: SchedulerEntry) => void;
}> = ({
  entry,
  onToggleEntry,
  onRunEntry,
  onEditEntry,
  onDeleteEntry,
  onOpenHistory,
}) => {
  const stopClickPropagation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const needsEdit = entry.action.editState === 'edit-required';

  return (
    <article
      className={`scheduler-item scheduler-item--${entry.action.type}${entry.status === 'inactive' ? ' scheduler-item--inactive' : ''}${needsEdit ? ' scheduler-item--legacy' : ''}`}
    >
      <div className="scheduler-item-header">
        <div className="scheduler-item-heading">
          <div className="scheduler-item-title-row">
            <h3 className="scheduler-item-name">{entry.name}</h3>
            <span className={`kv2-badge scheduler-badge--${entry.status}`}>
              {entry.status === 'active' ? '활성' : '정지'}
            </span>
            <span className={`kv2-badge scheduler-badge--action-${entry.action.type}`}>
              {entry.action.type === 'bash' ? 'Bash' : 'Prompt'}
            </span>
            {needsEdit && (
              <span className="kv2-badge scheduler-badge--legacy">편집 필요</span>
            )}
          </div>
          {entry.description && <p className="scheduler-item-desc">{entry.description}</p>}
        </div>

        <div className="scheduler-item-header-actions">
          <label className="scheduler-switch-row">
            <span className="scheduler-switch-copy">{entry.status === 'active' ? '자동 실행 중' : '자동 실행 정지'}</span>
            <button
              type="button"
              className={`scheduler-toggle ${entry.status === 'active' ? 'scheduler-toggle--active' : ''}`}
              onClick={(event) => {
                stopClickPropagation(event);
                void onToggleEntry(entry.id);
              }}
              role="switch"
              aria-checked={entry.status === 'active'}
              aria-label={entry.status === 'active' ? '자동 실행 일시 정지' : '자동 실행 활성화'}
              title={entry.status === 'active' ? '자동 실행 일시 정지' : '자동 실행 활성화'}
            />
          </label>
        </div>
      </div>

      <div className="scheduler-item-grid">
        <div className="scheduler-detail-card">
          <span className="scheduler-detail-label">Schedule</span>
          <strong className="scheduler-detail-value">{entry.cronDescription ?? entry.cron}</strong>
          <code className="scheduler-detail-subvalue">{entry.cron}</code>
        </div>

        <div className="scheduler-detail-card">
          <span className="scheduler-detail-label">Next run KST</span>
          <strong className="scheduler-detail-value">{entry.nextRunAt ? formatKstDateTime(entry.nextRunAt) : '계산 대기 중'}</strong>
          <span className="scheduler-detail-subvalue">Asia/Seoul 고정</span>
        </div>

        <div className="scheduler-detail-card">
          <span className="scheduler-detail-label">Recent run</span>
          <strong className="scheduler-detail-value">{entry.lastRunAt ? formatTimeAgo(entry.lastRunAt) : '아직 없음'}</strong>
          <span className="scheduler-detail-subvalue">
            {entry.lastRunStatus ? `상태: ${entry.lastRunStatus}` : '실행되면 여기에 표시됩니다.'}
          </span>
        </div>

        {entry.action.type === 'bash' ? (
          <div className="scheduler-detail-card scheduler-detail-card--wide">
            <span className="scheduler-detail-label">Bash command</span>
            <strong className="scheduler-detail-value scheduler-detail-value--mono">{entry.action.command}</strong>
            <span className="scheduler-detail-subvalue">
              {entry.action.cwd ? `cwd: ${entry.action.cwd}` : 'cwd 없음'}
            </span>
          </div>
        ) : (
          <div className="scheduler-detail-card scheduler-detail-card--wide">
            <span className="scheduler-detail-label">Prompt runtime / model</span>
            <strong className="scheduler-detail-value">
              {getPromptRuntimeLabel(entry)} · {getPromptModelLabel(entry)}
            </strong>
            <span className="scheduler-detail-subvalue">
              {needsEdit
                ? 'legacy skill에서 변환됨. 저장 후 다시 활성화하세요.'
                : entry.action.projectDir
                  ? `projectDir: ${entry.action.projectDir}`
                  : 'projectDir 없음'}
            </span>
          </div>
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
          지금 실행
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-btn--small"
          onClick={(event) => {
            stopClickPropagation(event);
            onOpenHistory(entry);
          }}
        >
          기록 {entry.history.length}개
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-btn--small"
          onClick={(event) => {
            stopClickPropagation(event);
            onEditEntry(entry);
          }}
        >
          수정
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
          onClick={(event) => {
            stopClickPropagation(event);
            onDeleteEntry(entry);
          }}
        >
          삭제
        </button>
      </div>
    </article>
  );
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
  onOpenCard,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEntry, setEditEntry] = useState<SchedulerEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<SchedulerEntry | null>(null);

  const handleDelete = (entry: SchedulerEntry) => {
    if (window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) {
      void onDeleteEntry(entry.id);
    }
  };

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
            반복 작업을 Bash 또는 Prompt로 예약하고, 실행 이력을 카드와 함께 추적합니다.
          </p>
        </div>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          onClick={() => setShowCreateModal(true)}
        >
          새 Scheduler
        </button>
      </div>

      <SchedulerTimezoneNotice />

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
          아직 등록된 Scheduler가 없습니다. KST 기준으로 반복 작업을 자동화할 일정을 만들어 보세요.
        </div>
      ) : (
        <div className="scheduler-list">
          {sortedEntries.map((entry) => (
            <SchedulerEntryCard
              key={entry.id}
              entry={entry}
              onToggleEntry={onToggleEntry}
              onRunEntry={onRunEntry}
              onEditEntry={setEditEntry}
              onDeleteEntry={handleDelete}
              onOpenHistory={setHistoryEntry}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <SchedulerJobModal
          onClose={() => setShowCreateModal(false)}
          onSave={async (input) => {
            await onCreateEntry(input);
          }}
        />
      )}

      {editEntry && (
        <SchedulerJobModal
          onClose={() => setEditEntry(null)}
          onSave={async () => {}}
          onUpdate={onUpdateEntry}
          editEntry={editEntry}
        />
      )}

      {historyEntry && (
        <SchedulerHistoryPanel
          entry={historyEntry}
          onClose={() => setHistoryEntry(null)}
          onOpenCard={(cardId) => {
            setHistoryEntry(null);
            onOpenCard?.(cardId);
          }}
        />
      )}
    </div>
  );
};
