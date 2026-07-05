import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ScriptEntry, ScriptRun } from '../../../../src/core/types';
import { fetchScriptHistory } from '../../hooks/useScriptsApi';
import '../../styles/components.css';
import './Scripts.css';

interface ScriptHistoryPanelProps {
  entry: ScriptEntry;
  onClose: () => void;
}

export function ScriptHistoryPanel({ entry, onClose }: ScriptHistoryPanelProps) {
  const [history, setHistory] = useState<ScriptRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Fetch history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        setLoading(true);
        const data = await fetchScriptHistory(entry.id);
        setHistory(data);
      } catch (err: any) {
        setError(err.message || 'Failed to load history');
      } finally {
        setLoading(false);
      }
    };
    loadHistory();
  }, [entry.id]);

  // Handle overlay click to close
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }, [onClose]);

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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
    <div className="scripts-history-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="scripts-history neo-surface">
        <div className="scripts-history-header">
          <h2 className="scripts-history-title">History: {entry.name}</h2>
          <button className="scripts-history-close neo-button neo-button--sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading ? (
          <div className="scripts-loading">
            <div className="neo-spinner"></div>
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
              <div key={run.id} className="scripts-history-item neo-surface">
                <div className="scripts-history-item-header">
                  <div className="scripts-history-meta">
                    <span className={`neo-badge scripts-badge--${run.status}`}>
                      {run.status.toUpperCase()}
                    </span>
                    <span className="scripts-history-item-time">
                      {formatTime(run.startedAt)}
                    </span>
                    <span className="scripts-history-duration">
                      ⏱ {getDuration(run)}
                    </span>
                    {run.exitCode !== undefined && (
                      <span className={`neo-badge ${run.exitCode === 0 ? 'neo-badge--success' : 'neo-badge--error'}`}>
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
      </div>
    </div>
  );
}
