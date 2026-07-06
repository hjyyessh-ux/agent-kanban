import React, { useState, useEffect } from 'react';
import type { ScriptEntry, ScriptRun } from '../../../../src/core/types';
import { fetchScriptHistory } from '../../hooks/useScriptsApi';
import './Scripts.css';
import { DialogSkeleton } from '../Card/DialogSkeleton';

interface ScriptHistoryPanelProps {
  entry: ScriptEntry;
  onClose: () => void;
}

export function ScriptHistoryPanel({ entry, onClose }: ScriptHistoryPanelProps) {
  const [history, setHistory] = useState<ScriptRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        setLoading(true);
        const data = await fetchScriptHistory(entry.id);
        setHistory(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load history');
      } finally {
        setLoading(false);
      }
    };
    loadHistory();
  }, [entry.id]);

  // Helper functions
  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleString();
  };

  const getDuration = (run: ScriptRun) => {
    if (!run.finishedAt) return 'Running...';
    const start = new Date(run.startedAt).getTime();
    const end = new Date(run.finishedAt).getTime();
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <DialogSkeleton
      title={`History: ${entry.name}`}
      onClose={onClose}
      width="720px"
    >
      {loading ? (
        <div className="scripts-loading">
          <p>Loading history...</p>
        </div>
      ) : error ? (
        <div className="scripts-error">
          <p>{error}</p>
        </div>
      ) : history.length === 0 ? (
        <div className="scripts-history-empty">
          <p>No run history available.</p>
        </div>
      ) : (
        <div className="scripts-history-list">
          {history.map((run) => (
            <div key={run.id} className="scripts-history-item">
              <div className="scripts-history-item-header">
                <div className="scripts-history-meta">
                  <span className={`kv2-badge scripts-badge--${run.status}`}>
                    {run.status.toUpperCase()}
                  </span>
                  <span className="scripts-history-item-time">
                    {formatTime(run.startedAt)}
                  </span>
                  <span className="scripts-history-duration">
                    ⏱ {getDuration(run)}
                  </span>
                  {run.exitCode !== undefined && (
                    <span className={`kv2-badge ${run.exitCode === 0 ? 'scripts-badge--success' : 'scripts-badge--fail'}`}>
                      Exit: {run.exitCode}
                    </span>
                  )}
                </div>
              </div>

              {run.error && (
                <div className="scripts-history-output scripts-history-output--error">
                  <strong>Error:</strong> {run.error}
                </div>
              )}

              {run.stderr && (
                <div className="scripts-history-output scripts-history-output--stderr">
                  <strong>Stderr:</strong>
                  <pre>{run.stderr}</pre>
                </div>
              )}

              {run.stdout && (
                <div className="scripts-history-output">
                  <strong>Stdout:</strong>
                  <pre>{run.stdout}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </DialogSkeleton>
  );
}
