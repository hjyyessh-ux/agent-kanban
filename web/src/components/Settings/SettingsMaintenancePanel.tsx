import React, { useEffect, useState } from 'react';
import {
  applyUpdateAndRestart,
  fetchMaintenanceLog,
  fetchMaintenanceStatus,
  type MaintenanceStatus,
} from '../../hooks/useSettingsApi';
import { DialogSkeleton } from '../Card/DialogSkeleton';

const COMMANDS = [
  'bash scripts/install.sh',
  'bash scripts/restart-opencode-plugin.sh --yes',
];

function getStatusLabel(status: MaintenanceStatus | null): string {
  if (!status || status.state === 'idle') return '대기';
  if (status.state === 'running') return '진행 중';
  if (status.state === 'success') return '완료';
  return '실패';
}

function getStatusClass(status: MaintenanceStatus | null): string {
  if (!status) return 'settings-maintenance-status--idle';
  return `settings-maintenance-status--${status.state}`;
}

export function SettingsMaintenancePanel() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [waitingForRestart, setWaitingForRestart] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchMaintenanceStatus()
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        if (nextStatus.state === 'running') {
          setWaitingForRestart(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!waitingForRestart) return;

    const interval = window.setInterval(() => {
      fetchMaintenanceStatus()
        .then((nextStatus) => {
          setStatus(nextStatus);
          if (nextStatus.state === 'success') {
            window.setTimeout(() => window.location.reload(), 600);
          } else if (nextStatus.state === 'fail') {
            setWaitingForRestart(false);
          }
        })
        .catch(() => {
          // Expected while the plugin process is restarting.
        });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [waitingForRestart]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await applyUpdateAndRestart();
      setStatus({
        state: 'running',
        pid: response.pid,
        repoRoot: response.repoRoot,
        logPath: response.logPath,
        startedAt: new Date().toISOString(),
        message: 'Build, install, and restart started.',
        updatedAt: new Date().toISOString(),
      });
      setConfirmOpen(false);
      setWaitingForRestart(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start maintenance update');
    } finally {
      setStarting(false);
    }
  };

  const handleToggleLog = async () => {
    const nextOpen = !logOpen;
    setLogOpen(nextOpen);
    if (!nextOpen) return;

    try {
      const response = await fetchMaintenanceLog();
      setLogText(response.log || 'No maintenance log yet.');
    } catch (err) {
      setLogText(err instanceof Error ? err.message : 'Failed to load maintenance log');
    }
  };

  const busy = starting || waitingForRestart || status?.state === 'running';

  return (
    <section className="settings-maintenance" aria-labelledby="settings-maintenance-title">
      <div className="settings-maintenance-header">
        <div className="settings-network-info">
          <h3 id="settings-maintenance-title" className="settings-network-title">유지보수</h3>
          <p className="settings-network-desc">
            로컬 Agent Kanban 플러그인을 빌드·설치하고 재시작합니다.
          </p>
        </div>
        <span className={`settings-maintenance-status ${getStatusClass(status)}`}>
          {getStatusLabel(status)}
        </span>
      </div>

      {status?.message && (
        <p className="settings-maintenance-message">{status.message}</p>
      )}

      <div className="settings-maintenance-actions">
        <button
          type="button"
          className="kv2-btn kv2-btn--outline"
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
          disabled={busy}
        >
          {busy ? '재시작 중…' : '업데이트 및 재시작'}
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--outline"
          onClick={() => {
            void handleToggleLog();
          }}
        >
          {logOpen ? '재시작 로그 숨기기' : '재시작 로그 보기'}
        </button>
      </div>

      {waitingForRestart && (
        <div className="settings-maintenance-reconnect" role="status" aria-live="polite">
          플러그인 서버가 다시 연결되기를 기다리는 중입니다…
        </div>
      )}

      {error && (
        <div className="settings-maintenance-error" role="alert">
          {error}
        </div>
      )}

      {logOpen && (
        <pre className="settings-maintenance-log">{logText || 'Loading log...'}</pre>
      )}

      {confirmOpen && (
        <DialogSkeleton
          title="Apply Update & Restart"
          onClose={() => {
            if (!starting) setConfirmOpen(false);
          }}
          width="640px"
        >
          <div className="settings-maintenance-confirm">
            <p>
              This will rebuild the local plugin, install the latest bundle, and restart the running plugin process from the resolved repo root.
            </p>
            <div className="settings-maintenance-command-list">
              {COMMANDS.map((command) => (
                <code key={command}>{command}</code>
              ))}
            </div>
            <p>
              The board may disconnect briefly while the process restarts.
            </p>
          </div>

          {error && (
            <div className="settings-maintenance-error" role="alert">
              {error}
            </div>
          )}

          <div className="kv2-dialog-actions settings-modal-actions">
            <button
              type="button"
              className="kv2-btn kv2-btn--outline settings-modal-btn"
              onClick={() => setConfirmOpen(false)}
              disabled={starting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--danger settings-modal-btn"
              onClick={() => {
                void handleStart();
              }}
              disabled={starting}
            >
              {starting ? 'Starting...' : 'Apply Update & Restart'}
            </button>
          </div>
        </DialogSkeleton>
      )}
    </section>
  );
}
