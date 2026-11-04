import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { KanbanCard, KanbanStatus, Work } from '../../../../src/core/types';
import type { V2CardViewModel, V2ColumnViewModel } from './board-selectors';
import { isUnreadCompletion, selectCardById } from './board-selectors';
import { ExecutionTypeBadge, FavoriteToggleButton, OriginExecutionBadges, QueueTargetChip, ScheduledMetaBadge, SchedulerBadge } from './BoardCardSections';
import { BoardListRowAction } from './BoardListRowAction';
import { BoardCardTimeMeta } from './BoardCard';
import {
  formatRecentStamp,
  formatTimestamp,
  formatTurnStamp,
  getFirstLine,
  groupCompleteCardsBySession,
  sumRunDurationMs,
  type CardRevealRequest,
  type CompleteSessionGroup,
} from './BoardCompleteSessionView';
import { groupsCompleteBySession, type BoardGroupMode } from './board-group-mode';
import { countFavoriteCards, type WorkFragment, type WorksColumnModel } from './board-works';
import { useBoardTurnOrder } from './board-turn-order';
import { getDirectoryProjectName } from './directory-display';
import { dirAccentClass } from '../../utils/project-color';
import { formatDuration } from '../../utils/format-duration';
import { stripFeedbackHeader } from '../../../../src/core/mention-search';
import { splitCardResult } from '../Card/card-result';
import { BOARD_SESSION_COPY, CARD_ACTION_COPY, LIST_COPY } from '../../constants/copy';

interface BoardListViewProps {
  columns: V2ColumnViewModel[];
  allCards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
  onStatusChange: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onFavoriteToggle: (card: KanbanCard) => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
  onQueueOpen?: (card: KanbanCard) => void;
  onCreate?: () => void;
  revealRequest?: CardRevealRequest | null;
  /** Toolbar `GROUP` — the list follows it like the board does. */
  groupMode?: BoardGroupMode;
  /** `GROUP: WORKS` fragments (`selectWorkFragments`), once Works have loaded. */
  worksModel?: Record<KanbanStatus, WorksColumnModel>;
  /** sessionId → Work, for the Work tag on todo / in-progress rows. */
  worksIndex?: Map<string, Work>;
  works?: readonly Work[];
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onWorkOpen?: (workId: string) => void;
  onArchiveCards?: (cards: KanbanCard[]) => void;
}

/** Needs-me first: review, running, waiting, then the archive-bound pile. */
const LIST_ORDER: KanbanStatus[] = ['complete', 'in_progress', 'todo', 'done'];

/** Newest turns an opened session shows before `이전 N턴 더 보기`. */
const LIST_VISIBLE_TURNS = 5;

const SECTIONS_STORAGE_KEY = 'kanban.list.collapsedSections';
const DEFAULT_SECTIONS: Record<KanbanStatus, boolean> = {
  complete: false,
  in_progress: false,
  todo: false,
  done: true,
};

export function orderColumnsForList(
  columns: V2ColumnViewModel[],
): V2ColumnViewModel[] {
  const map = new Map(columns.map((column) => [column.status, column]));
  return LIST_ORDER.flatMap((status) => {
    const column = map.get(status);
    return column ? [column] : [];
  });
}

function readCollapsedSections(): Record<KanbanStatus, boolean> {
  if (typeof window === 'undefined') return DEFAULT_SECTIONS;
  try {
    const raw = window.localStorage.getItem(SECTIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_SECTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SECTIONS;
    const record = parsed as Partial<Record<KanbanStatus, unknown>>;
    return LIST_ORDER.reduce((next, status) => ({
      ...next,
      [status]: typeof record[status] === 'boolean' ? record[status] : DEFAULT_SECTIONS[status],
    }), { ...DEFAULT_SECTIONS });
  } catch {
    return DEFAULT_SECTIONS;
  }
}

function writeCollapsedSections(value: Record<KanbanStatus, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage full or blocked — folding still works for this page view.
  }
}

/** What one section draws, top to bottom. */
type SectionBody =
  | { kind: 'cards'; cards: V2CardViewModel[] }
  | { kind: 'sessions'; fragments: WorkFragment[]; groups: CompleteSessionGroup[] };

function runDurationLabel(cards: readonly KanbanCard[]): string | null {
  const ms = sumRunDurationMs(cards);
  return ms > 0 ? formatDuration(ms) : null;
}

/** A row click that landed on a control inside the row belongs to that control. */
function isFromControl(event: React.MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element;
  if (!event.currentTarget.contains(target)) return true;
  return Boolean(target.closest('button, a, input, select, textarea, [role="menu"], [role="menuitem"]'));
}

const ProjectRuntime: React.FC<{
  projectDir?: string;
  /** Omitted on a Work row — a Work spans runtimes. */
  runtime?: V2CardViewModel['agentRuntime'] | null;
  executionKind?: V2CardViewModel['executionKind'];
  scriptName?: string;
}> = ({ projectDir, runtime, executionKind, scriptName }) => {
  const projectName = getDirectoryProjectName(projectDir);
  return (
    <span className="kv2-list-col-meta">
      {projectName && (
        <span
          className={`works-dir-chip kv2-project-chip kv2-list-project ${dirAccentClass(projectDir)}`.trim()}
          title={projectDir}
        >
          {projectName}
        </span>
      )}
      {runtime !== null && (
        <ExecutionTypeBadge runtime={runtime} executionKind={executionKind} scriptName={scriptName} />
      )}
    </span>
  );
};

const FoldChevron: React.FC<{ collapsed: boolean; label: string; onToggle: () => void }> = ({ collapsed, label, onToggle }) => (
  <button
    type="button"
    className="kv2-list-fold"
    aria-expanded={!collapsed}
    aria-label={label}
    onClick={(event) => {
      event.stopPropagation();
      onToggle();
    }}
  >
    {collapsed ? '▸' : '▾'}
  </button>
);

export const BoardListView: React.FC<BoardListViewProps> = ({
  columns,
  allCards,
  onCardClick,
  onStatusChange,
  onFavoriteToggle,
  onDispatch,
  onQueueOpen,
  onCreate,
  revealRequest,
  groupMode = 'card',
  worksModel,
  worksIndex,
  works,
  onSessionOpen,
  onWorkOpen,
  onArchiveCards,
}) => {
  const [collapsedSections, setCollapsedSections] = useState<Record<KanbanStatus, boolean>>(readCollapsedSections);
  /** `${status}:${workId}` of folded Work rows — Works start open. */
  const [foldedWorks, setFoldedWorks] = useState<ReadonlySet<string>>(() => new Set());
  /** Session group keys whose turns are showing — sessions start folded to one row. */
  const [openSessions, setOpenSessions] = useState<ReadonlySet<string>>(() => new Set());
  /** Opened sessions that also show their older turns. */
  const [fullSessions, setFullSessions] = useState<ReadonlySet<string>>(() => new Set());
  const turnOrder = useBoardTurnOrder();

  const setSections = useCallback((update: (prev: Record<KanbanStatus, boolean>) => Record<KanbanStatus, boolean>) => {
    setCollapsedSections((prev) => {
      const next = update(prev);
      writeCollapsedSections(next);
      return next;
    });
  }, []);

  const orderedColumns = useMemo(() => orderColumnsForList(columns), [columns]);

  const bodies = useMemo(() => {
    const groupComplete = groupsCompleteBySession(groupMode);
    const result = new Map<KanbanStatus, SectionBody>();
    for (const column of orderedColumns) {
      const grouped = column.status === 'done' || (column.status === 'complete' && groupComplete);
      if (!grouped) {
        result.set(column.status, { kind: 'cards', cards: column.cards });
        continue;
      }
      const worksColumn = worksModel?.[column.status];
      if (worksColumn) {
        result.set(column.status, { kind: 'sessions', fragments: worksColumn.fragments, groups: worksColumn.unassigned });
        continue;
      }
      const raw = column.cards
        .map((vm) => selectCardById(allCards, vm.id))
        .filter((card): card is KanbanCard => Boolean(card));
      result.set(column.status, { kind: 'sessions', fragments: [], groups: groupCompleteCardsBySession(raw) });
    }
    return result;
  }, [allCards, groupMode, orderedColumns, worksModel]);

  // An unread jump opens the section, the Work and the session that hold the card.
  useEffect(() => {
    if (!revealRequest) return;
    setSections((prev) => (prev[revealRequest.status] ? { ...prev, [revealRequest.status]: false } : prev));
    const body = bodies.get(revealRequest.status);
    if (!body || body.kind !== 'sessions') return;
    const holds = (group: CompleteSessionGroup) => group.cards.some((card) => card.id === revealRequest.cardId);
    const fragment = body.fragments.find((candidate) => candidate.groups.some(holds));
    const group = [...body.fragments.flatMap((candidate) => candidate.groups), ...body.groups].find(holds);
    if (fragment) {
      const key = `${revealRequest.status}:${fragment.work.id}`;
      setFoldedWorks((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (!group) return;
    setOpenSessions((prev) => (prev.has(group.key) ? prev : new Set(prev).add(group.key)));
    const turnIndex = group.cards.findIndex((card) => card.id === revealRequest.cardId);
    if (turnIndex >= LIST_VISIBLE_TURNS) {
      setFullSessions((prev) => (prev.has(group.key) ? prev : new Set(prev).add(group.key)));
    }
  }, [bodies, revealRequest, setSections]);

  const allGroupKeys = useCallback((status?: KanbanStatus) => {
    const keys: string[] = [];
    bodies.forEach((body, bodyStatus) => {
      if (status && bodyStatus !== status) return;
      if (body.kind !== 'sessions') return;
      body.fragments.forEach((fragment) => fragment.groups.forEach((group) => keys.push(group.key)));
      body.groups.forEach((group) => keys.push(group.key));
    });
    return keys;
  }, [bodies]);

  const expandEverything = () => {
    setSections(() => ({ complete: false, in_progress: false, todo: false, done: false }));
    setFoldedWorks(new Set());
    setOpenSessions(new Set(allGroupKeys()));
  };

  const collapseEverything = () => {
    setSections(() => ({ complete: true, in_progress: true, todo: true, done: true }));
    setOpenSessions(new Set());
    setFullSessions(new Set());
  };

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const workTagFor = (vm: V2CardViewModel) => {
    if (!works) return null;
    const raw = selectCardById(allCards, vm.id);
    const linked = raw?.sessionId ? worksIndex?.get(raw.sessionId) : undefined;
    const planned = !linked && raw?.plannedWorkId ? works.find((work) => work.id === raw.plannedWorkId) : undefined;
    const work = linked ?? planned;
    if (!work) return null;
    return (
      <span className={`kv2-list-work-tag${planned ? ' is-planned' : ''}`} title={work.title}>
        <span className="kv2-list-work-tag-icon" aria-hidden="true">W</span>
        {work.title}
      </span>
    );
  };

  const renderCardRow = (vm: V2CardViewModel) => {
    const raw = selectCardById(allCards, vm.id);
    if (!raw) return null;
    return (
      <div key={vm.id} data-card-id={vm.id} className="kv2-list-table-row kv2-list-row--card">
        <span className="kv2-list-col-favorite">
          <FavoriteToggleButton
            active={vm.favorite}
            onToggle={() => onFavoriteToggle(raw)}
            className="kv2-favorite-toggle--list"
          />
        </span>
        <span className="kv2-list-col-title">
          <button type="button" className="kv2-list-title-open" onClick={() => onCardClick(raw)}>
            {vm.hasUnreadCompletion && (
              <span className="kv2-list-unread-dot" title="Unread completion" aria-label="Unread completion" />
            )}
            <ScheduledMetaBadge vm={vm} />
            {vm.originChannel === 'scheduler' && (
              <SchedulerBadge title={vm.schedulerName ? `Scheduler origin · ${vm.schedulerName}` : 'Scheduler origin'} size={16} />
            )}
            <OriginExecutionBadges originChannel={vm.originChannel} quickActionId={vm.quickActionId} />
            <span className="kv2-list-title-text">{vm.title}</span>
          </button>
          {workTagFor(vm)}
          {vm.queuedAfterCardId && (
            <span className="kv2-list-col-queue">
              <QueueTargetChip
                queueTargetTitle={vm.queueTargetTitle}
                queuedAfterCardId={vm.queuedAfterCardId}
                queuePosition={vm.queuePosition}
                queueSessionMode={vm.queueSessionMode}
                onClick={onQueueOpen ? () => onQueueOpen(raw) : undefined}
              />
            </span>
          )}
          <span className="kv2-list-prompt-snippet" title={vm.boardSummary}>{vm.boardSummary}</span>
        </span>
        <ProjectRuntime
          projectDir={vm.projectDir}
          runtime={vm.agentRuntime}
          executionKind={vm.executionKind}
          scriptName={vm.scriptName}
        />
        <span className="kv2-list-col-time"><BoardCardTimeMeta vm={vm} /></span>
        <span className="kv2-list-col-action">
          <BoardListRowAction card={raw} onStatusChange={onStatusChange} onDispatch={onDispatch} />
        </span>
      </div>
    );
  };

  const renderTurnRows = (group: CompleteSessionGroup, depth: number) => {
    const showAll = fullSessions.has(group.key);
    const newest = showAll ? group.cards : group.cards.slice(0, LIST_VISIBLE_TURNS);
    const turns = turnOrder === 'oldest' ? [...newest].reverse() : newest;
    const hidden = group.cards.length - newest.length;
    const numberOf = (card: KanbanCard) => group.cards.length - group.cards.indexOf(card);
    const olderButton = hidden > 0 && (
      <div key={`${group.key}:older`} className={`kv2-list-table-row kv2-list-row--more kv2-list-depth-${depth}`}>
        <span />
        <span className="kv2-list-col-title">
          <button
            type="button"
            className="kv2-list-more"
            onClick={() => setFullSessions((prev) => new Set(prev).add(group.key))}
          >
            {LIST_COPY.olderTurns(hidden)}
          </button>
        </span>
      </div>
    );
    const rows = turns.map((card) => {
      const unread = isUnreadCompletion(card);
      const prompt = getFirstLine(stripFeedbackHeader(card.description ?? ''), card.title || BOARD_SESSION_COPY.noPrompt);
      const result = getFirstLine(splitCardResult(card).final, BOARD_SESSION_COPY.noResult);
      const stamp = card.responseAt ?? card.completedAt ?? card.updatedAt;
      return (
        <div
          key={card.id}
          data-card-id={card.id}
          className={`kv2-list-table-row kv2-list-row--turn kv2-list-depth-${depth}${unread ? ' is-unread' : ''}`}
        >
          <span className="kv2-list-col-favorite">
            <FavoriteToggleButton
              active={Boolean(card.favorite)}
              onToggle={() => onFavoriteToggle(card)}
              className="kv2-favorite-toggle--list"
            />
          </span>
          <span className="kv2-list-col-title">
            <button
              type="button"
              className="kv2-list-title-open kv2-list-turn-open"
              onClick={() => onCardClick(card)}
              title={`${card.title} · ${formatTimestamp(stamp)}`}
              aria-label={`${numberOf(card)}. ${card.title}${unread ? ` · ${BOARD_SESSION_COPY.unreadTurn}` : ''}`}
            >
              <span className="kv2-list-turn-no">{numberOf(card)}</span>
              {unread && <span className="kv2-list-unread-dot" aria-hidden="true" />}
              <span className="kv2-list-title-text">{prompt}</span>
            </button>
            <span className="kv2-list-turn-result" title={result}>↳ {result}</span>
          </span>
          <span className="kv2-list-col-meta" />
          <span className="kv2-list-col-time">{formatTurnStamp(stamp)}</span>
          <span className="kv2-list-col-action" />
        </div>
      );
    });
    return turnOrder === 'oldest' ? [olderButton, ...rows] : [...rows, olderButton];
  };

  const renderSessionRows = (group: CompleteSessionGroup, status: KanbanStatus, depth: number) => {
    const open = openSessions.has(group.key);
    const favorites = countFavoriteCards(group.cards);
    const latest = group.cards[0];
    const duration = runDurationLabel(group.cards);
    const action = status === 'complete'
      ? { label: CARD_ACTION_COPY.done, run: () => group.cards.forEach((card) => onStatusChange(card, 'done')), cls: 'kv2-card-action--done' }
      : status === 'done' && onArchiveCards
        ? { label: CARD_ACTION_COPY.archive, run: () => onArchiveCards(group.cards), cls: 'kv2-card-action--secondary' }
        : null;

    return (
      <React.Fragment key={group.key}>
        <div
          data-session-group-key={group.key}
          className={`kv2-list-table-row kv2-list-row--session kv2-list-depth-${depth}${group.unreadCount > 0 ? ' is-unread' : ''}${open ? ' is-open' : ''}`}
          onClick={(event) => {
            if (isFromControl(event)) return;
            toggleIn(setOpenSessions, group.key);
          }}
        >
          <span className="kv2-list-col-favorite">
            <FoldChevron
              collapsed={!open}
              label={LIST_COPY.groupToggle(group.title, !open)}
              onToggle={() => toggleIn(setOpenSessions, group.key)}
            />
          </span>
          <span className="kv2-list-col-title">
            <button
              type="button"
              className="kv2-list-title-open"
              title={onSessionOpen ? LIST_COPY.openSession : undefined}
              onClick={() => (onSessionOpen ? onSessionOpen(group) : latest && onCardClick(latest))}
            >
              <span className="kv2-list-title-text">{group.title}</span>
            </button>
            {group.unreadCount > 0 && (
              <span className="kv2-list-unread-count" aria-label={`${group.unreadCount} unread`}>● {group.unreadCount}</span>
            )}
            {favorites > 0 && <span className="kv2-favorite-pill" aria-label={`${favorites} starred`}>★ {favorites}</span>}
            <span className="kv2-list-group-meta">{LIST_COPY.sessionMeta(group.cards.length, duration)}</span>
          </span>
          <ProjectRuntime
            projectDir={group.projectDir}
            runtime={group.agentRuntime}
            executionKind={group.executionKind}
            scriptName={group.scriptName}
          />
          <span className="kv2-list-col-time" title={formatTimestamp(group.lastUpdatedAt)}>
            {BOARD_SESSION_COPY.lastRun(formatRecentStamp(group.lastUpdatedAt))}
          </span>
          <span className="kv2-list-col-action">
            {action && (
              <button type="button" className={`kv2-card-action ${action.cls} kv2-list-action-btn`} onClick={action.run}>
                {action.label}
              </button>
            )}
          </span>
        </div>
        {open && renderTurnRows(group, depth + 1)}
      </React.Fragment>
    );
  };

  const renderWorkRows = (fragment: WorkFragment, status: KanbanStatus) => {
    const key = `${status}:${fragment.work.id}`;
    const folded = foldedWorks.has(key);
    const cards = fragment.groups.flatMap((group) => group.cards);
    const duration = runDurationLabel(cards);
    return (
      <React.Fragment key={key}>
        <div
          data-work-id={fragment.work.id}
          className={`kv2-list-table-row kv2-list-row--work${folded ? '' : ' is-open'}`}
          onClick={(event) => {
            if (isFromControl(event)) return;
            toggleIn(setFoldedWorks, key);
          }}
        >
          <span className="kv2-list-col-favorite">
            <FoldChevron
              collapsed={folded}
              label={LIST_COPY.groupToggle(fragment.work.title, folded)}
              onToggle={() => toggleIn(setFoldedWorks, key)}
            />
          </span>
          <span className="kv2-list-col-title">
            <span className="kv2-list-work-label" aria-hidden="true">{LIST_COPY.workTag}</span>
            <button
              type="button"
              className="kv2-list-title-open"
              title={onWorkOpen ? LIST_COPY.openWork : undefined}
              disabled={!onWorkOpen}
              onClick={() => onWorkOpen?.(fragment.work.id)}
            >
              <span className="kv2-list-title-text">{fragment.work.title}</span>
            </button>
            {fragment.unreadCount > 0 && (
              <span className="kv2-list-unread-count" aria-label={`${fragment.unreadCount} unread`}>● {fragment.unreadCount}</span>
            )}
            {fragment.favoriteCount > 0 && (
              <span className="kv2-favorite-pill" aria-label={`${fragment.favoriteCount} starred`}>★ {fragment.favoriteCount}</span>
            )}
            <span className="kv2-list-group-meta">{LIST_COPY.workMeta(fragment.groups.length, duration)}</span>
          </span>
          <ProjectRuntime projectDir={fragment.work.projectDir} runtime={null} />
          <span className="kv2-list-col-time" title={formatTimestamp(fragment.lastUpdatedAt)}>
            {BOARD_SESSION_COPY.lastRun(formatRecentStamp(fragment.lastUpdatedAt))}
          </span>
          <span className="kv2-list-col-action" />
        </div>
        {!folded && fragment.groups.map((group) => renderSessionRows(group, status, 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="kv2-board-list">
      <div className="kv2-list-toolbar">
        <div className="kv2-list-fold-all">
          <button type="button" className="kv2-list-fold-all-btn" onClick={expandEverything} title={LIST_COPY.expandAllLabel}>
            {LIST_COPY.expandAll}
          </button>
          <button type="button" className="kv2-list-fold-all-btn" onClick={collapseEverything} title={LIST_COPY.collapseAllLabel}>
            {LIST_COPY.collapseAll}
          </button>
        </div>
        <div className="kv2-list-table-head" aria-hidden="true">
          <span />
          <span>{LIST_COPY.colTitle}</span>
          <span>{LIST_COPY.colMeta}</span>
          <span>{LIST_COPY.colTime}</span>
          <span>{LIST_COPY.colAction}</span>
        </div>
      </div>

      {orderedColumns.map((column) => {
        const isCollapsed = collapsedSections[column.status];
        const body = bodies.get(column.status);
        const toggleSection = () => setSections((prev) => ({ ...prev, [column.status]: !prev[column.status] }));
        const sectionKeys = body?.kind === 'sessions' ? allGroupKeys(column.status) : [];
        const anySessionOpen = sectionKeys.some((key) => openSessions.has(key));

        return (
          <section
            key={column.status}
            className={`kv2-list-section${isCollapsed ? ' is-collapsed' : ''}`}
            data-status={column.status}
          >
            <div
              className="kv2-list-section-header"
              data-status={column.status}
              data-collapsed={isCollapsed ? 'true' : 'false'}
              onClick={(event) => {
                if (isFromControl(event)) return;
                toggleSection();
              }}
            >
              <button
                type="button"
                className="kv2-list-section-toggle"
                aria-expanded={!isCollapsed}
                aria-label={LIST_COPY.sectionToggle(column.label, isCollapsed)}
                onClick={toggleSection}
              >
                <span className="kv2-chevron" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                <span className="kv2-list-section-dot" aria-hidden="true" />
                <span className="kv2-list-section-title">{column.label}</span>
                <span className="kv2-list-section-count">{column.count}</span>
              </button>
              {column.unreadCount > 0 && (
                <span className="kv2-list-unread-count" aria-label={`${column.unreadCount} unread`}>● {column.unreadCount}</span>
              )}
              {isCollapsed && column.count > 0 && (
                <span className="kv2-list-collapsed-summary">{LIST_COPY.hidden(column.count)}</span>
              )}
              <span className="kv2-list-section-spacer" aria-hidden="true" />
              {!isCollapsed && sectionKeys.length > 0 && (
                <button
                  type="button"
                  className="kv2-list-fold-all-btn"
                  onClick={() => setOpenSessions((prev) => {
                    const next = new Set(prev);
                    sectionKeys.forEach((key) => (anySessionOpen ? next.delete(key) : next.add(key)));
                    return next;
                  })}
                >
                  {anySessionOpen ? BOARD_SESSION_COPY.fold : BOARD_SESSION_COPY.unfold}
                </button>
              )}
              {column.status === 'todo' && onCreate && (
                <button type="button" className="kv2-btn kv2-btn--outline kv2-list-create-btn" onClick={onCreate}>
                  {LIST_COPY.addTask}
                </button>
              )}
            </div>

            {!isCollapsed && (
              column.count === 0 || !body ? (
                <div className="kv2-list-empty">{LIST_COPY.empty}</div>
              ) : (
                <div className="kv2-list-table-body">
                  {body.kind === 'cards'
                    ? body.cards.map(renderCardRow)
                    : (
                      <>
                        {body.fragments.map((fragment) => renderWorkRows(fragment, column.status))}
                        {body.fragments.length > 0 && body.groups.length > 0 && (
                          <div className="kv2-list-subhead">{LIST_COPY.unassigned}</div>
                        )}
                        {body.groups.map((group) => renderSessionRows(group, column.status, 0))}
                      </>
                    )}
                </div>
              )
            )}
          </section>
        );
      })}
    </div>
  );
};
