import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRuntime, CardExecutionKind, KanbanCard, KanbanStatus } from '../../../../src/core/types';
import { ExecutionTypeBadge, FavoriteToggleButton } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { countUnread, isUnreadCompletion } from './board-selectors';
import { stripFeedbackHeader } from '../../../../src/core/mention-search';
import { splitCardResult } from '../Card/card-result';
import { buildResumeCommand } from '../../utils/resume-command';
import { dirAccentClass } from '../../utils/project-color';
import { IdChip, ResumeCopyButton } from '../shared/IdChip';
import { BOARD_GROUP_COPY, BOARD_WORKS_COPY, CARD_ACTION_COPY } from '../../constants/copy';
import { summarizeGroupFavorites, type WorkDragSource } from './board-works';
import { useBoardWorkDnD, writeWorkDragData } from './board-work-dnd';
import { BoardWorkMoveMenu } from './BoardWorkMoveMenu';

// A long-running session runs to 20+ turns; only the newest few are usually wanted.
const INITIAL_VISIBLE_TURNS = 5;

export type SessionViewStatus = 'complete' | 'done';

/**
 * "Make this card visible": expand its group and, when it is one of the folded
 * older turns, `Show N more`. A new `token` re-applies it even for the same
 * card (the user collapsed the group again and jumped back).
 */
export interface CardRevealRequest {
  cardId: string;
  /** Column the card sits in — the list view un-collapses that section. */
  status: KanbanStatus;
  groupKey?: string;
  token: number;
}

interface BoardCompleteSessionViewProps {
  cards: KanbanCard[];
  /** Pre-built groups (a Works column's UNASSIGNED zone); otherwise built from `cards`. */
  groups?: CompleteSessionGroup[];
  status: SessionViewStatus;
  defaultCollapsed?: boolean;
  hideAllToken?: number;
  revealRequest?: CardRevealRequest | null;
  onCardClick: (card: KanbanCard) => void;
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onFavoriteToggle?: (card: KanbanCard) => void;
  onStatusChange?: (card: KanbanCard, status: 'done') => void;
  onArchiveCards?: (cards: KanbanCard[]) => void;
}

export interface CompleteSessionGroup {
  key: string;
  sessionId: string | undefined;
  title: string;
  agentRuntime: AgentRuntime | undefined;
  executionKind: CardExecutionKind | undefined;
  scriptName: string | undefined;
  projectDir: string | undefined;
  startedAt: string;
  lastUpdatedAt: string;
  cards: KanbanCard[];
  unreadCount: number;
}

function getTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getResponseSortTimestamp(card: KanbanCard): string | undefined {
  return card.responseAt ?? card.completedAt ?? card.updatedAt;
}

function compareNewestCardFirst(a: KanbanCard, b: KanbanCard): number {
  const responseDiff = getTimestampMs(getResponseSortTimestamp(b)) - getTimestampMs(getResponseSortTimestamp(a));
  if (responseDiff !== 0) return responseDiff;

  const createdDiff = getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt);
  if (createdDiff !== 0) return createdDiff;

  return b.id.localeCompare(a.id);
}

function compareNewestGroupFirst(a: CompleteSessionGroup, b: CompleteSessionGroup): number {
  const updatedDiff = getTimestampMs(b.lastUpdatedAt) - getTimestampMs(a.lastUpdatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return b.key.localeCompare(a.key);
}

function compareOldestCardFirst(a: KanbanCard, b: KanbanCard): number {
  const createdDiff = getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt);
  if (createdDiff !== 0) return createdDiff;

  const updatedDiff = getTimestampMs(a.updatedAt) - getTimestampMs(b.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return a.id.localeCompare(b.id);
}

function getGroupKey(card: KanbanCard): string {
  return card.sessionId ? `session:${card.sessionId}` : `card:${card.id}`;
}

function getSessionTitle(cards: KanbanCard[]): string {
  if (cards.length === 1 && !cards[0].sessionId) return 'No session';

  const firstCard = [...cards].sort(compareOldestCardFirst)[0];
  const firstTitle = firstCard?.title?.trim();
  if (firstTitle) return firstTitle;

  const titledCard = cards.find((card) => card.sessionTitle?.trim());
  if (titledCard?.sessionTitle) return titledCard.sessionTitle;

  return 'Untitled session';
}

export function groupCompleteCardsBySession(cards: KanbanCard[]): CompleteSessionGroup[] {
  const buckets = new Map<string, KanbanCard[]>();

  for (const card of cards) {
    const key = getGroupKey(card);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(card);
    } else {
      buckets.set(key, [card]);
    }
  }

  return [...buckets.entries()]
    .map(([key, groupedCards]) => {
      const sortedCards = [...groupedCards].sort(compareNewestCardFirst);
      const initialLastUpdatedAt = getResponseSortTimestamp(sortedCards[0]) ?? '';
      const lastUpdatedAt = sortedCards.reduce<string>((latest, card) => {
        const candidate = getResponseSortTimestamp(card);
        if (!candidate) return latest;
        return getTimestampMs(candidate) > getTimestampMs(latest) ? candidate : latest;
      }, initialLastUpdatedAt);

      return {
        key,
        sessionId: sortedCards[0]?.sessionId,
        title: getSessionTitle(sortedCards),
        agentRuntime: sortedCards[0]?.agentRuntime,
        executionKind: sortedCards[0]?.executionKind,
        scriptName: sortedCards[0]?.scriptName,
        projectDir: sortedCards[0]?.projectDir,
        startedAt: sortedCards[0]?.createdAt ?? '',
        lastUpdatedAt,
        cards: sortedCards,
        unreadCount: countUnread(sortedCards),
      };
    })
    .sort(compareNewestGroupFirst);
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '-';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The turn header's right-hand stamp: `hh:mm` for today, `MM-DD hh:mm` before
 * that, so an old session's turns are not mistaken for this afternoon's.
 */
export function formatTurnStamp(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => value.toString().padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function getFirstLine(value: string | undefined, fallback: string): string {
  const firstLine = value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ?? fallback;
}

/**
 * Per-group disclosure for a list of session groups: header collapse,
 * `Show N more` turns, the column's `모두 숨기기` token and unread reveal.
 * Shared by the column's session view and every `BoardWorkContainer`, so a
 * group behaves the same wherever it is drawn. `groups` should be **every**
 * group the owner may draw (a Work's folded sessions included) — a reveal for
 * a group outside it is left to whoever owns that group.
 */
export function useSessionGroupDisclosure({
  groups,
  defaultCollapsed = false,
  hideAllToken,
  revealRequest,
}: {
  groups: readonly CompleteSessionGroup[];
  defaultCollapsed?: boolean;
  hideAllToken?: number;
  revealRequest?: CardRevealRequest | null;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const appliedHideAllTokenRef = useRef(hideAllToken ?? 0);
  const [expandedTurnGroups, setExpandedTurnGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!hideAllToken || hideAllToken === appliedHideAllTokenRef.current) return;

    appliedHideAllTokenRef.current = hideAllToken;
    setCollapsedGroups(Object.fromEntries(groups.map((group) => [group.key, true])));
  }, [groups, hideAllToken]);

  const appliedRevealTokenRef = useRef(0);
  useEffect(() => {
    if (!revealRequest || revealRequest.token === appliedRevealTokenRef.current) return;
    const group = groups.find((candidate) => candidate.key === revealRequest.groupKey);
    if (!group) return;
    appliedRevealTokenRef.current = revealRequest.token;

    setCollapsedGroups((previous) => ({ ...previous, [group.key]: false }));
    const turnIndex = group.cards.findIndex((card) => card.id === revealRequest.cardId);
    if (turnIndex >= INITIAL_VISIBLE_TURNS) {
      setExpandedTurnGroups((previous) => ({ ...previous, [group.key]: true }));
    }
  }, [groups, revealRequest]);

  return {
    isCollapsed: (key: string) => collapsedGroups[key] ?? defaultCollapsed,
    toggleCollapsed: (key: string) => {
      setCollapsedGroups((previous) => ({
        ...previous,
        [key]: !(previous[key] ?? defaultCollapsed),
      }));
    },
    showAllTurns: (key: string) => expandedTurnGroups[key] ?? false,
    toggleShowAllTurns: (key: string) => {
      setExpandedTurnGroups((previous) => ({
        ...previous,
        [key]: !(previous[key] ?? false),
      }));
    },
  };
}

export type SessionGroupDisclosure = ReturnType<typeof useSessionGroupDisclosure>;

export interface BoardSessionGroupCardProps {
  group: CompleteSessionGroup;
  status: SessionViewStatus;
  disclosure: SessionGroupDisclosure;
  onCardClick: (card: KanbanCard) => void;
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onFavoriteToggle?: (card: KanbanCard) => void;
  onStatusChange?: (card: KanbanCard, status: 'done') => void;
  onArchiveCards?: (cards: KanbanCard[]) => void;
}

/**
 * One session group — the `SESSION` tab, the card-anatomy header and the turn
 * timeline. Drawn by the column's session view and, unchanged, inside a Work
 * container (`GROUP: WORKS`). Disclosure state lives with the owner
 * (`useSessionGroupDisclosure`); only the per-group sort toggle is local.
 */
export const BoardSessionGroupCard: React.FC<BoardSessionGroupCardProps> = ({
  group,
  status,
  disclosure,
  onCardClick,
  onSessionOpen,
  onFavoriteToggle,
  onStatusChange,
  onArchiveCards,
}) => {
  const [oldestFirst, setOldestFirst] = useState(false);
  const isCollapsed = disclosure.isCollapsed(group.key);
  // GROUP: WORKS — the header is a drag source and carries `⋯ → Work로 이동`.
  const dnd = useBoardWorkDnD();
  const workSource: WorkDragSource | null = dnd && group.cards[0]
    ? {
        cardId: group.cards[0].id,
        sessionId: group.sessionId,
        workId: dnd.workForSession(group.sessionId)?.id,
        status,
        projectDir: group.projectDir,
        title: group.title,
      }
    : null;
  const isDragged = !!workSource && dnd?.drag?.cardId === workSource.cardId;
  const resumeCommand = group.sessionId ? buildResumeCommand(group.agentRuntime, group.sessionId, group.projectDir) : '';
  const toggleGroup = () => disclosure.toggleCollapsed(group.key);

  const openSession = () => {
    if (onSessionOpen) {
      onSessionOpen(group);
    } else {
      toggleGroup();
    }
  };

  const toggleSort = () => setOldestFirst((previous) => !previous);
  // group.cards는 최신순(index 0 = 최신). 턴 번호는 시간순 위치(가장 오래된 것 = 1).
  const orderedTurns = group.cards.map((card, index) => ({
    card,
    turnNumber: group.cards.length - index,
  }));
  const showAllTurns = disclosure.showAllTurns(group.key);
  const hiddenTurnCount = Math.max(0, orderedTurns.length - INITIAL_VISIBLE_TURNS);
  const hiddenUnreadCount = countUnread(
    orderedTurns.slice(INITIAL_VISIBLE_TURNS).map(({ card }) => card),
  );
  // `★ N` in row ① counts every turn; folded ones also show on `Show N more · ★ k`.
  const favorites = summarizeGroupFavorites(group, INITIAL_VISIBLE_TURNS);
  // Sliced newest-first, before the sort toggle reverses it, so "the newest
  // five" stays the newest five in either direction.
  const visibleTurns = showAllTurns ? orderedTurns : orderedTurns.slice(0, INITIAL_VISIBLE_TURNS);
  const displayTurns = oldestFirst ? [...visibleTurns].reverse() : visibleTurns;
  const toggleShowAllTurns = () => disclosure.toggleShowAllTurns(group.key);

  // The hidden turns are the older ones, so the button sits where they will
  // appear: below the list when newest-first, above it when reversed.
  const moreTurnsButton = hiddenTurnCount > 0 ? (
    <button
      type="button"
      className="kv2-complete-session-more-inline"
      aria-expanded={showAllTurns}
      onClick={toggleShowAllTurns}
    >
      {showAllTurns ? 'Hide older turns' : (
        <>
          {`Show ${hiddenTurnCount} more`}
          {hiddenUnreadCount > 0 && (
            <>
              {' · '}
              <span className="kv2-complete-session-more-unread">{hiddenUnreadCount} unread</span>
            </>
          )}
          {favorites.hidden > 0 && (
            <>
              {' · '}
              <span className="kv2-complete-session-more-favorite">★ {favorites.hidden}</span>
            </>
          )}
        </>
      )}
    </button>
  ) : null;

  return (
    <article
      data-session-group-key={group.key}
      className={`kv2-complete-session-group kv2-complete-session-group--${status}${group.unreadCount > 0 ? ' kv2-complete-session-group--unread' : ''}${isDragged ? ' is-dragged' : ''}`}
    >
      {/* Folder tab naming the container — the counterpart of the Work
          container's `WORK` tab, so the two never read as the same box. */}
      <span className="kv2-session-tab" aria-hidden="true">{BOARD_GROUP_COPY.sessionTab}</span>
      <header
        className="kv2-complete-session-header"
        role="button"
        tabIndex={0}
        aria-haspopup={onSessionOpen ? 'dialog' : undefined}
        aria-expanded={onSessionOpen ? undefined : !isCollapsed}
        draggable={!!workSource}
        title={workSource ? BOARD_WORKS_COPY.dragHint : undefined}
        onDragStart={workSource && dnd ? (event) => {
          writeWorkDragData(event.dataTransfer, workSource);
          dnd.startDrag(workSource);
        } : undefined}
        onDragEnd={dnd ? () => dnd.endDrag() : undefined}
        onClick={openSession}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openSession();
        }}
      >
        <div className="kv2-complete-session-heading">
          {/* Same anatomy as BoardCard: ① project ··· unread · #id, ② title,
              ③ divider, ④ runtime · counts — so the runtime badge and the
              id sit in the same place on every board item. */}
          <div className="kv2-complete-session-top">
            {group.projectDir ? (
              <span
                className={`works-dir-chip kv2-project-chip kv2-complete-session-project ${dirAccentClass(group.projectDir)}`.trim()}
                title={group.projectDir}
              >
                {getDirectoryProjectName(group.projectDir)}
              </span>
            ) : (
              <span className="kv2-card-project-spacer" aria-hidden="true" />
            )}
            <div className="kv2-complete-session-top-meta">
              {group.unreadCount > 0 && (
                // Count only — the filled pill already says "unread", and the
                // project chip needs the room in row ①.
                <span
                  className="kv2-complete-session-unread"
                  title={`${group.unreadCount} unread`}
                  aria-label={`${group.unreadCount} unread`}
                >
                  {group.unreadCount}
                </span>
              )}
              {favorites.total > 0 && (
                <span
                  className="kv2-favorite-pill"
                  title={BOARD_WORKS_COPY.sessionFavoriteHint(favorites.total)}
                  aria-label={`${favorites.total} starred`}
                >
                  ★ {favorites.total}
                </span>
              )}
              {group.sessionId && <IdChip id={group.sessionId} kind="session" />}
              {workSource && <BoardWorkMoveMenu source={workSource} />}
            </div>
          </div>
          <div className="kv2-complete-session-title-row">
            <span className="kv2-complete-session-title">{group.title}</span>
          </div>
          <div className="kv2-card-divider kv2-complete-session-divider" aria-hidden="true" />
          <div className="kv2-complete-session-meta-row">
            <ExecutionTypeBadge
              runtime={group.agentRuntime}
              executionKind={group.executionKind}
              scriptName={group.scriptName}
            />
            {/* No timestamp here: a board column is too narrow for badge ·
                count · time · resume, and a clipped time read as a bug.
                The latest turn shows it as `LATEST · hh:mm`. */}
            <span
              className="kv2-complete-session-count"
              title={`마지막 응답 ${formatTurnStamp(group.lastUpdatedAt)}`}
            >
              {group.cards.length === 1 ? '1 card' : `${group.cards.length} cards`}
            </span>
            {resumeCommand && (
              <ResumeCopyButton command={resumeCommand} className="kv2-complete-session-resume" />
            )}
          </div>
          <div className="kv2-complete-session-group-actions">
            {status === 'complete' && onStatusChange && (
              <button
                type="button"
                className="kv2-card-action kv2-card-action--done kv2-complete-session-group-action"
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  group.cards.forEach((card) => onStatusChange(card, 'done'));
                }}
              >
                {CARD_ACTION_COPY.done}
              </button>
            )}
            {status === 'done' && onArchiveCards && (
              <button
                type="button"
                className="kv2-card-action kv2-card-action--secondary kv2-complete-session-group-action"
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onArchiveCards(group.cards);
                }}
              >
                {CARD_ACTION_COPY.archive}
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          className="kv2-complete-session-toggle"
          aria-expanded={!isCollapsed}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            toggleGroup();
          }}
        >
          {isCollapsed ? 'show' : 'hide'}
        </button>
      </header>

      {!isCollapsed && (
        <div className="kv2-complete-session-timeline">
          {group.cards.length > 1 && (
            <div className="kv2-complete-session-timeline-bar">
              <button
                type="button"
                className="kv2-complete-session-sort-inline"
                aria-pressed={oldestFirst}
                title="대화 순서 전환 (과거 ↔ 최신)"
                onClick={toggleSort}
              >
                {oldestFirst ? '↑ 과거→최신 순' : '↓ 최신→과거 순'}
              </button>
            </div>
          )}
          {oldestFirst && moreTurnsButton}
          {displayTurns.map(({ card, turnNumber }) => {
            // Latest and unread are separate signals: latest is position
            // (node + LATEST text, never the unread red), unread is state.
            const isCurrent = turnNumber === group.cards.length;
            const isUnread = isUnreadCompletion(card);
            const stamp = formatTurnStamp(getResponseSortTimestamp(card));
            return (
              <article
                key={card.id}
                data-card-id={card.id}
                className={`kv2-complete-session-turn${isCurrent ? ' kv2-complete-session-turn--current' : ''}${isUnread ? ' kv2-complete-session-turn--unread' : ''}`}
              >
                <span className="kv2-complete-session-turn-node" aria-hidden="true" />
                <div
                  className="kv2-complete-session-turn-body"
                  role="button"
                  tabIndex={0}
                  onClick={() => onCardClick(card)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onCardClick(card);
                  }}
                >
                  <div
                    className="kv2-complete-session-turn-header"
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <button
                      type="button"
                      className="kv2-complete-session-card-title"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCardClick(card);
                      }}
                    >
                      {isUnread && (
                        <span
                          className="kv2-complete-session-new-tag"
                          title="Unread completion"
                        >
                          NEW
                        </span>
                      )}
                      <span>{turnNumber}. {card.title}</span>
                    </button>
                    {(isCurrent || stamp) && (
                      <span className="kv2-complete-session-turn-stamp">
                        {isCurrent ? (stamp ? `LATEST · ${stamp}` : 'LATEST') : stamp}
                      </span>
                    )}
                    {onFavoriteToggle && (
                      <FavoriteToggleButton
                        active={!!card.favorite}
                        onToggle={() => onFavoriteToggle(card)}
                        className="kv2-favorite-toggle--list"
                      />
                    )}
                  </div>

                  <div className="kv2-complete-session-text-stack">
                    <div className="kv2-complete-session-text-row kv2-complete-session-text-row--prompt">
                      <span className="kv2-complete-session-text-label">Prompt</span>
                      <p>{getFirstLine(stripFeedbackHeader(card.description ?? ''), '(no prompt)')}</p>
                    </div>

                    <div className="kv2-complete-session-text-row kv2-complete-session-text-row--result">
                      <span className="kv2-complete-session-text-label">Result</span>
                      <p>{getFirstLine(splitCardResult(card).final, '(no result)')}</p>
                    </div>
                  </div>
                </div>
                <div className="kv2-complete-session-turn-updated">
                  Updated {formatTimestamp(card.updatedAt)}
                </div>
              </article>
            );
          })}
          {!oldestFirst && moreTurnsButton}
        </div>
      )}
    </article>
  );
};

export const BoardCompleteSessionView: React.FC<BoardCompleteSessionViewProps> = ({
  cards,
  groups: groupsProp,
  status,
  defaultCollapsed = false,
  hideAllToken,
  revealRequest,
  onCardClick,
  onSessionOpen,
  onFavoriteToggle,
  onStatusChange,
  onArchiveCards,
}) => {
  const groups = useMemo(() => groupsProp ?? groupCompleteCardsBySession(cards), [cards, groupsProp]);
  const disclosure = useSessionGroupDisclosure({ groups, defaultCollapsed, hideAllToken, revealRequest });

  if (groups.length === 0) {
    return <div className="kv2-empty">No cards</div>;
  }

  return (
    <div className="kv2-complete-session-view">
      {groups.map((group) => (
        <BoardSessionGroupCard
          key={group.key}
          group={group}
          status={status}
          disclosure={disclosure}
          onCardClick={onCardClick}
          onSessionOpen={onSessionOpen}
          onFavoriteToggle={onFavoriteToggle}
          onStatusChange={onStatusChange}
          onArchiveCards={onArchiveCards}
        />
      ))}
    </div>
  );
};
