import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import { groupCompleteCardsBySession } from './BoardCompleteSessionView';
import { isUnreadCompletion, selectCardById } from './board-selectors';
import type { V2ColumnViewModel } from './board-selectors';

/** One card in the order the board draws it, as far as unread jumps care. */
export interface UnreadNavEntry {
  id: string;
  status: KanbanStatus;
  unread: boolean;
  /** Set when the card sits inside a session group that may need expanding first. */
  groupKey?: string;
}

/** Which columns the current layout draws as session groups. */
export interface BoardNavLayout {
  groupComplete: boolean;
  groupDone: boolean;
}

export type UnreadNavDirection = 'next' | 'prev';

/**
 * Every rendered card, in reading order: `columns` in the order given (the
 * board's left-to-right, or `orderColumnsForList` for the list), then the
 * order each column draws them. A session-grouped column (board: `complete`
 * with Session 모아보기, `done` always; list: none) walks its groups
 * newest-first and each group's turns newest-first — the default the per-group
 * sort toggle starts from. Read cards stay in the list so a cursor whose card
 * was just read still has a position to move on from.
 */
export function selectBoardNavOrder(
  columns: readonly V2ColumnViewModel[],
  allCards: KanbanCard[],
  layout: BoardNavLayout,
): UnreadNavEntry[] {
  const entries: UnreadNavEntry[] = [];

  for (const column of columns) {
    const grouped = (column.status === 'done' && layout.groupDone)
      || (column.status === 'complete' && layout.groupComplete);
    if (!grouped) {
      for (const vm of column.cards) {
        entries.push({ id: vm.id, status: column.status, unread: vm.hasUnreadCompletion });
      }
      continue;
    }

    const rawCards = column.cards
      .map((vm) => selectCardById(allCards, vm.id))
      .filter((card): card is KanbanCard => !!card);
    for (const group of groupCompleteCardsBySession(rawCards)) {
      for (const card of group.cards) {
        entries.push({ id: card.id, status: column.status, unread: isUnreadCompletion(card), groupKey: group.key });
      }
    }
  }

  return entries;
}

/**
 * The next (or previous) unread card from `cursorId`, wrapping around the
 * board. With `status`, only that column's cards count — the column `● N`
 * pill. A cursor that is gone from the board starts from the edge in the
 * direction of travel; the cursor itself is returned only when it is the one
 * unread card left.
 */
export function nextUnreadTarget(
  entries: readonly UnreadNavEntry[],
  cursorId: string | null,
  direction: UnreadNavDirection,
  status?: KanbanStatus,
): UnreadNavEntry | null {
  const total = entries.length;
  if (total === 0) return null;

  const step = direction === 'next' ? 1 : -1;
  const cursorIndex = cursorId ? entries.findIndex((entry) => entry.id === cursorId) : -1;
  const start = cursorIndex !== -1 ? cursorIndex : direction === 'next' ? -1 : total;

  for (let offset = 1; offset <= total; offset += 1) {
    const index = (((start + step * offset) % total) + total) % total;
    const entry = entries[index];
    if (entry.unread && (!status || entry.status === status)) return entry;
  }
  return null;
}

type ShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
} | null;

/** True while the user is typing — a bare `u` then belongs to the field, not the board. */
export function isTypingTarget(target: ShortcutTarget): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
