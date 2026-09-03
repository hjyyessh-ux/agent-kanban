import { useEffect, useMemo, useRef, useState } from 'react';
import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  recommendWorksForSession,
  suggestWorkTitle,
  projectDirLabel,
  shortSessionId,
  formatTimeAgo,
  type WorkRecommendation,
} from './worksAssign';
import './Works.css';

interface BulkAssignModalProps {
  /** Snapshot of the Inbox captured when the modal opened — kept stable while triaging. */
  sessions: WorkInboxSession[];
  works: Work[];
  onClose: () => void;
  onCreateWorkFromSession: (
    session: WorkInboxSession,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  onLinkSessionToWork: (
    workId: string,
    session: WorkInboxSession,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  onIgnoreSession: (sessionId: string) => Promise<void>;
}

/** Up to nine recommendations get a 1–9 shortcut; the rest fall off the keyboard grid. */
const MAX_SHORTCUT_WORKS = 9;

type Selection = { mode: 'new' } | { mode: 'existing'; workId: string };

/** Default choice for a session: its top recommendation, else "새 Work 만들기". */
function defaultSelection(recommendations: WorkRecommendation[]): Selection {
  return recommendations.length > 0
    ? { mode: 'existing', workId: recommendations[0].work.id }
    : { mode: 'new' };
}

/**
 * "모두 배정하기" — walks the unassigned Inbox one session at a time (a card
 * stack with an n/N progress counter). Each step offers "새 Work 만들기" or the
 * ranked recommendations (same-projectDir first), driven by keyboard:
 * N=new, 1–9=pick a recommendation, S=skip, X=discard, Enter=connect & advance.
 * Assignment reuses the exact create/link/ignore mutations the inline panel
 * (card 2) uses, so both flows stay in lockstep.
 */
export function BulkAssignModal({
  sessions,
  works,
  onClose,
  onCreateWorkFromSession,
  onLinkSessionToWork,
  onIgnoreSession,
}: BulkAssignModalProps) {
  const [index, setIndex] = useState(0);

  const total = sessions.length;
  const session = sessions[index];

  const recommendations = useMemo(
    () => (session ? recommendWorksForSession(session, works).slice(0, MAX_SHORTCUT_WORKS) : []),
    [session, works],
  );
  const suggestedTitle = useMemo(
    () => (session ? suggestWorkTitle(session) : ''),
    [session],
  );

  // Seeded (not reset-on-mount) so the very first render already has a valid
  // choice. Otherwise "연결하고 다음 →" renders disabled for one commit, and
  // DialogSkeleton's initial focus falls through to the dialog's × button.
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(recommendations));
  const [title, setTitle] = useState(suggestedTitle);
  const [role, setRole] = useState<WorkSessionRole>('dev');
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Reset the per-session choice whenever we advance to a new card.
  useEffect(() => {
    if (!session) return;
    setSelection(defaultSelection(recommendations));
    setTitle(suggestedTitle);
    setRole('dev');
    // recommendations/suggestedTitle derive from session; index drives the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, session?.sessionId]);

  const advance = () => {
    if (index + 1 >= total) {
      onClose();
    } else {
      setIndex((prev) => prev + 1);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      advance();
    } catch {
      // The error is already surfaced via the Works error alert; keep the user on
      // this session so they can retry rather than silently skipping it.
    } finally {
      setBusy(false);
    }
  };

  const canConnect =
    selection.mode === 'new' ? title.trim().length > 0 : Boolean(selection.workId);

  const handleConnect = () => {
    if (!session || !canConnect) return;
    void runAction(async () => {
      if (selection.mode === 'new') {
        await onCreateWorkFromSession(session, title.trim() || suggestedTitle, role);
      } else {
        await onLinkSessionToWork(selection.workId, session, role);
      }
    });
  };

  const handleSkip = () => {
    if (busy) return;
    advance();
  };

  const handleDiscard = () => {
    if (!session) return;
    void runAction(() => onIgnoreSession(session.sessionId));
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    // Let the title <input> receive letters/digits so titles stay editable; only
    // Enter (submit) is honored while typing.
    const target = event.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

    if (event.key === 'Enter') {
      event.preventDefault();
      handleConnect();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      setSelection({ mode: 'new' });
    } else if (key === 's') {
      event.preventDefault();
      handleSkip();
    } else if (key === 'x') {
      event.preventDefault();
      handleDiscard();
    } else if (/^[1-9]$/.test(event.key)) {
      const pick = recommendations[Number(event.key) - 1];
      if (pick) {
        event.preventDefault();
        setSelection({ mode: 'existing', workId: pick.work.id });
      }
    }
  };

  // Bound on `window` in the CAPTURE phase, not on this panel's subtree:
  //  - DialogSkeleton's initial focus (and Tab) can legitimately sit on the
  //    dialog's × button, which is outside this panel, and a shortcut-driven
  //    triage flow must not depend on where focus happens to be.
  //  - DialogSkeleton's own onKeyDown calls `stopPropagation()` on every
  //    non-Escape key, and React's synthetic stopPropagation forwards to the
  //    native event at the React root — so a *bubble*-phase window listener
  //    would never fire at all.
  // Escape is deliberately left alone here; DialogSkeleton closes on it.
  const keyHandlerRef = useRef(handleKeyDown);
  useEffect(() => {
    keyHandlerRef.current = handleKeyDown;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  if (!session) {
    // Nothing to triage (all sessions were assigned/discarded elsewhere).
    return (
      <DialogSkeleton title="세션 배정" onClose={onClose} width="640px">
        <div className="bulk-assign">
          <p className="works-empty">배정할 미배정 세션이 없습니다.</p>
          <div className="kv2-dialog-footer">
            <div className="kv2-actions-split">
              <button type="button" className="kv2-btn kv2-btn--primary kv2-actions-primary" onClick={onClose}>
                닫기
              </button>
            </div>
          </div>
        </div>
      </DialogSkeleton>
    );
  }

  return (
    <DialogSkeleton
      title="세션 배정"
      onClose={onClose}
      width="640px"
      initialFocusRef={primaryRef}
    >
      <div className="bulk-assign">
        <div className="bulk-assign-progress">
          <span className="kv2-badge">{index + 1} / {total}</span>
          <span className="bulk-assign-progress-hint">남은 미배정 세션을 하나씩 배정합니다</span>
        </div>

        <div className="bulk-assign-session">
          <div className="bulk-assign-session-head">
            <span className="kv2-badge works-runtime-chip">{session.agentRuntime}</span>
            {session.projectDir && (
              <b className="bulk-assign-dir">📁 {projectDirLabel(session.projectDir)}</b>
            )}
            <span className="works-mono">{shortSessionId(session.sessionId)}</span>
            <span className="bulk-assign-session-meta">
              {formatTimeAgo(session.updatedAt)} · 카드 {session.relatedCardCount}
            </span>
          </div>
          <div className="bulk-assign-prompt">
            {session.sessionTitle || session.cardTitle}
          </div>
        </div>

        <div className="bulk-assign-options" role="listbox" aria-label="배정 대상">
          <button
            type="button"
            role="option"
            aria-selected={selection.mode === 'new'}
            className={`bulk-assign-option${selection.mode === 'new' ? ' is-selected' : ''}`}
            onClick={() => setSelection({ mode: 'new' })}
          >
            <span className="bulk-assign-opt-title">
              <span className="bulk-assign-kbd">N</span> 새 Work 만들기
            </span>
            <span className="bulk-assign-opt-desc">"{suggestedTitle}" (제목 수정 가능)</span>
          </button>

          {recommendations.map(({ work, sameDirectory }, i) => {
            const selected = selection.mode === 'existing' && selection.workId === work.id;
            return (
              <button
                type="button"
                key={work.id}
                role="option"
                aria-selected={selected}
                className={`bulk-assign-option${selected ? ' is-selected' : ''}`}
                onClick={() => setSelection({ mode: 'existing', workId: work.id })}
              >
                <span className="bulk-assign-opt-title">
                  <span className="bulk-assign-kbd">{i + 1}</span> {work.title}
                </span>
                <span className="bulk-assign-opt-desc">
                  {sameDirectory ? '추천 · 같은 projectDir' : '다른 projectDir'}
                </span>
              </button>
            );
          })}
        </div>

        {selection.mode === 'new' && (
          <div className="bulk-assign-new">
            <label className="kv2-label" htmlFor="bulk-assign-title">새 Work 제목</label>
            <input
              id="bulk-assign-title"
              className="kv2-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Work 제목"
            />
          </div>
        )}

        <div className="bulk-assign-role">
          <label className="kv2-label" htmlFor="bulk-assign-role">이 세션 역할</label>
          <select
            id="bulk-assign-role"
            className="kv2-select"
            value={role}
            onChange={(event) => setRole(event.target.value as WorkSessionRole)}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option} value={option}>{ROLE_LABELS[option]}</option>
            ))}
          </select>
        </div>

        <div className="kv2-dialog-footer">
          <div className="kv2-actions-split">
            <button
              type="button"
              className="kv2-btn kv2-btn--small kv2-btn--ghost kv2-action-cancel"
              disabled={busy}
              onClick={handleSkip}
            >
              <span className="bulk-assign-kbd">S</span> 건너뛰기
            </button>
            <button
              type="button"
              className="kv2-btn kv2-btn--small kv2-btn--danger"
              disabled={busy}
              onClick={handleDiscard}
            >
              <span className="bulk-assign-kbd">X</span> 폐기
            </button>
            <div className="kv2-actions-primary">
              <button
                ref={primaryRef}
                type="button"
                className="kv2-btn kv2-btn--primary"
                disabled={!canConnect || busy}
                onClick={handleConnect}
              >
                연결하고 다음 →
              </button>
            </div>
          </div>
        </div>
      </div>
    </DialogSkeleton>
  );
}
