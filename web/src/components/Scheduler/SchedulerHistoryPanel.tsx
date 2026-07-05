import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { SchedulerEntry, SchedulerRun } from '../../../../src/core/types';
import { fetchSchedulerHistory } from '../../hooks/useSchedulerApi';
import { useModalAccessibility } from '../../hooks/useModalAccessibility';
import '../../styles/components.css';
import './Scheduler.css';

interface SchedulerHistoryPanelProps {
  entry: SchedulerEntry;
  onClose: () => void;
}

export const SchedulerHistoryPanel: React.FC<SchedulerHistoryPanelProps> = ({
  entry,
  onClose,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<SchedulerRun[]>(entry.history);
  const [loading, setLoading] = useState(false);

  useModalAccessibility(true, dialogRef, onClose);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const history = await fetchSchedulerHistory(entry.id);
      setRuns(history);
    } catch {
      // Fall back to inline history
      setRuns(entry.history);
    } finally {
      setLoading(false);
    }
  }, [entry.id, entry.history]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  const getDuration = (run: SchedulerRun): string => {
    if (!run.finishedAt) return 'running...';
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  return (
    <div
      className="scheduler-history-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
    >
      <div
        className="scheduler-history"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduler-history-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="scheduler-history-header">
          <h3 id="scheduler-history-title" className="scheduler-history-title">
            Run History — {entry.name}
          </h3>
          <button
            type="button"
            className="scheduler-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading ? (
          <div className="loading-spinner" aria-label="Loading..." />
        ) : runs.length === 0 ? (
          <div className="scheduler-history-empty">
            No runs yet. Click "Run Now" to execute this scheduler.
          </div>
        ) : (
          <div className="scheduler-history-list">
            {runs.map((run) => (
              <div key={run.id} className="scheduler-history-item">
                <div className="scheduler-history-item-header">
                  <span className="scheduler-history-item-time">
                    {formatTime(run.startedAt)}
                  </span>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <span className="scheduler-history-item-time">
                      {getDuration(run)}
                    </span>
                    <span className={`neo-badge scheduler-badge--${run.status}`}>
                      {run.status}
                    </span>
                  </div>
                </div>

                {run.exitCode !== undefined && (
                  <span className="scheduler-history-item-time">
                    Exit code: {run.exitCode}
                  </span>
                )}

                {run.stdout && (
                  <div className="scheduler-history-output">
                    {run.stdout}
                  </div>
                )}

                {run.stderr && (
                  <div className="scheduler-history-output" style={{ borderColor: 'var(--color-accent)' }}>
                    {run.stderr}
                  </div>
                )}

                {run.error && (
                  <div className="scheduler-history-output" style={{ borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }}>
                    {run.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
