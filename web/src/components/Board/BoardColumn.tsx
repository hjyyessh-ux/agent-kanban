import React, { useCallback, useState } from 'react';
import type { KanbanCard, KanbanStatus, Work } from '../../../../src/core/types';
import { BoardColumnHeader } from './BoardColumnHeader';
import { selectCardById } from './board-selectors';
import type { V2ColumnViewModel } from './board-selectors';
import { BoardCard, STATUS_ACCENT } from './BoardCard';
import { BoardCompleteSessionView } from './BoardCompleteSessionView';
import type { CardRevealRequest, CompleteSessionGroup } from './BoardCompleteSessionView';
import { isUnreadCompletion } from './board-selectors';
import { groupsCompleteBySession, type BoardGroupMode } from './board-group-mode';
import { BoardWorkContainer } from './BoardWorkContainer';
import { workForCard, type WorkDragSource, type WorksColumnModel } from './board-works';
import { useBoardWorkDnD, workDropTargetProps, writeWorkDragData } from './board-work-dnd';
import type { WorkDetailIntent } from '../Works/WorkDetailDialog';
import { BOARD_WORKS_COPY, COLUMN_MENU_COPY } from '../../constants/copy';

/* ── DnD helpers ──────────────────────────────────────────── */

function getDragAfterElement(
  container: HTMLElement,
  y: number,
): Element | null {
  const draggables = [
    ...container.querySelectorAll('.kv2-card:not(.kv2-card--dragging)'),
  ];

  return draggables.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null as Element | null },
  ).element;
}

/* ── Column component ─────────────────────────────────────── */

interface BoardColumnProps {
  column: V2ColumnViewModel;
  allCards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onCreate?: () => void;
  onCompleteAll?: () => void;
  onArchive?: () => void;
  onReorder?: (cardIds: string[]) => void;
  onStatusChange?: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onFavoriteToggle?: (card: KanbanCard) => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
  onQueueOpen?: (card: KanbanCard) => void;
  onUnqueue?: (card: KanbanCard) => void;
  onDelete?: (card: KanbanCard) => void;
  groupMode?: BoardGroupMode;
  onArchiveCards?: (cards: KanbanCard[]) => void;
  /** Batch read stamp for the column's `Mark all read`. */
  onMarkCardsRead?: (cardIds: string[]) => void;
  /** The column `● N` pill: jump to this column's next unread card. */
  onUnreadJump?: () => void;
  revealRequest?: CardRevealRequest | null;
  /**
   * `GROUP: WORKS` (board-works.ts `selectWorkFragments`, this column's slice).
   * A session-grouped column draws its Work fragments, then the UNASSIGNED
   * zone; a flat column tags each card with its Work via `worksIndex`.
   */
  worksColumn?: WorksColumnModel;
  worksIndex?: Map<string, Work>;
  onWorkOpen?: (workId: string, intent?: WorkDetailIntent) => void;
}

export const BoardColumn: React.FC<BoardColumnProps> = ({
  column,
  allCards,
  onCardClick,
  onSessionOpen,
  onCreate,
  onCompleteAll,
  onArchive,
  onReorder,
  onStatusChange,
  onFavoriteToggle,
  onDispatch,
  onQueueOpen,
  onUnqueue,
  onDelete,
  groupMode = 'card',
  onArchiveCards,
  onMarkCardsRead,
  onUnreadJump,
  revealRequest,
  worksColumn,
  worksIndex,
  onWorkOpen,
}) => {
  const { status, cards } = column;
  const groupComplete = groupsCompleteBySession(groupMode);
  const isDndEnabled = !!onReorder;
  const [hideAllSessionGroupsToken, setHideAllSessionGroupsToken] = useState(0);
  const [completeSessionsCollapsed, setCompleteSessionsCollapsed] = useState(false);
  const sessionViewCards = cards
    .map((vm) => selectCardById(allCards, vm.id))
    .filter((card): card is KanbanCard => !!card);

  const sessionGrouped = (status === 'complete' && groupComplete) || status === 'done';
  const dnd = useBoardWorkDnD();
  // Same-column UNASSIGNED zone = `⊘ Work에서 빼기` for a session dragged out of a Work here.
  const unassignDropProps = workDropTargetProps(dnd, { kind: 'unassigned', status });
  const unassignOk = !!unassignDropProps.onDrop;
  const sessionStatus = status === 'done' ? 'done' : 'complete';

  /* ── DnD handlers (only active on todo column) ───────── */

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDndEnabled) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const body = e.currentTarget as HTMLElement;
      const afterElement = getDragAfterElement(body, e.clientY);

      const existing = body.querySelector('.kv2-drop-indicator');
      if (existing) existing.remove();

      const indicator = document.createElement('div');
      indicator.className = 'kv2-drop-indicator';

      if (afterElement == null) {
        body.appendChild(indicator);
      } else {
        body.insertBefore(indicator, afterElement);
      }
    },
    [isDndEnabled],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!isDndEnabled) return;
      const related = e.relatedTarget as HTMLElement;
      if (related && !e.currentTarget.contains(related)) {
        const indicator = (e.currentTarget as HTMLElement).querySelector(
          '.kv2-drop-indicator',
        );
        if (indicator) indicator.remove();
      }
    },
    [isDndEnabled],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!onReorder) return;
      e.preventDefault();

      const body = e.currentTarget as HTMLElement;
      const draggedCardId = e.dataTransfer.getData('text/plain');

      const indicator = body.querySelector('.kv2-drop-indicator');
      if (indicator) indicator.remove();

      const afterElement = getDragAfterElement(body, e.clientY);

      const currentIds = cards.map((c) => c.id);
      const dragIdx = currentIds.indexOf(draggedCardId);
      if (dragIdx === -1) return;

      const newIds = [...currentIds];
      newIds.splice(dragIdx, 1);

      if (afterElement == null) {
        newIds.push(draggedCardId);
      } else {
        const afterId = afterElement.getAttribute('data-id');
        if (afterId) {
          const afterIdx = newIds.indexOf(afterId);
          newIds.splice(afterIdx, 0, draggedCardId);
        }
      }

      onReorder(newIds);
    },
    [onReorder, cards],
  );

  /* ── Per-card drag handlers ─────────────────────────── */

  const makeDragStart = useCallback(
    (cardId: string) => (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', cardId);
      e.dataTransfer.effectAllowed = 'move';
      (e.target as HTMLElement)
        .closest('.kv2-card')
        ?.classList.add('kv2-card--dragging');
    },
    [],
  );

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement)
      .closest('.kv2-card')
      ?.classList.remove('kv2-card--dragging');
    document.querySelectorAll('.kv2-drop-indicator').forEach((el) => { el.remove(); });
  }, []);

  return (
    <div className="kv2-column" data-status={status}>
      <BoardColumnHeader
        status={status}
        label={column.label}
        count={column.count}
        unreadCount={column.unreadCount}
        actionableCount={
          status === 'complete' || status === 'done'
            ? cards.filter((card) => !card.favorite).length
            : undefined
        }
        onCompleteAll={onCompleteAll}
        onUnreadJump={status === 'complete' ? onUnreadJump : undefined}
        onMarkAllRead={
          status === 'complete' && onMarkCardsRead
            ? () => {
                // `allCards` is the filtered board, so this reads exactly what
                // the column is showing — children included, done untouched.
                const unreadIds = allCards
                  .filter((card) => card.status === 'complete' && isUnreadCompletion(card))
                  .map((card) => card.id);
                if (unreadIds.length > 0) onMarkCardsRead(unreadIds);
              }
            : undefined
        }
        onHideAllSessions={
          status === 'complete' && groupComplete && sessionViewCards.length > 0
            ? () => {
                setCompleteSessionsCollapsed(true);
                setHideAllSessionGroupsToken((previous) => previous + 1);
              }
            : undefined
        }
        hideAllSessionsLabel={completeSessionsCollapsed ? COLUMN_MENU_COPY.collapseAll : COLUMN_MENU_COPY.hideAll}
        onArchive={onArchive}
        workCount={sessionGrouped ? worksColumn?.fragments.length : undefined}
      />
      {status === 'todo' && onCreate && (
        <button
          type="button"
          className="kv2-create-btn"
          onClick={onCreate}
          aria-label="Create new card"
        >
          ＋ New Task
        </button>
      )}
      <div
        className="kv2-column-body"
        onDragOver={isDndEnabled ? handleDragOver : undefined}
        onDragLeave={isDndEnabled ? handleDragLeave : undefined}
        onDrop={isDndEnabled ? handleDrop : undefined}
        role="listbox"
        aria-label={`${column.label} cards`}
      >
        {sessionGrouped && worksColumn ? (
          <div className="kv2-works-column">
            {worksColumn.fragments.map((fragment) => (
              <BoardWorkContainer
                key={fragment.work.id}
                fragment={fragment}
                status={sessionStatus}
                hideAllToken={status === 'complete' ? hideAllSessionGroupsToken : undefined}
                revealRequest={revealRequest}
                onWorkOpen={onWorkOpen}
                onCardClick={onCardClick}
                onSessionOpen={onSessionOpen}
                onFavoriteToggle={onFavoriteToggle}
                onStatusChange={onStatusChange}
                onArchiveCards={onArchiveCards}
              />
            ))}
            <div className="kv2-works-unassigned-head">
              <span>{BOARD_WORKS_COPY.unassignedHeading}</span>
              <span className="kv2-works-unassigned-count">{worksColumn.unassigned.length}</span>
            </div>
            <div
              className={`kv2-works-unassigned${unassignOk ? ' is-drop-target' : ''}`}
              data-status={status}
              {...unassignDropProps}
            >
              {unassignOk && (
                <div className="kv2-works-unassign-hint" aria-hidden="true">{BOARD_WORKS_COPY.unassignHint}</div>
              )}
              {worksColumn.unassigned.length > 0 ? (
                <BoardCompleteSessionView
                  cards={[]}
                  groups={worksColumn.unassigned}
                  status={sessionStatus}
                  defaultCollapsed={status === 'done'}
                  hideAllToken={status === 'complete' ? hideAllSessionGroupsToken : undefined}
                  revealRequest={revealRequest}
                  onCardClick={onCardClick}
                  onSessionOpen={onSessionOpen}
                  onFavoriteToggle={onFavoriteToggle}
                  onStatusChange={onStatusChange}
                  onArchiveCards={onArchiveCards}
                />
              ) : (
                <div className="kv2-works-unassigned-empty">{BOARD_WORKS_COPY.unassignedEmpty}</div>
              )}
            </div>
          </div>
        ) : sessionGrouped ? (
          <BoardCompleteSessionView
            cards={sessionViewCards}
            status={sessionStatus}
            defaultCollapsed={status === 'done'}
            hideAllToken={status === 'complete' ? hideAllSessionGroupsToken : undefined}
            revealRequest={revealRequest}
            onCardClick={onCardClick}
            onSessionOpen={onSessionOpen}
            onFavoriteToggle={onFavoriteToggle}
            onStatusChange={onStatusChange}
            onArchiveCards={onArchiveCards}
          />
        ) : cards.length === 0 ? (
          <div className="kv2-empty">No cards</div>
        ) : (
          cards.map((vm) => {
            const raw = selectCardById(allCards, vm.id);
            const work = worksIndex && raw ? workForCard(raw, worksIndex) ?? null : undefined;
            // Works mode: every flat card is a drag source too (todo keeps its
            // reorder payload — `text/plain` is the same cardId either way).
            const workSource: WorkDragSource | undefined = dnd && raw
              ? {
                  cardId: raw.id,
                  sessionId: raw.sessionId,
                  workId: work?.id,
                  status,
                  projectDir: raw.projectDir,
                  title: raw.sessionTitle ?? raw.title,
                }
              : undefined;
            return (
              <div
                key={vm.id}
                data-card-id={vm.id}
                data-work-id={work?.id}
                data-work-status={work ? status : undefined}
                className="kv2-card-wrapper"
                style={{ '--kv2-status-line': STATUS_ACCENT[vm.status] } as React.CSSProperties}
              >
                <BoardCard
                  vm={vm}
                  draggable={isDndEnabled || !!workSource}
                  onDragStart={(event) => {
                    if (isDndEnabled) makeDragStart(vm.id)(event);
                    if (workSource && dnd) {
                      writeWorkDragData(event.dataTransfer, workSource);
                      dnd.startDrag(workSource);
                    }
                  }}
                  onDragEnd={(event) => {
                    handleDragEnd(event);
                    dnd?.endDrag();
                  }}
                  workMoveSource={workSource}
                  onClick={() => { if (raw) onCardClick(raw); }}
                  onStatusChange={
                    raw && onStatusChange
                      ? (newStatus) => onStatusChange(raw, newStatus)
                      : undefined
                  }
                  onDispatch={
                    raw && onDispatch ? () => onDispatch(raw) : undefined
                  }
                  onQueueOpen={
                    raw && onQueueOpen ? () => onQueueOpen(raw) : undefined
                  }
                  onUnqueue={
                    raw && onUnqueue ? () => onUnqueue(raw) : undefined
                  }
                  onDelete={
                    raw && onDelete ? () => onDelete(raw) : undefined
                  }
                  onFavoriteToggle={
                    raw && onFavoriteToggle ? () => onFavoriteToggle(raw) : undefined
                  }
                  workTag={work === undefined ? undefined : { work, onOpen: onWorkOpen }}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
