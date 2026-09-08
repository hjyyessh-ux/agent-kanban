import type { Work, WorkInboxSession } from '../../../../src/core/types';
import type { WorkSessionNoticeState } from './WorkSessionNotice';

/**
 * The undo half of an assignment, shared by the two triage surfaces (the Inbox
 * inline panel and the `⚡ 모두 배정하기` modal).
 *
 * Moves, unlinks and role changes have offered an undo toast since they existed;
 * assignment and 폐기 — the two actions triage is actually made of, and the two
 * a single keystroke can trigger — did not. 폐기 was the worst of them: it
 * removed the session from every screen and nothing anywhere could put it back.
 *
 * Every entry is one of `useWorks`'s own mutations called in reverse, so an undo
 * cannot drift from the action it reverses.
 */
export interface WorkAssignUndoActions {
  /** Owned by `App` — the toast has to outlive the panel or modal that acted. */
  notify: (notice: WorkSessionNoticeState) => void;
  /** Undo of "새 Work 만들기": the Work was just created, so it is removed again. */
  deleteWork: (workId: string) => Promise<void>;
  /** Undo of a link onto an existing Work: the session returns to the Inbox. */
  unlinkSession: (workId: string, sessionId: string) => Promise<void>;
  /** Undo of 폐기: the session comes off the ignore list. */
  restoreSession: (sessionId: string) => Promise<void>;
}

/** The label an Inbox row is known by — its first prompt, else the card title. */
export function assignSessionLabel(session: Pick<WorkInboxSession, 'sessionTitle' | 'cardTitle'>): string {
  const raw = (session.sessionTitle ?? session.cardTitle ?? '').trim();
  if (!raw) return '이 세션';
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 32 ? `${firstLine.slice(0, 32).trimEnd()}…` : firstLine;
}

/**
 * A Work was created for `sessionCount` session(s). Undo deletes it, which also
 * releases those sessions back into the Inbox — a faithful reversal, because the
 * Work is seconds old and has no Summary or history to lose.
 */
export function noticeForNewWork(
  work: Work,
  sessionCount: number,
  undo: WorkAssignUndoActions,
): WorkSessionNoticeState {
  return {
    tone: 'success',
    message: sessionCount > 1
      ? `✓ 세션 ${sessionCount}개를 새 Work "${work.title}"에 연결했습니다.`
      : `✓ 새 Work "${work.title}"을 만들고 세션을 연결했습니다.`,
    undo: {
      label: '되돌리기',
      run: () => undo.deleteWork(work.id),
    },
  };
}

/**
 * Session(s) were linked onto an existing Work. Undo unlinks exactly the ones
 * that were linked — sequentially, because each unlink rewrites the same Work
 * record behind the store's lock.
 *
 * Subagent sessions the server carried along (`cascadedSessionIds`) are **not**
 * unlinked: the hook returns the Work, not that list, and inventing an undo that
 * silently leaves descendants behind is worse than one that says what it did.
 */
export function noticeForLinkedSessions(
  work: Work,
  sessionIds: string[],
  undo: WorkAssignUndoActions,
): WorkSessionNoticeState {
  return {
    tone: 'success',
    message: sessionIds.length > 1
      ? `✓ 세션 ${sessionIds.length}개를 "${work.title}"에 연결했습니다.`
      : `✓ 세션을 "${work.title}"에 연결했습니다.`,
    undo: {
      label: '되돌리기',
      run: async () => {
        for (const sessionId of sessionIds) {
          await undo.unlinkSession(work.id, sessionId);
        }
      },
    },
  };
}

/**
 * A session was discarded (put on the Inbox ignore list). Undo restores it — the
 * whole reason `DELETE /api/works/ignore-session/:sessionId` exists.
 */
export function noticeForDiscardedSession(
  session: Pick<WorkInboxSession, 'sessionId' | 'sessionTitle' | 'cardTitle'>,
  undo: WorkAssignUndoActions,
): WorkSessionNoticeState {
  return {
    tone: 'warn',
    message: `🗑 "${assignSessionLabel(session)}" 세션을 폐기했습니다 (무시한 세션 목록으로 이동).`,
    undo: {
      label: '되돌리기',
      run: () => undo.restoreSession(session.sessionId),
    },
  };
}
