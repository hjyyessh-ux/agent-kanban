import React, { useEffect, useMemo, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import type { QuestionRequest } from '../../../../src/plugin/question-monitor';
import { selectColumns } from './board-selectors';
import { BoardColumn } from './BoardColumn';
import type { CompleteSessionGroup } from './BoardCompleteSessionView';
import { BoardListView } from './BoardListView';
import type { BoardFilters } from './board-filters';
import { filterBoardCards } from './board-filters';
import '../../styles/kanban-v2.tokens.css';
import '../../styles/kanban-v2.components.css';

export interface BoardScreenProps {
  cards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onStatusChange: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onFavoriteToggle: (card: KanbanCard) => void;
  onArchive?: () => void;
  onCompleteAll?: () => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
  onQueueOpen?: (card: KanbanCard) => void;
  onUnqueue?: (card: KanbanCard) => void;
  onDelete?: (card: KanbanCard) => void;
  onArchiveCards?: (cards: KanbanCard[]) => void;
  onCreate?: () => void;
  onReorder?: (cardIds: string[]) => void;
  questions?: QuestionRequest[];
  viewMode?: 'board' | 'list';
  groupCompleteSessions?: boolean;
  filters: BoardFilters;
}

export const BoardScreen: React.FC<BoardScreenProps> = ({
  cards,
  onCardClick,
  onSessionOpen,
  onStatusChange,
  onFavoriteToggle,
  onDispatch,
  onQueueOpen,
  onUnqueue,
  onDelete,
  onArchiveCards,
  onArchive,
  onCompleteAll,
  onCreate,
  onReorder,
  questions,
  viewMode = 'board',
  groupCompleteSessions = false,
  filters,
}) => {
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(filters.search);
    }, 200);

    return () => {
      clearTimeout(timer);
    };
  }, [filters.search]);

  const effectiveFilters = useMemo(() => {
    return {
      ...filters,
      search: debouncedSearch,
    };
  }, [filters, debouncedSearch]);

  const filteredCards = useMemo(
    () => filterBoardCards(cards, effectiveFilters),
    [cards, effectiveFilters],
  );

  const columns = useMemo(
    () => selectColumns(filteredCards, questions),
    [filteredCards, questions],
  );

  return (
    <div className="kv2">
      {viewMode === 'board' ? (
        <div className="kv2-board">
          {columns.map((col) => (
            <BoardColumn
              key={col.status}
              column={col}
              allCards={filteredCards}
              onCardClick={onCardClick}
              onSessionOpen={onSessionOpen}
              onStatusChange={onStatusChange}
              onFavoriteToggle={onFavoriteToggle}
              onDispatch={onDispatch}
              onQueueOpen={onQueueOpen}
              onUnqueue={onUnqueue}
              onDelete={onDelete}
              onArchiveCards={onArchiveCards}
              onCreate={col.status === 'todo' ? onCreate : undefined}
              groupCompleteSessions={groupCompleteSessions}
              onCompleteAll={
                col.status === 'complete' ? onCompleteAll : undefined
              }
              onArchive={col.status === 'done' ? onArchive : undefined}
              onReorder={col.status === 'todo' ? onReorder : undefined}
            />
          ))}
        </div>
      ) : (
        <BoardListView
          columns={columns}
          allCards={filteredCards}
          onCardClick={onCardClick}
          onStatusChange={onStatusChange}
          onFavoriteToggle={onFavoriteToggle}
          onDispatch={onDispatch}
          onQueueOpen={onQueueOpen}
          onCreate={onCreate}
        />
      )}
    </div>
  );
};
