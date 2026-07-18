import React, { useCallback, useEffect, useState } from 'react';
import type { SchedulerEntry, SchedulerRun } from '../../../../src/core/types';
import { fetchSchedulerHistory } from '../../hooks/useSchedulerApi';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import './Scheduler.css';

interface SchedulerHistoryPanelProps {
  entry: SchedulerEntry;
  onClose: () => void;
  onOpenCard?: (cardId: string) => void;
}

interface SchedulerHistoryRunCardProps {
  entry: SchedulerEntry;
  run: SchedulerRun;
  onOpenCard?: (cardId: string) => void;
}

const HISTORY_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatHistoryTime(iso: string): string {
  return `${HISTORY_FORMATTER.format(new Date(iso))} KST`;
}

function getDuration(run: SchedulerRun): string {
  if (!run.finishedAt) return 'running...';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export const SchedulerHistoryRunCard: React.FC<SchedulerHistoryRunCardProps> = ({
  entry,
  run,
  onOpenCard,
}) => {
  const isPromptRun = entry.action.type === 'prompt';

  return (
    <article className="scheduler-history-item">
      <div className="scheduler-history-item-header">
        <div>
          <div className="scheduler-history-item-time">{formatHistoryTime(run.startedAt)}</div>
          <div className="scheduler-history-item-subtitle">{getDuration(run)}</div>
        </div>
        <span className={`kv2-badge scheduler-badge--${run.status}`}>
          {run.status === 'fail' ? 'fail' : run.status}
        </span>
      </div>

      {isPromptRun ? (
        <div className="scheduler-history-detail">
          <span className="scheduler-history-label">Prompt dispatch</span>
          {run.cardId ? (
            <button
              type="button"
              className="kv2-btn kv2-btn--outline kv2-btn--small"
              onClick={() => onOpenCard?.(run.cardId as string)}
            >
              카드로 전달됨 · {run.cardId}
            </button>
          ) : (
            <span className="scheduler-history-value">카드로 전달되지 않았습니다.</span>
          )}
        </div>
      ) : (
        <div className="scheduler-history-detail-grid">
          <div className="scheduler-history-detail">
            <span className="scheduler-history-label">Exit code</span>
            <span className="scheduler-history-value">{run.exitCode ?? '없음'}</span>
          </div>
          {run.stdout && (
            <div className="scheduler-history-detail scheduler-history-detail--output">
              <span className="scheduler-history-label">Bash output</span>
              <pre className="scheduler-history-output">{run.stdout}</pre>
            </div>
          )}
          {run.stderr && (
            <div className="scheduler-history-detail scheduler-history-detail--output">
              <span className="scheduler-history-label">stderr</span>
              <pre className="scheduler-history-output scheduler-history-output--error">{run.stderr}</pre>
            </div>
          )}
        </div>
      )}

      {run.error && (
        <div className="scheduler-history-detail scheduler-history-detail--output">
          <span className="scheduler-history-label">Error</span>
          <pre className="scheduler-history-output scheduler-history-output--error">{run.error}</pre>
        </div>
      )}
    </article>
  );
};

export const SchedulerHistoryPanel: React.FC<SchedulerHistoryPanelProps> = ({
  entry,
  onClose,
  onOpenCard,
}) => {
  const [runs, setRuns] = useState<SchedulerRun[]>(entry.history);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const history = await fetchSchedulerHistory(entry.id);
      setRuns(history);
    } catch {
      setRuns(entry.history);
    } finally {
      setLoading(false);
    }
  }, [entry.history, entry.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <DialogSkeleton title={`Run History · ${entry.name}`} onClose={onClose} width="760px">
      <div className="scheduler-history-shell">
        {loading ? (
          <div className="loading-spinner" aria-label="Loading..." />
        ) : runs.length === 0 ? (
          <div className="scheduler-history-empty">
            아직 실행 기록이 없습니다. "지금 실행"으로 첫 실행을 만들어 보세요.
          </div>
        ) : (
          <div className="scheduler-history-list">
            {runs.map((run) => (
              <SchedulerHistoryRunCard
                key={run.id}
                entry={entry}
                run={run}
                onOpenCard={onOpenCard}
              />
            ))}
          </div>
        )}
      </div>
    </DialogSkeleton>
  );
};
