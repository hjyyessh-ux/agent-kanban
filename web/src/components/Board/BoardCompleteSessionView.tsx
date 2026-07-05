import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRuntime, KanbanCard } from '../../../../src/core/types';
import { FavoriteToggleButton, RuntimeBadge } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { buildResumeCommand } from '../../utils/resume-command';

type SessionViewStatus = 'complete' | 'done';

interface BoardCompleteSessionViewProps {
  cards: KanbanCard[];
  status: SessionViewStatus;
  defaultCollapsed?: boolean;
  hideAllToken?: number;
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

function isUnreadCompletion(card: KanbanCard): boolean {
  if (card.status !== 'complete') return false;
  const completionTime = getResponseSortTimestamp(card);
  if (!completionTime) return false;

  return !card.completedSeenAt || card.completedSeenAt < completionTime;
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
        projectDir: sortedCards[0]?.projectDir,
        startedAt: sortedCards[0]?.createdAt ?? '',
        lastUpdatedAt,
        cards: sortedCards,
        unreadCount: sortedCards.filter(isUnreadCompletion).length,
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

function getFirstLine(value: string | undefined, fallback: string): string {
  const firstLine = value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ?? fallback;
}

export const BoardCompleteSessionView: React.FC<BoardCompleteSessionViewProps> = ({
  cards,
  status,
  defaultCollapsed = false,
  hideAllToken,
  onCardClick,
  onSessionOpen,
  onFavoriteToggle,
  onStatusChange,
  onArchiveCards,
}) => {
  const groups = useMemo(() => groupCompleteCardsBySession(cards), [cards]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const appliedHideAllTokenRef = useRef(hideAllToken ?? 0);
  const [copiedSessionKey, setCopiedSessionKey] = useState<string | null>(null);
  const [oldestFirstGroups, setOldestFirstGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!hideAllToken || hideAllToken === appliedHideAllTokenRef.current) return;

    appliedHideAllTokenRef.current = hideAllToken;
    setCollapsedGroups(Object.fromEntries(groups.map((group) => [group.key, true])));
  }, [groups, hideAllToken]);

  if (groups.length === 0) {
    return <div className="kv2-empty">No cards</div>;
  }

  return (
    <div className="kv2-complete-session-view">
      {groups.map((group) => {
        const isCollapsed = collapsedGroups[group.key] ?? defaultCollapsed;
        const resumeCommand = group.sessionId ? buildResumeCommand(group.agentRuntime, group.sessionId, group.projectDir) : '';
        const toggleGroup = () => {
          setCollapsedGroups((previous) => ({
            ...previous,
            [group.key]: !(previous[group.key] ?? defaultCollapsed),
          }));
        };

        const openSession = () => {
          if (onSessionOpen) {
            onSessionOpen(group);
          } else {
            toggleGroup();
          }
        };

        const oldestFirst = oldestFirstGroups[group.key] ?? false;
        const toggleSort = () => {
          setOldestFirstGroups((previous) => ({
            ...previous,
            [group.key]: !(previous[group.key] ?? false),
          }));
        };
        // group.cards는 최신순(index 0 = 최신). 턴 번호는 시간순 위치(가장 오래된 것 = 1).
        const orderedTurns = group.cards.map((card, index) => ({
          card,
          turnNumber: group.cards.length - index,
        }));
        const displayTurns = oldestFirst ? [...orderedTurns].reverse() : orderedTurns;

        return (
          <article
            key={group.key}
            className={`kv2-complete-session-group kv2-complete-session-group--${status}`}
          >
            <header
              className="kv2-complete-session-header"
              role="button"
              tabIndex={0}
              aria-haspopup={onSessionOpen ? 'dialog' : undefined}
              aria-expanded={onSessionOpen ? undefined : !isCollapsed}
              onClick={openSession}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openSession();
              }}
            >
              <div className="kv2-complete-session-heading">
                <div className="kv2-complete-session-runtime-row">
                  <RuntimeBadge runtime={group.agentRuntime} />
                  <span className="kv2-complete-session-count">{group.cards.length} cards</span>
                  {group.unreadCount > 0 && (
                    <span className="kv2-complete-session-unread">{group.unreadCount} unread</span>
                  )}
                  {group.sessionId && (
                    <button
                      type="button"
                      className={`kv2-complete-session-id-chip${copiedSessionKey === group.key ? ' is-copied' : ''}`}
                      title={`클릭하여 resume 명령 복사: ${resumeCommand}`}
                      aria-label={`Session ID ${group.sessionId} · resume 명령 복사`}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        void navigator.clipboard.writeText(resumeCommand).then(() => {
                          setCopiedSessionKey(group.key);
                          window.setTimeout(() => {
                            setCopiedSessionKey((current) => current === group.key ? null : current);
                          }, 1500);
                        });
                      }}
                    >
                      {copiedSessionKey === group.key
                        ? '✓ 복사됨'
                        : `#${group.sessionId.slice(0, 8)}`}
                    </button>
                  )}
                </div>
                <div className="kv2-complete-session-title-row">
                  <span className="kv2-complete-session-title">{group.title}</span>
                </div>
                {group.projectDir && (
                  <div className="kv2-card-directory kv2-complete-session-project" title={group.projectDir}>
                    <span className="kv2-card-directory-label">Proj:</span>
                    <span className="kv2-card-directory-name">{getDirectoryProjectName(group.projectDir)}</span>
                  </div>
                )}
                <div className="kv2-card-divider kv2-complete-session-divider" aria-hidden="true" />
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
                      DONE
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
                      ARCHIVE
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
                {displayTurns.map(({ card, turnNumber }) => {
                  const isCurrent = turnNumber === group.cards.length;
                  return (
                    <article
                      key={card.id}
                      className={`kv2-complete-session-turn${isCurrent ? ' kv2-complete-session-turn--current' : ''}`}
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
                            {isUnreadCompletion(card) && (
                              <span
                                className="kv2-list-unread-dot"
                                title="Unread completion"
                                aria-label="Unread completion"
                              />
                            )}
                            <span>{turnNumber}. {card.title}</span>
                          </button>
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
                            <p>{getFirstLine(card.description, '(no prompt)')}</p>
                          </div>

                          <div className="kv2-complete-session-text-row kv2-complete-session-text-row--result">
                            <span className="kv2-complete-session-text-label">Result</span>
                            <p>{getFirstLine(card.result, '(no result)')}</p>
                          </div>
                        </div>
                      </div>
                      <div className="kv2-complete-session-turn-updated">
                        Updated {formatTimestamp(card.updatedAt)}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
};
