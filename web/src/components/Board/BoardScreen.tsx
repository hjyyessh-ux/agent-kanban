import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import type { QuestionRequest } from '../../../../src/plugin/question-monitor';
import { selectColumns } from './board-selectors';
import { BoardColumn } from './BoardColumn';
import type { CardRevealRequest, CompleteSessionGroup } from './BoardCompleteSessionView';
import { BoardListView, orderColumnsForList } from './BoardListView';
import type { BoardFilters } from './board-filters';
import { filterBoardCards, filterUnreadOnly } from './board-filters';
import { nextUnreadTarget, selectBoardNavOrder, type UnreadNavDirection } from './unread-navigation';

/** How long the jump's focus ring stays on the landed card. */
export const UNREAD_FOCUS_RING_MS = 1200;
/** Frames to wait for a just-expanded group / `Show N more` to render the target. */
const REVEAL_MAX_FRAMES = 10;

/** A `u` / `Shift+U` press. A new `token` is a new press. */
export interface UnreadJumpRequest {
  direction: UnreadNavDirection;
  token: number;
}

const CARD_FOCUS_SELECTOR = [
  '.kv2-complete-session-turn-body',
  '.kv2-card-click-layer',
  '.kv2-list-title-open',
].join(', ');

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  /** Toolbar `Unread only` — applied after `filters`; the Timeline never sees it. */
  unreadOnly?: boolean;
  /** Batch read stamp (column `Mark all read`). */
  onMarkCardsRead?: (cardIds: string[]) => void;
  unreadJumpRequest?: UnreadJumpRequest | null;
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
  unreadOnly = false,
  onMarkCardsRead,
  unreadJumpRequest,
}) => {
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const boardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // The list view never draws session groups, so "unread groups only" would
  // just be "unread cards" there anyway.
  const groupsCompleteBySession = viewMode === 'board' && groupCompleteSessions;
  const filteredCards = useMemo(() => {
    const filtered = filterBoardCards(cards, effectiveFilters);
    return unreadOnly ? filterUnreadOnly(filtered, { groupBySession: groupsCompleteBySession }) : filtered;
  }, [cards, effectiveFilters, unreadOnly, groupsCompleteBySession]);

  const columns = useMemo(
    () => selectColumns(filteredCards, questions),
    [filteredCards, questions],
  );

  const navOrder = useMemo(() => (
    viewMode === 'list'
      ? selectBoardNavOrder(orderColumnsForList(columns), filteredCards, { groupComplete: false, groupDone: false })
      : selectBoardNavOrder(columns, filteredCards, { groupComplete: groupCompleteSessions, groupDone: true })
  ), [columns, filteredCards, groupCompleteSessions, viewMode]);

  // The last card a jump landed on. A ref, not state: moving it must not
  // re-render the board, and the next jump only needs to read it.
  const unreadCursorRef = useRef<string | null>(null);
  const revealTokenRef = useRef(0);
  const [revealRequest, setRevealRequest] = useState<CardRevealRequest | null>(null);

  const jumpToUnread = useCallback((direction: UnreadNavDirection, status?: KanbanStatus) => {
    const target = nextUnreadTarget(navOrder, unreadCursorRef.current, direction, status);
    if (!target) return;
    unreadCursorRef.current = target.id;
    revealTokenRef.current += 1;
    setRevealRequest({
      cardId: target.id,
      status: target.status,
      groupKey: target.groupKey,
      token: revealTokenRef.current,
    });
  }, [navOrder]);

  const appliedJumpTokenRef = useRef(unreadJumpRequest?.token ?? 0);
  useEffect(() => {
    if (!unreadJumpRequest || unreadJumpRequest.token === appliedJumpTokenRef.current) return;
    appliedJumpTokenRef.current = unreadJumpRequest.token;
    jumpToUnread(unreadJumpRequest.direction);
  }, [jumpToUnread, unreadJumpRequest]);

  // Scroll + focus ring once the target is in the DOM. Expanding a group or
  // `Show N more` happens in the column's own effect, so wait a few frames for
  // that render rather than assuming it already landed.
  useEffect(() => {
    if (!revealRequest) return;
    let frame = 0;
    let rafId = 0;
    let ringTimer: number | undefined;
    let ringed: HTMLElement | null = null;
    const selector = `[data-card-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(revealRequest.cardId) : revealRequest.cardId}"]`;

    const land = () => {
      const target = containerRef.current?.querySelector<HTMLElement>(selector);
      if (!target) {
        frame += 1;
        if (frame < REVEAL_MAX_FRAMES) rafId = window.requestAnimationFrame(land);
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      target.querySelector<HTMLElement>(CARD_FOCUS_SELECTOR)?.focus({ preventScroll: true });
      target.classList.add('kv2-unread-focus');
      ringed = target;
      ringTimer = window.setTimeout(() => {
        target.classList.remove('kv2-unread-focus');
        ringed = null;
      }, UNREAD_FOCUS_RING_MS);
    };
    rafId = window.requestAnimationFrame(land);

    return () => {
      window.cancelAnimationFrame(rafId);
      if (ringTimer !== undefined) window.clearTimeout(ringTimer);
      ringed?.classList.remove('kv2-unread-focus');
    };
  }, [revealRequest]);

  return (
    <div ref={containerRef}>
      {viewMode === 'board' ? (
        <>
          <nav className="kv2-board-mobile-nav" aria-label="Board status sections">
            {columns.map((column) => (
              <button
                key={column.status}
                type="button"
                className="kv2-board-mobile-nav-btn"
                data-status={column.status}
                onClick={() => {
                  boardRef.current
                    ?.querySelector<HTMLElement>(`.kv2-column[data-status="${column.status}"]`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {column.label} <span>{column.count}</span>
              </button>
            ))}
          </nav>
          <div className="kv2-board" ref={boardRef}>
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
                onMarkCardsRead={onMarkCardsRead}
                onUnreadJump={col.status === 'complete' ? () => jumpToUnread('next', 'complete') : undefined}
                revealRequest={revealRequest?.status === col.status ? revealRequest : null}
              />
            ))}
          </div>
        </>
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
          revealRequest={revealRequest}
        />
      )}
    </div>
  );
};
