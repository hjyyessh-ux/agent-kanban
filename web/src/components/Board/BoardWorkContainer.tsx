import React, { useEffect, useRef, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import {
  BoardSessionGroupCard,
  useSessionGroupDisclosure,
  type CardRevealRequest,
  type CompleteSessionGroup,
  type SessionViewStatus,
} from './BoardCompleteSessionView';
import { BoardColumnMenu, type BoardColumnMenuItem } from './BoardColumnMenu';
import type { WorkFragment } from './board-works';
import { getDirectoryProjectName } from './directory-display';
import { IdChip } from '../shared/IdChip';
import { dirAccentClass } from '../../utils/project-color';
import { BOARD_GROUP_COPY, BOARD_WORKS_COPY, STATUS_LABELS } from '../../constants/copy';
import type { WorkDetailIntent } from '../Works/WorkDetailDialog';
import { useBoardWorkDnD, workDropTargetProps } from './board-work-dnd';

/** How long a `진행중 1 ↗` jump rings the fragment it landed on. */
export const WORK_FLASH_MS = 1200;

/** The board element every fragment / work-tagged card of a Work carries. */
export function workFragmentSelector(workId: string, status?: KanbanStatus): string {
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(workId) : workId;
  return status ? `[data-work-id="${id}"][data-work-status="${status}"]` : `[data-work-id="${id}"]`;
}

function boardScope(from: Element): ParentNode {
  return from.closest('.kv2-board') ?? document;
}

/** Title hover/focus: ring every fragment (and work-tagged card) of the same Work. */
function setPeerHighlight(from: Element, workId: string, on: boolean): void {
  boardScope(from).querySelectorAll(workFragmentSelector(workId)).forEach((element) => {
    element.classList.toggle('kv2-work-peer', on);
  });
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface WorkCollapseRequest {
  collapsed: boolean;
  token: number;
}

export interface BoardWorkContainerProps {
  fragment: WorkFragment;
  status: SessionViewStatus;
  /** Start folded — header and meta line only. */
  defaultCollapsed?: boolean;
  /** Session groups start header-only inside a Work (B안) unless the owner says otherwise. */
  defaultSessionsCollapsed?: boolean;
  hideAllToken?: number;
  /** Column `⋯ → 모든 Work 세션 접기/펼치기`: each new token folds or unfolds this container; its own toggle still works after. */
  collapseRequest?: WorkCollapseRequest;
  revealRequest?: CardRevealRequest | null;
  /** Title click / `⋯` items — App opens `WorkDetailDialog`, optionally straight into a flow. */
  onWorkOpen?: (workId: string, intent?: WorkDetailIntent) => void;
  onCardClick: (card: KanbanCard) => void;
  onSessionOpen?: (group: CompleteSessionGroup) => void;
  onFavoriteToggle?: (card: KanbanCard) => void;
  onStatusChange?: (card: KanbanCard, status: 'done') => void;
  onArchiveCards?: (cards: KanbanCard[]) => void;
}

/**
 * One Work's fragment in a complete/done column (`GROUP: WORKS`, mockup
 * `docs/mockups/works-on-board.html` B안). Told apart from a session group by
 * the `WORK` folder tab, the Work-blue border, the tint face and the stacked
 * paper shadow. The body is the newest `WORK_VISIBLE_SESSIONS` session groups,
 * drawn by the same `BoardSessionGroupCard` the column uses, then
 * `＋ Show N more sessions`. The footer `hide` / `show N` button (same face as a
 * session group's) folds it to the header, meta line and that button; opening
 * again starts from the newest two. `⋯` carries only the Work's own actions.
 */
export const BoardWorkContainer: React.FC<BoardWorkContainerProps> = ({
  fragment,
  status,
  defaultCollapsed = false,
  defaultSessionsCollapsed = true,
  hideAllToken,
  collapseRequest,
  revealRequest,
  onWorkOpen,
  onCardClick,
  onSessionOpen,
  onFavoriteToggle,
  onStatusChange,
  onArchiveCards,
}) => {
  const { work } = fragment;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [showAll, setShowAll] = useState(false);
  const disclosure = useSessionGroupDisclosure({
    groups: fragment.groups,
    defaultCollapsed: defaultSessionsCollapsed,
    hideAllToken,
    revealRequest,
  });

  const appliedCollapseTokenRef = useRef(collapseRequest?.token ?? 0);
  useEffect(() => {
    if (!collapseRequest || collapseRequest.token === appliedCollapseTokenRef.current) return;
    appliedCollapseTokenRef.current = collapseRequest.token;
    setShowAll(false);
    setCollapsed(collapseRequest.collapsed);
  }, [collapseRequest]);

  // An unread jump into this Work opens the container and, when the target
  // is a folded session, `Show N more`; the group itself opens in the
  // disclosure hook. BoardScreen waits a few frames for this render.
  const appliedRevealTokenRef = useRef(0);
  useEffect(() => {
    if (!revealRequest || revealRequest.token === appliedRevealTokenRef.current) return;
    const index = fragment.groups.findIndex((group) => group.key === revealRequest.groupKey);
    if (index === -1) return;
    appliedRevealTokenRef.current = revealRequest.token;
    setCollapsed(false);
    if (index >= fragment.visibleGroups.length) setShowAll(true);
  }, [fragment.groups, fragment.visibleGroups.length, revealRequest]);

  const shownGroups = showAll ? fragment.groups : fragment.visibleGroups;
  // Drop target (4/5): only for sources in this column — the rule lives in
  // `resolveWorkDrop`, which also makes the source's own Work inert.
  const dnd = useBoardWorkDnD();
  const dropProps = workDropTargetProps(dnd, { kind: 'work', workId: work.id, status });
  const isDropTarget = !!dropProps.onDrop;
  const isDropSelf = !!dnd?.drag && dnd.drag.workId === work.id && dnd.drag.status === status;
  const projectName = getDirectoryProjectName(work.projectDir);

  const jumpTo = (from: HTMLElement, target: KanbanStatus) => {
    const element = boardScope(from).querySelector<HTMLElement>(workFragmentSelector(work.id, target));
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    element.classList.remove('kv2-work-flash');
    // Restart the animation when the same fragment is jumped to twice.
    void element.offsetWidth;
    element.classList.add('kv2-work-flash');
    window.setTimeout(() => element.classList.remove('kv2-work-flash'), WORK_FLASH_MS);
  };

  // Opening always starts from the newest WORK_VISIBLE_SESSIONS; the rest
  // stay behind `Show N more` until asked for again.
  const toggleCollapsed = () => {
    setShowAll(false);
    setCollapsed((previous) => !previous);
  };

  // `⋯` holds the Work's own actions only; folding is the footer toggle.
  const menuItems: BoardColumnMenuItem[] = onWorkOpen
    ? [
      { id: 'open', label: BOARD_WORKS_COPY.menuOpen, onSelect: () => onWorkOpen(work.id) },
      { id: 'rename', label: BOARD_WORKS_COPY.menuRename, onSelect: () => onWorkOpen(work.id, 'rename') },
      { id: 'merge', label: BOARD_WORKS_COPY.menuMerge, onSelect: () => onWorkOpen(work.id, 'merge') },
      { id: 'complete', label: BOARD_WORKS_COPY.menuComplete, onSelect: () => onWorkOpen(work.id, 'complete') },
    ]
    : [];

  return (
    <section
      className={`kv2-work${collapsed ? ' kv2-work--collapsed' : ''}${isDropTarget ? ' is-drop-target' : ''}${isDropSelf ? ' is-drop-self' : ''}`}
      data-work-id={work.id}
      data-work-status={status}
      aria-label={`Work ${work.title}`}
      {...dropProps}
    >
      <span className="kv2-work-tab" aria-hidden="true">{BOARD_GROUP_COPY.workTab}</span>
      <header className="kv2-work-head">
        <button
          type="button"
          className="kv2-work-title"
          title={`${work.title} — ${BOARD_WORKS_COPY.titleHint}`}
          disabled={!onWorkOpen}
          onClick={() => onWorkOpen?.(work.id)}
          onMouseEnter={(event) => setPeerHighlight(event.currentTarget, work.id, true)}
          onMouseLeave={(event) => setPeerHighlight(event.currentTarget, work.id, false)}
          onFocus={(event) => setPeerHighlight(event.currentTarget, work.id, true)}
          onBlur={(event) => setPeerHighlight(event.currentTarget, work.id, false)}
        >
          {work.title}
        </button>
        {menuItems.length > 0 && (
          <BoardColumnMenu
            columnLabel={work.title}
            menuLabel={BOARD_WORKS_COPY.menuLabel(work.title)}
            items={menuItems}
          />
        )}
      </header>

      <div className="kv2-work-meta">
        {projectName && (
          <span
            className={`works-dir-chip kv2-project-chip kv2-work-project ${dirAccentClass(work.projectDir)}`.trim()}
            title={work.projectDir}
          >
            {projectName}
          </span>
        )}
        <span className="kv2-work-count">
          {BOARD_WORKS_COPY.sessionCount(fragment.sessionCount, fragment.totalSessionCount)}
        </span>
        {fragment.favoriteCount > 0 && (
          <span
            className="kv2-favorite-pill"
            title={BOARD_WORKS_COPY.favoriteHint}
            aria-label={`${fragment.favoriteCount} starred`}
          >
            ★ {fragment.favoriteCount}
          </span>
        )}
        {/* Unread and the Work id sit on the meta line, not beside the title —
            next to it they cut a normal Work title down to `Agent-kanban …`. */}
        <span className="kv2-work-meta-end">
          {fragment.unreadCount > 0 && (
            <span
              className="kv2-work-unread"
              title={`${fragment.unreadCount} unread`}
              aria-label={`${fragment.unreadCount} unread`}
            >
              ● {fragment.unreadCount}
            </span>
          )}
          <IdChip id={work.id} kind="work" />
        </span>
      </div>
      {fragment.elsewhere.length > 0 && (
        // Own row: on the meta line they pushed `● N · #id` onto a second line.
        <div className="kv2-work-jumps">
          {fragment.elsewhere.map((share) => (
            <button
              key={share.status}
              type="button"
              className="kv2-work-elsewhere"
              title={BOARD_WORKS_COPY.elsewhereHint}
              onClick={(event) => jumpTo(event.currentTarget, share.status)}
            >
              {STATUS_LABELS[share.status]} {share.sessionCount} ↗
            </button>
          ))}
        </div>
      )}

      {!collapsed && (
        <>
          <div className="kv2-work-body">
            {shownGroups.map((group) => (
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
          {fragment.hiddenCount > 0 && (
            <button
              type="button"
              className="kv2-work-more"
              aria-expanded={showAll}
              onClick={() => setShowAll((previous) => !previous)}
            >
              {showAll ? BOARD_WORKS_COPY.showLess : (
                <>
                  {BOARD_WORKS_COPY.showMore(fragment.hiddenCount)}
                  {fragment.hiddenUnreadCount > 0 && (
                    <>
                      {' · '}
                      <span className="kv2-work-more-unread">● {fragment.hiddenUnreadCount} unread</span>
                    </>
                  )}
                </>
              )}
            </button>
          )}
        </>
      )}

      {/* Same hide / show button as a session group; folded, it names how many sessions it hides. */}
      <div className="kv2-work-foot">
        <button
          type="button"
          className="kv2-complete-session-toggle kv2-work-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? BOARD_WORKS_COPY.expand : BOARD_WORKS_COPY.collapse}
          onClick={toggleCollapsed}
        >
          {collapsed ? BOARD_WORKS_COPY.toggleShow(fragment.sessionCount) : BOARD_WORKS_COPY.toggleHide}
        </button>
        {collapsed && (
          <span className="kv2-work-foot-note">
            {BOARD_WORKS_COPY.hiddenNote(fragment.sessionCount, fragment.unreadCount)}
          </span>
        )}
      </div>
    </section>
  );
};
