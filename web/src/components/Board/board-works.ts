import type { KanbanCard, KanbanStatus, Work } from '../../../../src/core/types';
import { groupCompleteCardsBySession, type CompleteSessionGroup } from './BoardCompleteSessionView';
import { groupCardsByParent } from './board-utils';

/**
 * View model for the board's `GROUP: WORKS` mode (docs/mockups/works-on-board.html,
 * B안). Pure: `BoardScreen` feeds it the filtered board and the active Works.
 *
 * A Work is drawn once **per column** it has sessions in — a "fragment". Each
 * fragment holds that column's session groups, newest first; the newest
 * `WORK_VISIBLE_SESSIONS` are shown and the rest fold behind `Show N more`.
 * Sessions no Work links stay in the column's UNASSIGNED zone.
 */

/** B안: a Work shows its newest two session cards per column. */
export const WORK_VISIBLE_SESSIONS = 2;

const BOARD_STATUSES: readonly KanbanStatus[] = ['todo', 'in_progress', 'complete', 'done'];

/** Toolbar FILTER popover `WORK:` choice. Not a `BoardFilters` field — those also drive the Timeline. */
export type BoardWorkFilter = 'all' | 'unassigned' | { workId: string };

export const DEFAULT_BOARD_WORK_FILTER: BoardWorkFilter = 'all';

export interface WorkColumnShare {
  status: KanbanStatus;
  /** Visible session groups of the same Work in that column (`진행중 1 ↗`). */
  sessionCount: number;
}

export interface WorkFragment {
  work: Work;
  status: KanbanStatus;
  /** Every session group of this Work in this column, newest first. */
  groups: CompleteSessionGroup[];
  /** The newest `WORK_VISIBLE_SESSIONS` of `groups`. */
  visibleGroups: CompleteSessionGroup[];
  hiddenCount: number;
  /** Unread turns inside the folded groups (`Show N more · ● k unread`). */
  hiddenUnreadCount: number;
  /** Unread turns across the fragment (Work header `● N`). */
  unreadCount: number;
  /**
   * Top-level favorite cards of the **whole Work on the board**, filters
   * ignored — what the completion sweep leaves behind (`★ N`).
   */
  favoriteCount: number;
  /** `x` of `x / y sessions`. */
  sessionCount: number;
  /** `y` — distinct visible sessions of this Work across every column. */
  totalSessionCount: number;
  /** Other columns holding visible sessions of this Work, in board order. */
  elsewhere: WorkColumnShare[];
  /** Newest response among `groups` — orders fragments inside a column. */
  lastUpdatedAt: string;
}

export interface WorksColumnModel {
  status: KanbanStatus;
  fragments: WorkFragment[];
  /** Session groups no Work links (and every card-keyed group), newest first. */
  unassigned: CompleteSessionGroup[];
}

/** sessionId → Work. Sessions belong to at most one Work (1:N); the first link wins. */
export function indexWorksBySession(works: readonly Work[]): Map<string, Work> {
  const index = new Map<string, Work>();
  for (const work of works) {
    for (const link of work.sessionLinks) {
      if (!index.has(link.sessionId)) index.set(link.sessionId, work);
    }
  }
  return index;
}

/** The Work a card belongs to. A card without `sessionId` can never be linked. */
export function workForCard(card: Pick<KanbanCard, 'sessionId'>, index: Map<string, Work>): Work | undefined {
  return card.sessionId ? index.get(card.sessionId) : undefined;
}

/**
 * Applies the `WORK:` filter. Children follow their parent's session, so the
 * filter is decided on the card's own `sessionId` or, failing that, its
 * parent's — a subagent child without a session must not drop out from under
 * a kept parent.
 */
export function filterCardsByWork(
  cards: KanbanCard[],
  filter: BoardWorkFilter,
  index: Map<string, Work>,
): KanbanCard[] {
  if (filter === 'all') return cards;

  const byId = new Map(cards.map((card) => [card.id, card]));
  const ownerWork = (card: KanbanCard): Work | undefined => {
    if (card.sessionId) return index.get(card.sessionId);
    const parent = card.parentCardId ? byId.get(card.parentCardId) : undefined;
    return parent ? workForCard(parent, index) : undefined;
  };

  return cards.filter((card) => {
    const work = ownerWork(card);
    return filter === 'unassigned' ? !work : work?.id === filter.workId;
  });
}

/**
 * A stored `{ workId }` whose Work is no longer active (completed, merged,
 * deleted) falls back to `all`, so the board never silently shows nothing.
 */
export function resolveWorkFilter(filter: BoardWorkFilter, works: readonly Work[]): BoardWorkFilter {
  if (typeof filter === 'string') return filter;
  return works.some((work) => work.id === filter.workId) ? filter : 'all';
}

/** Favorite cards among `cards` (session header `★ N`). */
export function countFavoriteCards(cards: readonly Pick<KanbanCard, 'favorite'>[]): number {
  return cards.reduce((count, card) => count + (card.favorite ? 1 : 0), 0);
}

/**
 * Favorites of one session group: `total` for the header `★ N`, `hidden` for
 * `Show N more · ★ k`. `visibleTurns` is taken from the newest end — the same
 * slice `BoardCompleteSessionView` folds (`group.cards` is newest first).
 */
export function summarizeGroupFavorites(
  group: Pick<CompleteSessionGroup, 'cards'>,
  visibleTurns: number,
): { total: number; hidden: number } {
  return {
    total: countFavoriteCards(group.cards),
    hidden: countFavoriteCards(group.cards.slice(visibleTurns)),
  };
}

function timeMs(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Splits the board into per-column Work fragments plus the unassigned groups.
 *
 * - `cards` is the board **after** `filterBoardCards` / `filterUnreadOnly` /
 *   `filterCardsByWork` — a Work with no visible session in a column has no
 *   fragment there, and a Work with none anywhere disappears.
 * - `boardCards` is the unfiltered board; only `★ N` reads it.
 * - `works` should be the active Works; a session linked to a closed one is
 *   unassigned on the board.
 */
export function selectWorkFragments({
  cards,
  boardCards = cards,
  works,
  visibleLimit = WORK_VISIBLE_SESSIONS,
}: {
  cards: KanbanCard[];
  boardCards?: KanbanCard[];
  works: readonly Work[];
  visibleLimit?: number;
}): Record<KanbanStatus, WorksColumnModel> {
  const index = indexWorksBySession(works);
  const topLevel = groupCardsByParent(cards);

  const favoritesByWork = new Map<string, number>();
  for (const card of groupCardsByParent(boardCards)) {
    const work = workForCard(card, index);
    if (work && card.favorite) favoritesByWork.set(work.id, (favoritesByWork.get(work.id) ?? 0) + 1);
  }

  // status → workId → groups; plus the unassigned groups per status.
  const byStatus = new Map<KanbanStatus, { byWork: Map<string, CompleteSessionGroup[]>; unassigned: CompleteSessionGroup[] }>();
  const sessionsByWork = new Map<string, Set<string>>();

  for (const status of BOARD_STATUSES) {
    const byWork = new Map<string, CompleteSessionGroup[]>();
    const unassigned: CompleteSessionGroup[] = [];
    for (const group of groupCompleteCardsBySession(topLevel.filter((card) => card.status === status))) {
      // Card-keyed groups (no sessionId) have nothing to link by.
      const work = group.sessionId ? index.get(group.sessionId) : undefined;
      if (!work || !group.sessionId) {
        unassigned.push(group);
        continue;
      }
      const list = byWork.get(work.id);
      if (list) list.push(group);
      else byWork.set(work.id, [group]);
      const seen = sessionsByWork.get(work.id) ?? new Set<string>();
      seen.add(group.sessionId);
      sessionsByWork.set(work.id, seen);
    }
    byStatus.set(status, { byWork, unassigned });
  }

  const workById = new Map(works.map((work) => [work.id, work]));
  const result = {} as Record<KanbanStatus, WorksColumnModel>;

  for (const status of BOARD_STATUSES) {
    const { byWork, unassigned } = byStatus.get(status)!;
    const fragments: WorkFragment[] = [];

    for (const [workId, groups] of byWork) {
      const work = workById.get(workId)!;
      const visibleGroups = groups.slice(0, visibleLimit);
      const hiddenGroups = groups.slice(visibleLimit);
      fragments.push({
        work,
        status,
        groups,
        visibleGroups,
        hiddenCount: hiddenGroups.length,
        hiddenUnreadCount: hiddenGroups.reduce((sum, group) => sum + group.unreadCount, 0),
        unreadCount: groups.reduce((sum, group) => sum + group.unreadCount, 0),
        favoriteCount: favoritesByWork.get(workId) ?? 0,
        sessionCount: groups.length,
        totalSessionCount: sessionsByWork.get(workId)?.size ?? groups.length,
        elsewhere: BOARD_STATUSES
          .filter((other) => other !== status)
          .map((other) => ({ status: other, sessionCount: byStatus.get(other)!.byWork.get(workId)?.length ?? 0 }))
          .filter((share) => share.sessionCount > 0),
        // groups are newest first, so the first one carries the fragment's time.
        lastUpdatedAt: groups[0].lastUpdatedAt,
      });
    }

    fragments.sort((a, b) => (timeMs(b.lastUpdatedAt) - timeMs(a.lastUpdatedAt)) || a.work.id.localeCompare(b.work.id));
    result[status] = { status, fragments, unassigned };
  }

  return result;
}

/* ── Drag & drop / `⋯ → Work로 이동` (GROUP: WORKS) ─────────────────────── */

/** Custom drag MIME carrying `WorkDragSource` (JSON) next to the board's `text/plain` cardId. */
export const WORK_SESSION_DRAG_MIME = 'application/x-kanban-session';

/** What is being dragged (or acted on from `⋯`): a session group header or a todo/in-progress card. */
export interface WorkDragSource {
  /** The card whose id rides in `text/plain` — the group's newest turn, or the card itself. */
  cardId: string;
  /** Absent for a card-keyed group / a card with no session — never assignable. */
  sessionId?: string;
  /** The Work the session belongs to now (active Works only). */
  workId?: string;
  /** Column it was picked up from. Column-bound targets only accept their own column. */
  status: KanbanStatus;
  projectDir?: string;
  /** Session title — seeds the new-Work name. */
  title: string;
}

/**
 * Where it was dropped. `status` marks a target that lives in a column (a Work
 * fragment, the UNASSIGNED zone); the bottom tray's targets have none and work
 * from any column.
 */
export type WorkDropTarget =
  | { kind: 'work'; workId: string; status?: KanbanStatus }
  | { kind: 'unassigned'; status?: KanbanStatus }
  | { kind: 'new' };

export type WorkDropAction =
  | { kind: 'link'; toWorkId: string }
  | { kind: 'move'; fromWorkId: string; toWorkId: string }
  | { kind: 'unlink'; fromWorkId: string }
  | { kind: 'create' }
  | { kind: 'moveToNew'; fromWorkId: string };

/**
 * The Works meaning of a drop, or `null` when it has none — the caller then
 * neither `preventDefault`s nor handles it, so whatever the board already does
 * there keeps happening (e.g. the todo column's reorder). Rules:
 * - no `sessionId` → nothing (a card-keyed group cannot be linked);
 * - a column-bound target in **another** column → nothing (cross-column drags
 *   keep their status meaning, never a silent Work change);
 * - Work → link when unassigned, move when in another Work, nothing for its own;
 * - UNASSIGNED / `⊘` → unlink, only when it has a Work;
 * - `＋ 새 Work` → create, or split out (`moveToNew`) when it has a Work.
 */
export function resolveWorkDrop(source: WorkDragSource, target: WorkDropTarget): WorkDropAction | null {
  if (!source.sessionId) return null;
  if (target.kind !== 'new' && target.status && target.status !== source.status) return null;

  switch (target.kind) {
    case 'work':
      if (target.workId === source.workId) return null;
      return source.workId
        ? { kind: 'move', fromWorkId: source.workId, toWorkId: target.workId }
        : { kind: 'link', toWorkId: target.workId };
    case 'unassigned':
      return source.workId ? { kind: 'unlink', fromWorkId: source.workId } : null;
    case 'new':
      return source.workId ? { kind: 'moveToNew', fromWorkId: source.workId } : { kind: 'create' };
  }
}
