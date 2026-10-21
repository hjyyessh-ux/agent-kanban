import type { MoveWorkSessionResponse, Work, WorkInboxSession } from '../../../../src/core/types';
import type { WorkSessionNoticeState } from '../Works/WorkSessionNotice';
import {
  noticeForLinkedSessions,
  noticeForNewWork,
  type WorkAssignUndoActions,
} from '../Works/workAssignNotice';
import { BOARD_WORKS_COPY } from '../../constants/copy';
import type { WorkDropAction } from './board-works';

/** The session a board action addresses — all `useWorks` needs to link or move it. */
export type BoardSessionRef = Pick<WorkInboxSession, 'sessionId' | 'projectDir'>;

/**
 * `useWorks` mutations the board's drag & drop and `⋯ → Work로 이동` call, plus
 * App's notice setter. Passed in by `App` (fetch stays in the hook); every
 * undo below is one of these called in reverse, the same rule
 * `workAssignNotice.ts` and the Work detail dialog follow.
 */
export interface BoardWorkMutations {
  link: (workId: string, session: BoardSessionRef) => Promise<Work>;
  move: (sessionId: string, input: { toWorkId: string }) => Promise<MoveWorkSessionResponse>;
  unlink: (workId: string, sessionId: string) => Promise<Work>;
  /** `createWorkFromSession` — takes the Inbox DTO the board projects with `inboxSessionFromLink`. */
  createWithSession: (session: WorkInboxSession, title: string) => Promise<Work>;
  moveToNewWork: (session: BoardSessionRef, title: string) => Promise<MoveWorkSessionResponse>;
  deleteWork: (workId: string) => Promise<void>;
  notify: (notice: WorkSessionNoticeState) => void;
}

function titleOf(works: readonly Work[], workId: string): string {
  return works.find((work) => work.id === workId)?.title ?? workId;
}

/**
 * A move's notice. Undo moves the session back — unless the source lost its
 * last session and the server deleted it (`from: null`): re-creating it would
 * mint a new id without its Summary, so no undo is offered (the detail
 * dialog's rule). A split into a new Work undoes the same way; the new Work,
 * emptied by the move back, is deleted by the server.
 */
function noticeForMove(
  result: MoveWorkSessionResponse,
  sessionId: string,
  fromTitle: string,
  mutations: BoardWorkMutations,
): WorkSessionNoticeState {
  const { from } = result;
  if (!from) {
    return { tone: 'warn', message: BOARD_WORKS_COPY.noticeMovedEmptied(result.to.title, fromTitle) };
  }
  return {
    tone: 'success',
    message: BOARD_WORKS_COPY.noticeMoved(fromTitle, result.to.title),
    undo: {
      label: BOARD_WORKS_COPY.undo,
      run: async () => {
        await mutations.move(sessionId, { toWorkId: from.id });
      },
    },
  };
}

/**
 * Runs one resolved Works action and posts its notice (with undo when it can
 * honestly be undone). `title` is required for `create` / `moveToNew` — the
 * caller asks for it first. Rejections are reported as a warn notice rather
 * than thrown: the drop has already ended and nothing else would show it.
 */
export async function applyWorkDropAction({
  action,
  session,
  inboxSession,
  title,
  works,
  mutations,
}: {
  action: WorkDropAction;
  session: BoardSessionRef;
  /** Needed for `create` only (`createWorkFromSession`'s input). */
  inboxSession?: WorkInboxSession;
  title?: string;
  works: readonly Work[];
  mutations: BoardWorkMutations;
}): Promise<void> {
  const undoActions: WorkAssignUndoActions = {
    notify: mutations.notify,
    deleteWork: mutations.deleteWork,
    unlinkSession: async (workId, sessionId) => {
      await mutations.unlink(workId, sessionId);
    },
    // Never reached from the board: nothing here discards a session.
    restoreSession: async () => {},
  };

  try {
    switch (action.kind) {
      case 'link': {
        const work = await mutations.link(action.toWorkId, session);
        mutations.notify(noticeForLinkedSessions(work, [session.sessionId], undoActions));
        return;
      }
      case 'move': {
        const result = await mutations.move(session.sessionId, { toWorkId: action.toWorkId });
        mutations.notify(noticeForMove(result, session.sessionId, titleOf(works, action.fromWorkId), mutations));
        return;
      }
      case 'unlink': {
        const fromTitle = titleOf(works, action.fromWorkId);
        await mutations.unlink(action.fromWorkId, session.sessionId);
        mutations.notify({
          tone: 'success',
          message: BOARD_WORKS_COPY.noticeUnlinked(fromTitle),
          undo: {
            label: BOARD_WORKS_COPY.undo,
            run: async () => {
              await mutations.link(action.fromWorkId, session);
            },
          },
        });
        return;
      }
      case 'create': {
        if (!title || !inboxSession) return;
        const work = await mutations.createWithSession(inboxSession, title);
        mutations.notify(noticeForNewWork(work, 1, undoActions));
        return;
      }
      case 'moveToNew': {
        if (!title) return;
        const result = await mutations.moveToNewWork(session, title);
        mutations.notify(noticeForMove(result, session.sessionId, titleOf(works, action.fromWorkId), mutations));
        return;
      }
    }
  } catch (error: unknown) {
    mutations.notify({
      tone: 'warn',
      message: `⚠ ${error instanceof Error ? error.message : BOARD_WORKS_COPY.noticeFailed}`,
    });
  }
}
