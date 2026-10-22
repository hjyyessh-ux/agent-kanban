import React from 'react';
import type { KanbanStatus } from '../../../../src/core/types';
import { BoardColumnMenu, type BoardColumnMenuItem } from './BoardColumnMenu';
import { BOARD_WORKS_COPY, COLUMN_MENU_COPY } from '../../constants/copy';

const WIP_LIMIT = 3;

interface BoardColumnHeaderProps {
  status: KanbanStatus;
  label: string;
  count: number;
  actionableCount?: number;
  /** Unread completions in this column — shown as `● N` on the complete column. */
  unreadCount?: number;
  hideAllSessionsLabel?: string;
  onHideAllSessions?: () => void;
  /** Stamp every unread completion in the column as seen — no status change. */
  onMarkAllRead?: () => void;
  /** Jump to the column's next unread card (the `● N` pill). */
  onUnreadJump?: () => void;
  onCompleteAll?: () => void;
  onArchive?: () => void;
  /** `GROUP: WORKS`: Work fragments drawn in this column (`WORK n`, right side). */
  workCount?: number;
  /** Whether the column's last bulk Work command folded them — picks the toggle's label. */
  worksCollapsed?: boolean;
  onToggleWorksCollapsed?: () => void;
}

type ColumnMenuInput = Pick<
  BoardColumnHeaderProps,
  | 'status' | 'count' | 'actionableCount' | 'unreadCount' | 'hideAllSessionsLabel'
  | 'onHideAllSessions' | 'onMarkAllRead' | 'onCompleteAll' | 'onArchive'
  | 'workCount' | 'worksCollapsed' | 'onToggleWorksCollapsed'
>;

/**
 * The bulk actions folded into the header's `⋯` menu. Each handler is wrapped
 * so a menu click never forwards its event into an action that takes no
 * arguments.
 */
export function getColumnMenuItems({
  status,
  count,
  actionableCount,
  unreadCount = 0,
  hideAllSessionsLabel = COLUMN_MENU_COPY.hideAll,
  onHideAllSessions,
  onMarkAllRead,
  onCompleteAll,
  onArchive,
  workCount = 0,
  worksCollapsed = false,
  onToggleWorksCollapsed,
}: ColumnMenuInput): BoardColumnMenuItem[] {
  const bulkActionCount = actionableCount ?? count;
  const items: BoardColumnMenuItem[] = [];

  if ((status === 'complete' || status === 'done') && onToggleWorksCollapsed && workCount > 0) {
    items.push({
      id: 'toggle-works',
      label: worksCollapsed ? COLUMN_MENU_COPY.expandWorks : COLUMN_MENU_COPY.collapseWorks,
      onSelect: () => onToggleWorksCollapsed(),
    });
  }

  if (status === 'complete' && onHideAllSessions && count > 0) {
    items.push({ id: 'hide-all', label: hideAllSessionsLabel, onSelect: () => onHideAllSessions() });
  }
  // Read, not Done: the cards stay in Complete — only the unread signal clears.
  if (status === 'complete' && onMarkAllRead && unreadCount > 0) {
    items.push({ id: 'mark-all-read', label: COLUMN_MENU_COPY.markAllRead, onSelect: () => onMarkAllRead() });
  }
  if (status === 'complete' && onCompleteAll && bulkActionCount > 0) {
    items.push({ id: 'done-all', label: COLUMN_MENU_COPY.doneAll, onSelect: () => onCompleteAll() });
  }
  if (status === 'done' && onArchive && bulkActionCount > 0) {
    items.push({ id: 'archive-all', label: COLUMN_MENU_COPY.archiveAll, onSelect: () => onArchive() });
  }

  return items;
}

export const BoardColumnHeader: React.FC<BoardColumnHeaderProps> = ({
  status,
  label,
  count,
  actionableCount,
  unreadCount = 0,
  hideAllSessionsLabel,
  onHideAllSessions,
  onMarkAllRead,
  onUnreadJump,
  onCompleteAll,
  onArchive,
  workCount = 0,
  worksCollapsed,
  onToggleWorksCollapsed,
}) => {
  const isWipOver = status === 'in_progress' && count > WIP_LIMIT;
  const isWipWarning = status === 'in_progress' && count === WIP_LIMIT;
  const menuItems = getColumnMenuItems({
    status,
    count,
    actionableCount,
    unreadCount,
    hideAllSessionsLabel,
    onHideAllSessions,
    onMarkAllRead,
    onCompleteAll,
    onArchive,
    workCount,
    worksCollapsed,
    onToggleWorksCollapsed,
  });

  return (
    <div className="kv2-column-header" data-status={status}>
      <div className="kv2-column-header-left">
        <span className="kv2-column-label">{label}</span>
        <span className="kv2-column-count">{count}</span>
        {status === 'complete' && unreadCount > 0 && (onUnreadJump ? (
          <button
            type="button"
            className="kv2-column-unread kv2-column-unread--jump"
            aria-label={`${unreadCount} unread — jump to next`}
            title={`${unreadCount} unread · 클릭하면 다음 unread로 이동`}
            onClick={() => onUnreadJump()}
          >
            {unreadCount}
          </button>
        ) : (
          <span
            className="kv2-column-unread"
            aria-label={`${unreadCount} unread`}
            title={`${unreadCount} unread`}
          >
            {unreadCount}
          </span>
        ))}
        {status === 'in_progress' && (
          <span
            className={`kv2-wip${isWipOver ? ' kv2-wip--over' : isWipWarning ? ' kv2-wip--warning' : ''}`}
          >
            {count}/{WIP_LIMIT}
          </span>
        )}
      </div>
      {(menuItems.length > 0 || workCount > 0) && (
        <div className="kv2-column-header-right">
          {workCount > 0 && (
            <span className="kv2-column-work-count">{BOARD_WORKS_COPY.columnWorkCount(workCount)}</span>
          )}
          {menuItems.length > 0 && <BoardColumnMenu columnLabel={label} items={menuItems} />}
        </div>
      )}
    </div>
  );
};
