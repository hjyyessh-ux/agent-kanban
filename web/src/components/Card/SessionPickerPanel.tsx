import React, { useState, useEffect } from 'react';
import { KanbanCard } from '../../../../src/core/types';
import { fetchSessions, SessionInfo } from '../../hooks/useKanbanApi';
import { RuntimeBadge } from '../Board/BoardCardSections';

interface SessionPickerPanelBaseProps {
  onSelectSession: (cardId: string, sessionId: string) => Promise<void> | void;
  onClearSession: (cardId: string) => Promise<void> | void;
  layout?: 'sidebar' | 'embedded';
}

interface SessionPickerCardMode extends SessionPickerPanelBaseProps {
  card: KanbanCard;
  resumeSessionId?: undefined;
  onSessionChange?: undefined;
}

interface SessionPickerCreateMode extends SessionPickerPanelBaseProps {
  card?: undefined;
  resumeSessionId: string | undefined;
  onSessionChange: (sessionId: string | undefined) => void;
}

type SessionPickerPanelProps = SessionPickerCardMode | SessionPickerCreateMode;

const RESUMABLE_CARD_STATUSES = new Set(['todo', 'in_progress', 'complete']);

export function isSessionResumeCandidate(session: SessionInfo, currentCardId: string): boolean {
  return session.cardId !== currentCardId
    && !session.isSubagentOnly
    && RESUMABLE_CARD_STATUSES.has(session.cardStatus);
}

export const SessionPickerPanel: React.FC<SessionPickerPanelProps> = (props) => {
  const {
    onSelectSession,
    onClearSession,
  } = props;

  const cardId = props.card?.id ?? '__create__';
  const layout = props.layout ?? (props.card ? 'sidebar' : 'embedded');
  const currentResumeSessionId = props.card ? props.card.resumeSessionId : props.resumeSessionId;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  // New Task·Detail 모두 기본 접힘(hide). 헤더를 눌러 펼친다.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded && !currentResumeSessionId) return;
    setLoading(true);
    fetchSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [expanded, currentResumeSessionId]);

  const selectedSession = currentResumeSessionId
    ? sessions.find(s => s.sessionId === currentResumeSessionId)
    : undefined;

  const availableSessions = sessions.filter((session) => isSessionResumeCandidate(session, cardId));

  const statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      in_progress: 'In Progress',
      complete: 'Complete',
      done: 'Done',
      todo: 'Todo',
      untracked: 'Untracked',
    };
    return labels[status] ?? status;
  };

  const statusClass = (status: string): string => {
    if (status === 'todo' || status === 'in_progress' || status === 'complete' || status === 'done') {
      return status;
    }
    return 'unknown';
  };

  const rowTone = (session: SessionInfo): string => {
    const cwd = session.primaryPeerCwd ?? '';
    if (!cwd) return 'default';

    let hash = 0;
    for (let i = 0; i < cwd.length; i++) {
      hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
    }

    const tones = ['tone-a', 'tone-b', 'tone-c', 'tone-d', 'tone-e'];
    return tones[Math.abs(hash) % tones.length] ?? 'default';
  };

  return (
    <div className={`kv2-session-panel kv2-session-panel--${layout}`}>
      <div className="kv2-panel-heading">
        <button
          type="button"
          className="kv2-session-title" 
          onClick={() => setExpanded(!expanded)} 
          style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
        >
          Session Resume
          <span className="kv2-chevron" style={{ transform: expanded || currentResumeSessionId ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
        </button>
        {currentResumeSessionId && (
          <span className="kv2-badge kv2-badge--session">
            ▶ RESUME
          </span>
        )}
      </div>
      <div className="kv2-session-helper">기존 세션을 선택하면 그 대화에서 이어서 시작합니다.</div>

      {currentResumeSessionId && selectedSession ? (
        <div className="kv2-session-summary-card">
          <div className="kv2-session-summary-layout">
            <RuntimeBadge runtime={selectedSession.agentRuntime ?? 'opencode'} />
            <div className="kv2-session-summary-main">
              <strong className="kv2-session-item-title">{selectedSession.cardTitle}</strong>
              <div className="kv2-session-item-meta">
                <span className="kv2-session-card-id">Card {selectedSession.cardId || '-'}</span>
                <span className={`kv2-session-status-badge kv2-session-status-badge--${statusClass(selectedSession.cardStatus)}`}>
                  {statusLabel(selectedSession.cardStatus)}
                </span>
              </div>
              {selectedSession.sessionTitle && (
                <span className="kv2-session-item-card">
                  {selectedSession.sessionTitle}
                </span>
              )}
              <span className="kv2-session-id">Session {selectedSession.sessionId}</span>
            </div>
          </div>
          {selectedSession.primaryPeerCwd && (
            <div className="kv2-session-meta-row">
              <span className="kv2-session-item-path">{selectedSession.primaryPeerCwd}</span>
            </div>
          )}
          <button
            type="button"
            className="kv2-btn kv2-btn--session-remove"
            style={{ alignSelf: 'flex-end' }}
            onClick={() => {
              if (props.onSessionChange) {
                props.onSessionChange(undefined);
              } else {
                void onClearSession(cardId);
              }
            }}
          >
            Remove Session
          </button>
        </div>
      ) : currentResumeSessionId && !selectedSession && loading ? (
        <div className="kv2-session-config-card">
          <span style={{ color: '#94a3b8', fontSize: 'var(--kv2-text-md)' }}>Loading session...</span>
        </div>
      ) : null}

      {(expanded || currentResumeSessionId) && !currentResumeSessionId ? (
        <div className="kv2-session-config-card">
          {loading ? (
            <span style={{ color: '#94a3b8', fontSize: 'var(--kv2-text-md)' }}>Loading sessions...</span>
          ) : availableSessions.length === 0 ? (
            <span style={{ color: '#94a3b8', fontSize: 'var(--kv2-text-md)' }}>No sessions available</span>
          ) : (
            <div className="kv2-session-list">
              {availableSessions.slice(0, 15).map(session => (
                <div
                  key={session.sessionId}
                  className={`kv2-session-item kv2-session-item--${rowTone(session)}`}
                >
                  <div className="kv2-session-item-info">
                    <RuntimeBadge runtime={session.agentRuntime ?? 'opencode'} />
                    <div className="kv2-session-item-text">
                      <span className="kv2-session-item-title">
                        {session.cardTitle}
                      </span>
                      <div className="kv2-session-item-meta">
                        <span className="kv2-session-card-id">Card {session.cardId || '-'}</span>
                        <span className={`kv2-session-status-badge kv2-session-status-badge--${statusClass(session.cardStatus)}`}>
                          {statusLabel(session.cardStatus)}
                        </span>
                      </div>
                      {session.sessionTitle && (
                        <span className="kv2-session-item-card">
                          {session.sessionTitle}
                        </span>
                      )}
                      <span className="kv2-session-id">Session {session.sessionId}</span>
                    </div>
                  </div>
                  <div className="kv2-session-item-actions">
                    {session.primaryPeerCwd && (
                      <span className="kv2-session-item-path">{session.primaryPeerCwd}</span>
                    )}
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--outline kv2-btn--session-select"
                      onClick={() => {
                        if (props.onSessionChange) {
                          props.onSessionChange(session.sessionId);
                        } else {
                          void onSelectSession(cardId, session.sessionId);
                        }
                      }}
                    >
                      SELECT
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
