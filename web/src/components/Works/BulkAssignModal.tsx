import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import {
  EMPTY_BULK_ASSIGN_TALLY,
  ROLE_LABELS,
  ROLE_OPTIONS,
  describeBulkAssignProgress,
  recommendWorksForSession,
  resolveBulkAssignShortcut,
  suggestWorkTitle,
  shortSessionId,
  formatTimeAgo,
  type BulkAssignTally,
  type WorkRecommendation,
} from './worksAssign';
import { chainedWorkIds, dirAccentClass } from './worksAffinity';
import {
  noticeForDiscardedSession,
  noticeForLinkedSessions,
  noticeForNewWork,
  type WorkAssignUndoActions,
} from './workAssignNotice';
import { WorkAffinityMarks, DirChip } from './WorkAffinityMarks';
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
  /** Open the session's card conversation — the same 대화 보기 the Inbox row has. */
  onOpenCard?: (cardId: string) => void;
  /** Undo toasts for 연결 / 폐기; omit to assign without them. */
  assignNotice?: WorkAssignUndoActions;
  /**
   * `works.assign_suggest_resume_chain`. When on (the default), Works holding a
   * session this one continues rank first and are marked 🔗.
   */
  suggestSessionChain?: boolean;
  /**
   * `works.assign_prefer_same_dir`. When on (the default), Works sharing the
   * session's directory rank above the rest; off leaves lineage-then-recency.
   */
  preferSameDir?: boolean;
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
  onOpenCard,
  assignNotice,
  suggestSessionChain = true,
  preferSameDir = true,
}: BulkAssignModalProps) {
  const [index, setIndex] = useState(0);

  const total = sessions.length;
  const session = sessions[index];

  const chained = useMemo(
    () => (session && suggestSessionChain ? chainedWorkIds(session, works) : undefined),
    [session, works, suggestSessionChain],
  );
  const recommendations = useMemo(
    () => (session
      ? recommendWorksForSession(session, works, undefined, chained, { preferSameDir })
        .slice(0, MAX_SHORTCUT_WORKS)
      : []),
    [session, works, chained, preferSameDir],
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
  // What this walk has actually done so far. The `n / N` counter alone froze at
  // the snapshot size while sessions were being linked and discarded out of the
  // Inbox underneath it.
  const [tally, setTally] = useState<BulkAssignTally>(EMPTY_BULK_ASSIGN_TALLY);
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

  const runAction = async (
    action: () => Promise<void>,
    outcome: keyof BulkAssignTally,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setTally((prev) => ({ ...prev, [outcome]: prev[outcome] + 1 }));
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
        const work = await onCreateWorkFromSession(session, title.trim() || suggestedTitle, role);
        assignNotice?.notify(noticeForNewWork(work, 1, assignNotice));
      } else {
        const work = await onLinkSessionToWork(selection.workId, session, role);
        assignNotice?.notify(noticeForLinkedSessions(work, [session.sessionId], assignNotice));
      }
    }, 'linked');
  };

  const handleSkip = () => {
    if (busy) return;
    setTally((prev) => ({ ...prev, skipped: prev.skipped + 1 }));
    advance();
  };

  // Destructive and one keystroke away, so it always leaves an undo behind —
  // the ignore list was write-only when this shortcut was written.
  const handleDiscard = () => {
    if (!session) return;
    void runAction(async () => {
      await onIgnoreSession(session.sessionId);
      assignNotice?.notify(noticeForDiscardedSession(session, assignNotice));
    }, 'discarded');
  };

  // Which key means what is the pure `resolveBulkAssignShortcut`: this listener
  // sees *every* key in the dialog (window + capture), so "does the focused
  // element own this key" is the whole safety property and it belongs in a
  // tested function rather than inline here.
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const shortcut = resolveBulkAssignShortcut({
      key: event.key,
      target: {
        tagName: target?.tagName ?? '',
        isContentEditable: target?.isContentEditable,
      },
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      recommendationCount: recommendations.length,
    });
    if (!shortcut) return;

    event.preventDefault();
    switch (shortcut.action) {
      case 'connect':
        handleConnect();
        break;
      case 'select-new':
        setSelection({ mode: 'new' });
        break;
      case 'skip':
        handleSkip();
        break;
      case 'discard':
        handleDiscard();
        break;
      case 'select-recommendation':
        setSelection({
          mode: 'existing',
          workId: recommendations[shortcut.index].work.id,
        });
        break;
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
              <div className="kv2-actions-primary">
                <button type="button" className="kv2-btn kv2-btn--primary" onClick={onClose}>
                  닫기
                </button>
              </div>
            </div>
          </div>
        </div>
      </DialogSkeleton>
    );
  }

  // Rendered directly under whichever option is selected — the inputs for a
  // choice belong next to that choice, not at the end of a list the user has to
  // scroll past (and the sticky footer's submit stays in view either way).
  const detail = (
    <div className="bulk-assign-detail">
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
    </div>
  );

  return (
    <DialogSkeleton
      title="세션 배정"
      onClose={onClose}
      width="640px"
      initialFocusRef={primaryRef}
    >
      <div className="bulk-assign">
        {/* Announced, and live: the counts move as sessions are linked, skipped
            and discarded, instead of restating a frozen snapshot total. */}
        <div className="bulk-assign-progress" role="status" aria-live="polite">
          <span className="kv2-badge">{index + 1} / {total}</span>
          <span className="bulk-assign-progress-hint">
            {describeBulkAssignProgress(tally, total - index)}
          </span>
        </div>

        <div className="bulk-assign-session">
          <div className="bulk-assign-session-head">
            <span className="kv2-badge works-runtime-chip">{session.agentRuntime}</span>
            <DirChip projectDir={session.projectDir} className="bulk-assign-dir" />
            <span className="works-mono">{shortSessionId(session.sessionId)}</span>
            <span className="bulk-assign-session-meta">
              {formatTimeAgo(session.updatedAt)} · 카드 {session.relatedCardCount}
            </span>
            {/* The prompt excerpt is often not enough to decide where a session
                belongs; the Inbox row has always offered the conversation and
                this screen — the one that assigns *without* the row — did not. */}
            {onOpenCard && session.cardId && (
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--ghost bulk-assign-open-card"
                onClick={() => onOpenCard(session.cardId)}
              >
                대화 보기
              </button>
            )}
          </div>
          <div className="bulk-assign-prompt">
            {session.sessionTitle || session.cardTitle}
          </div>
        </div>

        {/* A plain group of aria-pressed toggles rather than a listbox: the
            selected option's inputs render *inside* the list, immediately under
            it, and a listbox may only contain options. */}
        <div className="bulk-assign-options" role="group" aria-label="배정 대상">
          <button
            type="button"
            aria-pressed={selection.mode === 'new'}
            className={`bulk-assign-option${selection.mode === 'new' ? ' is-selected' : ''}`}
            onClick={() => setSelection({ mode: 'new' })}
          >
            <span className="bulk-assign-opt-title">
              <span className="bulk-assign-kbd">N</span> 새 Work 만들기
            </span>
            <span className="bulk-assign-opt-desc">"{suggestedTitle}" (제목 수정 가능)</span>
          </button>
          {selection.mode === 'new' && detail}

          {recommendations.map(({ work, sameDirectory, chained: isChained }, i) => {
            const selected = selection.mode === 'existing' && selection.workId === work.id;
            return (
              <Fragment key={work.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  className={`bulk-assign-option works-dir-accented ${dirAccentClass(work.projectDir)}${selected ? ' is-selected' : ''}`}
                  onClick={() => setSelection({ mode: 'existing', workId: work.id })}
                >
                  <span className="bulk-assign-opt-title">
                    <span className="bulk-assign-kbd">{i + 1}</span> {work.title}
                  </span>
                  <span className="bulk-assign-opt-desc">
                    <WorkAffinityMarks
                      projectDir={work.projectDir}
                      sameDirectory={sameDirectory}
                      chained={isChained}
                    />
                  </span>
                </button>
                {selected && detail}
              </Fragment>
            );
          })}
        </div>

        {/* 폐기 is the only destructive action, so it takes the left danger
            zone on its own. 건너뛰기 belongs with the forward actions on the
            right: it advances the queue to the next session rather than leaving
            it. Previously it sat left with `kv2-action-cancel` and 폐기 was
            stranded between two `auto` margins, floating mid-footer. */}
        <div className="kv2-dialog-footer">
          <div className="kv2-actions-split">
            <div className="kv2-actions-danger">
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--subtle-danger"
                disabled={busy}
                onClick={handleDiscard}
              >
                <span className="bulk-assign-kbd">X</span> 폐기
              </button>
            </div>
            <div className="kv2-actions-primary">
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--ghost"
                disabled={busy}
                onClick={handleSkip}
              >
                <span className="bulk-assign-kbd">S</span> 건너뛰기
              </button>
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
