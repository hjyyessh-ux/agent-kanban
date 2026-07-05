import React, { useCallback, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import { BoardColumnHeader } from './BoardColumnHeader';
import { selectCardById } from './board-selectors';
import type { V2ColumnViewModel } from './board-selectors';
import { BoardCard, STATUS_ACCENT } from './BoardCard';
import { BoardCompleteSessionView } from './BoardCompleteSessionView';
import type { CompleteSessionGroup } from './BoardCompleteSessionView';

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
  groupCompleteSessions?: boolean;
  onArchiveCards?: (cards: KanbanCard[]) => void;
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
  groupCompleteSessions = false,
  onArchiveCards,
}) => {
  const { status, cards } = column;
  const isDndEnabled = !!onReorder;
  const [hideAllSessionGroupsToken, setHideAllSessionGroupsToken] = useState(0);
  const [completeSessionsCollapsed, setCompleteSessionsCollapsed] = useState(false);
  const sessionViewCards = cards
    .map((vm) => selectCardById(allCards, vm.id))
    .filter((card): card is KanbanCard => !!card);

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
        actionableCount={
          status === 'complete' || status === 'done'
            ? cards.filter((card) => !card.favorite).length
            : undefined
        }
        onCompleteAll={onCompleteAll}
        onHideAllSessions={
          status === 'complete' && groupCompleteSessions && sessionViewCards.length > 0
            ? () => {
                setCompleteSessionsCollapsed(true);
                setHideAllSessionGroupsToken((previous) => previous + 1);
              }
            : undefined
        }
        hideAllSessionsLabel={completeSessionsCollapsed ? 'Collapse All' : 'Hide All'}
        onArchive={onArchive}
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
        {(status === 'complete' && groupCompleteSessions) || status === 'done' ? (
          <BoardCompleteSessionView
            cards={sessionViewCards}
            status={status === 'done' ? 'done' : 'complete'}
            defaultCollapsed={status === 'done'}
            hideAllToken={status === 'complete' ? hideAllSessionGroupsToken : undefined}
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
            return (
              <div
                key={vm.id}
                className="kv2-card-wrapper"
                style={{ '--kv2-status-line': STATUS_ACCENT[vm.status] } as React.CSSProperties}
              >
                <BoardCard
                  vm={vm}
                  draggable={isDndEnabled}
                  onDragStart={makeDragStart(vm.id)}
                  onDragEnd={handleDragEnd}
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
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
