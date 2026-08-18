import React, { useMemo, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import type { V2ColumnViewModel } from './board-selectors';
import { selectCardById } from './board-selectors';
import { ExecutionTypeBadge, FavoriteToggleButton, OriginExecutionBadges, QueueTargetChip, ScheduledMetaBadge, SchedulerBadge } from './BoardCardSections';
import { BoardListRowAction } from './BoardListRowAction';

interface BoardListViewProps {
  columns: V2ColumnViewModel[];
  allCards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
  onStatusChange: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onFavoriteToggle: (card: KanbanCard) => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
  onQueueOpen?: (card: KanbanCard) => void;
  onCreate?: () => void;
}

const LIST_ORDER: KanbanStatus[] = [
  'done',
  'complete',
  'in_progress',
  'todo',
];

export function orderColumnsForList(
  columns: V2ColumnViewModel[],
): V2ColumnViewModel[] {
  const map = new Map(columns.map((column) => [column.status, column]));
  return LIST_ORDER.flatMap((status) => {
    const column = map.get(status);
    return column ? [column] : [];
  });
}

function formatCreatedTimestamp(iso: string): string {
  if (!iso) return '-';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const BoardListView: React.FC<BoardListViewProps> = ({
  columns,
  allCards,
  onCardClick,
  onStatusChange,
  onFavoriteToggle,
  onDispatch,
  onQueueOpen,
  onCreate,
}) => {
  const [collapsedByStatus, setCollapsedByStatus] = useState<
    Record<KanbanStatus, boolean>
  >({
    done: false,
    complete: false,
    in_progress: false,
    todo: false,
  });

  const orderedColumns = useMemo(() => {
    return orderColumnsForList(columns);
  }, [columns]);

  return (
    <div className="kv2-board-list">
      {orderedColumns.map((column) => {
        const isCollapsed = collapsedByStatus[column.status];

        return (
          <section
            key={column.status}
            className={`kv2-list-section${isCollapsed ? ' is-collapsed' : ''}`}
          >
            <div
              className="kv2-list-section-header"
              data-status={column.status}
              data-collapsed={isCollapsed ? 'true' : 'false'}
            >
              <button
                type="button"
                className="kv2-list-section-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => {
                  setCollapsedByStatus((previous) => ({
                    ...previous,
                    [column.status]: !previous[column.status],
                  }));
                }}
              >
                <span className="kv2-chevron" aria-hidden="true">
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span className="kv2-list-section-title">{column.label}</span>
                <span className="kv2-list-section-count">{column.count}</span>
              </button>
              <span className="kv2-list-section-spacer" aria-hidden="true" />
              {column.status === 'todo' && onCreate && (
                <span className="kv2-list-section-right">
                  <button
                    type="button"
                    className="kv2-create-btn kv2-list-create-btn"
                    onClick={onCreate}
                  >
                    + Add Task
                  </button>
                </span>
              )}
            </div>

            {isCollapsed ? (
              <div className="kv2-list-collapsed-summary">
                {column.count} items hidden
              </div>
            ) : (
              <>
                <div className="kv2-list-table-head">
                  <span>Fav</span>
                  <span>Title</span>
                  <span>Runtime</span>
                  <span>Action</span>
                  <span>Queue</span>
                  <span>Created</span>
                </div>
                {column.cards.length === 0 ? (
                  <div className="kv2-empty kv2-list-empty">No cards</div>
                ) : (
                  <div className="kv2-list-table-body">
                    {column.cards.map((vm) => {
                      const raw = selectCardById(allCards, vm.id);
                      if (!raw) return null;

                      return (
                        <div key={vm.id} className="kv2-list-table-row">
                          <span className="kv2-list-col-favorite">
                            <FavoriteToggleButton
                              active={vm.favorite}
                              onToggle={() => onFavoriteToggle(raw)}
                              className="kv2-favorite-toggle--list"
                            />
                          </span>
                          <span className="kv2-list-col-title">
                            <button
                              type="button"
                              className="kv2-list-title-open"
                              onClick={() => onCardClick(raw)}
                            >
                              {vm.hasUnreadCompletion && (
                                <span
                                  className="kv2-list-unread-dot"
                                  title="Unread completion"
                                  aria-label="Unread completion"
                                />
                              )}
                              <ScheduledMetaBadge vm={vm} />
                              {vm.originChannel === 'scheduler' && (
                                <SchedulerBadge title={vm.schedulerName ? `Scheduler origin · ${vm.schedulerName}` : 'Scheduler origin'} size={18} />
                              )}
                              <OriginExecutionBadges
                                originChannel={vm.originChannel}
                                quickActionId={vm.quickActionId}
                              />
                              {vm.title}
                            </button>
                            <span className="kv2-list-prompt-snippet" title={vm.boardSummary}>
                              {vm.boardSummary}
                            </span>
                          </span>
                          <span className="kv2-list-col-agent">
                            <ExecutionTypeBadge
                              runtime={vm.agentRuntime}
                              executionKind={vm.executionKind}
                              scriptName={vm.scriptName}
                            />
                          </span>
                          <span className="kv2-list-col-action">
                            <BoardListRowAction
                              card={raw}
                              onStatusChange={onStatusChange}
                              onDispatch={onDispatch}
                            />
                          </span>
                          <span className="kv2-list-col-queue">
                            <QueueTargetChip
                              queueTargetTitle={vm.queueTargetTitle}
                              queuedAfterCardId={vm.queuedAfterCardId}
                              queuePosition={vm.queuePosition}
                              queueSessionMode={vm.queueSessionMode}
                              onClick={onQueueOpen ? () => onQueueOpen(raw) : undefined}
                            />
                          </span>
                          <span className="kv2-list-col-created">
                            {formatCreatedTimestamp(vm.createdAt)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
};
