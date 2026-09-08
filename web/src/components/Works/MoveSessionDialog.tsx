import { useState } from 'react';
import type {
  KanbanCard,
  Work,
  WorkSessionLink,
  WorkSessionRole,
} from '../../../../src/core/types';
import { resolveWorkStartedAt } from '../../../../src/plugin/works/work-lifecycle';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { WorkAssignInline, type AssignSelection } from './WorkAssignInline';
import { formatShortDate, inboxSessionFromLink } from './worksAssign';
import './Works.css';

interface MoveSessionDialogProps {
  link: WorkSessionLink;
  /** The Work the session currently belongs to. */
  fromWork: Work;
  works: Work[];
  /** Board cards — the same input the server derives `startedAt` from. */
  cards: KanbanCard[];
  onClose: () => void;
  /** Move to an existing Work. Rejects with the server's message on 409. */
  onMove: (toWorkId: string, role?: WorkSessionRole) => Promise<void>;
  /** Split the session out into a new Work (create + move). */
  onMoveToNewWork: (title: string, role?: WorkSessionRole) => Promise<void>;
  /** ⤺ Inbox로 되돌리기 — unlink, leaving the session unassigned. */
  onUnlink: () => Promise<void>;
}

/**
 * "이 세션을 어디로 옮길까" — the assignment panel (`WorkAssignInline`) inside a
 * dialog, so a move reuses the Inbox recommendation ranking, the title
 * suggestion, and the role selector rather than growing a parallel picker.
 *
 * What it adds on top is the impact preview: a move silently re-dates both
 * Works' Timeline bars and deletes a source Work that loses its last session, so
 * those consequences are spelled out above the confirm button. The preview runs
 * the server's own `resolveWorkStartedAt` over the board cards with the pending
 * link change projected in — same function, same rule, no second implementation
 * to drift.
 */
export function MoveSessionDialog({
  link,
  fromWork,
  works,
  cards,
  onClose,
  onMove,
  onMoveToNewWork,
  onUnlink,
}: MoveSessionDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const session = inboxSessionFromLink(link, cards);

  const remainingLinks = fromWork.sessionLinks.filter(
    (l) => l.sessionId !== link.sessionId,
  );
  const emptiesSource = remainingLinks.length === 0;

  /** `startedAt` a Work would end up with, given the link set it would have. */
  const startedAtWith = (work: Work, sessionLinks: WorkSessionLink[]): string =>
    resolveWorkStartedAt(cards, { ...work, sessionLinks });

  const renderPreview = (selection: AssignSelection) => {
    const lines: string[] = [];

    if (emptiesSource) {
      lines.push(`마지막 세션이므로 "${fromWork.title}" Work는 삭제됩니다.`);
      if (fromWork.summary) lines.push('이 Work의 Summary도 함께 사라집니다.');
    } else {
      const next = startedAtWith(fromWork, remainingLinks);
      if (formatShortDate(next) !== formatShortDate(fromWork.startedAt)) {
        lines.push(
          `이동 후 "${fromWork.title}"의 시작일이 ${formatShortDate(fromWork.startedAt)} → ${formatShortDate(next)}로 조정됩니다.`,
        );
      }
    }

    const target = selection.mode === 'existing' && selection.workId
      ? works.find((work) => work.id === selection.workId)
      : undefined;
    if (target) {
      const next = startedAtWith(target, [...target.sessionLinks, link]);
      if (formatShortDate(next) !== formatShortDate(target.startedAt)) {
        lines.push(
          `이동 후 "${target.title}"의 시작일이 ${formatShortDate(target.startedAt)} → ${formatShortDate(next)}로 조정됩니다.`,
        );
      }
    }

    if (lines.length === 0) return null;
    return (
      <ul className="works-move-preview">
        {lines.map((line) => (
          <li key={line}>ℹ {line}</li>
        ))}
      </ul>
    );
  };

  // A rejected move keeps the dialog open with the server's reason — the most
  // likely one is a 409 from the target being completed while this was open.
  const attempt = <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      setError(null);
      try {
        await action(...args);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '세션을 옮기지 못했습니다');
      }
    };

  // Rendered *inside* the Work detail dialog, so this dialog is nested in the
  // parent's DOM rather than portalled out of it. Escape needs no special
  // handling: `DialogSkeleton` stops the key on its own `.kv2-dialog`, so it
  // never reaches the parent's window-level handler and only this dialog closes.
  //
  // Do **not** read that as "the parent's focus trap contains it". It does not,
  // for either dialog: `useModalAccessibility` listens on `window` in the
  // *bubble* phase, and `DialogSkeleton`'s own `onKeyDown` calls
  // `stopPropagation()` on every key that is not Escape — React forwards that to
  // the native event, so Tab never reaches the trap. `BulkAssignModal` knows
  // this and registers its shortcuts with `capture: true` instead. Fixing the
  // trap means moving `useModalAccessibility` to the capture phase, which is an
  // app-wide change to every dialog, not a Works one.
  return (
    <DialogSkeleton
      title="세션 이동"
      onClose={onClose}
      width="640px"
      className="work-move-dialog"
    >
      <div className="work-move-body">
        <WorkAssignInline
          session={session}
          works={works}
          initialRole={link.role}
          move={{ currentWork: fromWork, renderPreview }}
          onCancel={onClose}
          onCreateWork={attempt((title, role) => onMoveToNewWork(title, role))}
          onLinkToWork={attempt((workId, role) => onMove(workId, role))}
          // Left, like the Inbox panel's 무시 — but not destructive (the
          // session returns to the Inbox), so it keeps the outline variant.
          secondary={{ label: '⤺ Inbox로 되돌리기', run: attempt(onUnlink), tone: 'neutral' }}
        />
        {error && <p className="work-move-error">⚠ {error}</p>}
      </div>
    </DialogSkeleton>
  );
}
