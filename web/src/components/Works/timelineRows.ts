import type {
  KanbanStatus,
  TimelineCard,
  TimelineSessionSpan,
  Work,
} from '../../../../src/core/types';
import {
  addDays,
  buildBars,
  columnOf,
  dayDiff,
  startOfDay,
  type TimelineBar,
  type TimelineRange,
} from './timelineModel';

/** Dir group key for a session or Work that has no `projectDir`. */
export const DIR_NONE_KEY = ' no-dir';

/**
 * Where a measured interval lands on the day grid. `null` from `gridSpan` means
 * "no overlap", so the caller draws nothing at all.
 */
export interface TimelineGridSpan {
  /** First visible column (0-based, clamped into the range). */
  startIndex: number;
  /** Last visible column, inclusive (clamped, always `>= startIndex`). */
  endIndex: number;
  /** Started before the range — the left edge is a cut, not a start. */
  clippedLeft: boolean;
  /** Continues past the range's right edge. */
  clippedRight: boolean;
  /** No end recorded yet: the rail runs to today (or the range edge) and stays open. */
  ongoing: boolean;
}

/**
 * Clamps a measured `[start, end]` interval onto the range's columns.
 *
 * The timeline's smallest time unit is a **day**: a three-minute card and a
 * three-hour card both occupy exactly one column. That is deliberate — an hour
 * axis would render most of this board's work as invisible slivers.
 *
 * An interval with no end is treated as running until `now`, which is how a
 * still-executing card keeps its rail open to the today column.
 */
export function gridSpan(
  range: TimelineRange,
  startIso: string,
  endIso: string | undefined,
  now: Date,
  options?: {
    /**
     * The interval is known to reach back past `startIso` — the server had to
     * drop the earlier part (`TimelineSessionSpan.truncatedBefore`). Renders the
     * same cut left edge as a genuinely clipped span, because it *is* one; the
     * only difference is that the clipping happened before the data arrived.
     */
    truncatedBefore?: boolean;
  },
): TimelineGridSpan | null {
  const lastIndex = range.days.length - 1;
  const rawStart = columnOf(range, startIso);
  if (rawStart === null) return null;
  const ongoing = !endIso;
  const rawEnd = ongoing ? dayDiff(range.start, now) : columnOf(range, endIso);
  if (rawEnd === null) return null;
  if (rawEnd < 0 || rawStart > lastIndex) return null;

  const startIndex = Math.max(0, rawStart);
  const endIndex = Math.min(lastIndex, Math.max(rawEnd, rawStart));
  if (endIndex < startIndex) return null;
  return {
    startIndex,
    endIndex,
    clippedLeft: rawStart < 0 || options?.truncatedBefore === true,
    clippedRight: rawEnd > lastIndex,
    ongoing,
  };
}

/** One day of one session row: every card that was running on that day. */
export interface TimelineDayCell {
  column: number;
  /** Hue the cell is painted with — see `CELL_STATUS_PRIORITY`. */
  status: KanbanStatus;
  cards: TimelineCard[];
}

/**
 * A cell shows the *most live* status among the cards running that day, not the
 * last one: a day with one card still in progress and four finished ones is a
 * day the session was working. `done` ranks last because it is the settled
 * state — it should never hide a card that still needs attention.
 */
const CELL_STATUS_PRIORITY: Record<KanbanStatus, number> = {
  in_progress: 0,
  todo: 1,
  complete: 2,
  done: 3,
};

/**
 * Buckets a session's cards into day cells, one entry per column the session
 * actually ran on. A card spanning three days appears in all three cells — it
 * was running on each of them — so the row reads as occupancy, not as events.
 */
export function dayCells(range: TimelineRange, cards: TimelineCard[], now: Date): TimelineDayCell[] {
  const byColumn = new Map<number, TimelineCard[]>();
  for (const card of cards) {
    const span = gridSpan(range, card.startedAt, card.completedAt, now);
    if (!span) continue;
    for (let column = span.startIndex; column <= span.endIndex; column += 1) {
      const bucket = byColumn.get(column);
      if (bucket) bucket.push(card);
      else byColumn.set(column, [card]);
    }
  }

  return Array.from(byColumn, ([column, columnCards]) => {
    let status = columnCards[0]!.status;
    for (const card of columnCards) {
      if (CELL_STATUS_PRIORITY[card.status] < CELL_STATUS_PRIORITY[status]) status = card.status;
    }
    return { column, status, cards: columnCards };
  }).sort((a, b) => a.column - b.column);
}

export interface TimelineDirRow {
  kind: 'dir';
  key: string;
  /**
   * The group's own key (a normalized `projectDir`, or `DIR_NONE_KEY`) — what
   * the collapse set and the directory filter are keyed by. Exposed as a field
   * rather than re-derived by slicing `'dir:'` off `key` in the view.
   */
  groupKey: string;
  projectDir?: string;
  workCount: number;
  sessionCount: number;
  collapsed: boolean;
}

export interface TimelineWorkRow {
  kind: 'work';
  key: string;
  work: Work;
  /**
   * The draggable plan bar. `null` when the Work's own dates fall outside the
   * range even though one of its sessions ran inside it — the bracket still
   * renders, just without a bar to grab.
   */
  bar: TimelineBar | null;
  sessionCount: number;
  collapsed: boolean;
}

export interface TimelineSessionRow {
  kind: 'session';
  key: string;
  session: TimelineSessionSpan;
  /** Owning Work, or undefined for an unassigned (미배정) session. */
  workId?: string;
  /** Measured extent — what actually ran, never a plan. */
  span: TimelineGridSpan;
  cells: TimelineDayCell[];
}

export type TimelineRow = TimelineDirRow | TimelineWorkRow | TimelineSessionRow;

export interface TimelineRowsInput {
  sessions: TimelineSessionSpan[];
  works: Work[];
  range: TimelineRange;
  now: Date;
  collapsedDirs?: ReadonlySet<string>;
  collapsedWorks?: ReadonlySet<string>;
}

/**
 * The Timeline's render order, flattened: directory group → Work bracket →
 * session rows.
 *
 * Three rules shape it, all of them from how this board is actually used:
 *
 * 1. **The session is the smallest row.** Every card belongs to a session, so a
 *    lone card row would have nothing to hang under; cards live inside their
 *    session row as day cells.
 * 2. **Unassigned sessions are shown, marked 미배정** — they are listed after
 *    the Works in their directory, and assigning one simply moves its row under
 *    that Work on the next render.
 * 3. **A Work groups its sessions across directories.** A Work's group is its
 *    own `projectDir`, falling back to the directory most of its visible
 *    sessions came from — the Work owns the sessions, so its rows never split
 *    across two groups.
 */
export function buildTimelineRows(input: TimelineRowsInput): TimelineRow[] {
  const { sessions, works, range, now } = input;
  const collapsedDirs = input.collapsedDirs ?? new Set<string>();
  const collapsedWorks = input.collapsedWorks ?? new Set<string>();

  const workOfSession = new Map<string, Work>();
  for (const work of works) {
    for (const link of work.sessionLinks) workOfSession.set(link.sessionId, work);
  }

  // Only sessions that actually overlap the range get a row; the rest are not
  // "collapsed", they simply did not run in this window.
  const visible: TimelineSessionRow[] = [];
  for (const session of sessions) {
    const span = gridSpan(range, session.startedAt, session.endedAt, now, {
      truncatedBefore: session.truncatedBefore,
    });
    if (!span) continue;
    visible.push({
      kind: 'session',
      key: `session:${session.sessionId}`,
      session,
      workId: workOfSession.get(session.sessionId)?.id,
      span,
      cells: dayCells(range, session.cards, now),
    });
  }

  const barOfWork = new Map<string, TimelineBar>();
  for (const bar of buildBars(works, range, now)) barOfWork.set(bar.work.id, bar);

  const sessionsOfWork = new Map<string, TimelineSessionRow[]>();
  const looseByDir = new Map<string, TimelineSessionRow[]>();
  for (const row of visible) {
    if (row.workId) {
      push(sessionsOfWork, row.workId, row);
    } else {
      push(looseByDir, dirKey(row.session.projectDir), row);
    }
  }

  interface DirGroup {
    projectDir?: string;
    works: Work[];
    loose: TimelineSessionRow[];
    activity: number;
  }
  const groups = new Map<string, DirGroup>();
  const group = (key: string, projectDir: string | undefined): DirGroup => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: DirGroup = { projectDir, works: [], loose: [], activity: 0 };
    groups.set(key, created);
    return created;
  };

  // Works keep `buildBars`'s order inside whichever group they land in.
  for (const work of orderedWorks(works, barOfWork)) {
    const rows = sessionsOfWork.get(work.id) ?? [];
    if (rows.length === 0 && !barOfWork.has(work.id)) continue;
    const dir = work.projectDir ?? majorityDir(rows);
    const target = group(dirKey(dir), dir);
    target.works.push(work);
    target.activity = Math.max(target.activity, workActivity(work), ...rows.map(sessionActivity));
  }

  for (const [key, rows] of looseByDir) {
    const target = group(key, rows[0]!.session.projectDir);
    target.loose.push(...rows);
    target.activity = Math.max(target.activity, ...rows.map(sessionActivity));
  }

  const orderedGroups = Array.from(groups, ([key, value]) => ({ key, ...value }))
    .sort((a, b) => {
      // The directory-less bucket is a leftover, not a project — always last.
      if ((a.key === DIR_NONE_KEY) !== (b.key === DIR_NONE_KEY)) {
        return a.key === DIR_NONE_KEY ? 1 : -1;
      }
      if (b.activity !== a.activity) return b.activity - a.activity;
      return a.key.localeCompare(b.key);
    });

  const rows: TimelineRow[] = [];
  for (const dirGroup of orderedGroups) {
    const groupSessions = dirGroup.works.reduce(
      (total, work) => total + (sessionsOfWork.get(work.id)?.length ?? 0),
      dirGroup.loose.length,
    );
    const dirCollapsed = collapsedDirs.has(dirGroup.key);
    rows.push({
      kind: 'dir',
      key: `dir:${dirGroup.key}`,
      groupKey: dirGroup.key,
      projectDir: dirGroup.projectDir,
      workCount: dirGroup.works.length,
      sessionCount: groupSessions,
      collapsed: dirCollapsed,
    });
    if (dirCollapsed) continue;

    for (const work of dirGroup.works) {
      const workSessions = (sessionsOfWork.get(work.id) ?? [])
        .sort((a, b) => sessionStart(a) - sessionStart(b));
      const workCollapsed = collapsedWorks.has(work.id);
      rows.push({
        kind: 'work',
        key: `work:${work.id}`,
        work,
        bar: barOfWork.get(work.id) ?? null,
        sessionCount: workSessions.length,
        collapsed: workCollapsed,
      });
      if (!workCollapsed) rows.push(...workSessions);
    }

    // Unassigned sessions sit after the Works, newest first — this is the
    // triage pile, and the newest one is the one still on the user's mind.
    rows.push(...dirGroup.loose.sort((a, b) => sessionStart(b) - sessionStart(a)));
  }

  return rows;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function dirKey(projectDir: string | undefined): string {
  return projectDir ? projectDir.replace(/\/+$/, '') : DIR_NONE_KEY;
}

/** Directory most of a Work's visible sessions came from; ties go to the first seen. */
function majorityDir(rows: TimelineSessionRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const dir = row.session.projectDir;
    if (!dir) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

/** `buildBars` order, kept stable for Works whose bar fell outside the range. */
function orderedWorks(works: Work[], bars: Map<string, TimelineBar>): Work[] {
  const order = new Map<string, number>();
  let index = 0;
  for (const id of bars.keys()) {
    order.set(id, index);
    index += 1;
  }
  return [...works].sort((a, b) => {
    const aOrder = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return workActivity(b) - workActivity(a);
  });
}

function epoch(iso: string | undefined): number {
  if (!iso) return 0;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function workActivity(work: Work): number {
  return Math.max(epoch(work.resolvedAt), epoch(work.updatedAt), epoch(work.startedAt));
}

function sessionActivity(row: TimelineSessionRow): number {
  return Math.max(epoch(row.session.endedAt), epoch(row.session.startedAt));
}

function sessionStart(row: TimelineSessionRow): number {
  return epoch(row.session.startedAt);
}

/** Today's column, or null when the range does not contain it. */
export function todayColumn(range: TimelineRange, now: Date): number | null {
  const index = dayDiff(range.start, now);
  return index >= 0 && index < range.days.length ? index : null;
}

/** Inclusive ISO window the grid covers, as `GET /api/timeline` wants it. */
export function rangeWindow(range: TimelineRange): { from: string; to: string } {
  const from = startOfDay(range.start);
  const to = addDays(from, range.days.length);
  return { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() };
}

/* ── Legend · directory filter ────────────────────────────── */

/**
 * Card-status vocabulary for every Timeline surface (legend, day-cell tooltip).
 *
 * Korean throughout, and `complete` reads **검토 대기** rather than `완료`. The
 * two things it had to fix: the legend mixed `완료` with `Done`, so the same
 * screen named one status in Korean and the next in English; and `complete`'s
 * board hue is the pink-red `--kv2-status-complete-accent`, which read as
 * *failed*. The colour stays (the board owns it — see docs/design-system.md),
 * so the label carries the meaning: the agent finished and it is waiting on the
 * user, which is exactly what `complete` means here.
 */
export const TIMELINE_STATUS_LABELS: Record<KanbanStatus, string> = {
  todo: '대기',
  in_progress: '진행중',
  complete: '검토 대기',
  done: '완료',
};

/** Legend entry key — the two structural layers plus the card statuses. */
export type TimelineLegendKey = 'work' | 'session' | KanbanStatus;

export interface TimelineLegendItem {
  key: TimelineLegendKey;
  label: string;
}

const LEGEND_LABELS: Record<TimelineLegendKey, string> = {
  work: 'Work 계획',
  session: '세션 실측',
  ...TIMELINE_STATUS_LABELS,
};

/** Most-live-first, matching `CELL_STATUS_PRIORITY`, after the two layers. */
const LEGEND_ORDER: TimelineLegendKey[] = [
  'work', 'session', 'in_progress', 'todo', 'complete', 'done',
];

/**
 * The legend for what is **actually on screen**.
 *
 * It used to be a fixed six-entry list, which meant it permanently advertised a
 * `대기` swatch: a card only enters the grid once it has executed, so a hue for
 * "not started yet" is at best rare and usually absent, and a legend entry with
 * nothing to point at teaches the reader the wrong model of the view. Deriving
 * it from the rows also makes it self-maintaining — a new status hue shows up in
 * the legend the first time it is drawn.
 */
export function timelineLegend(rows: TimelineRow[]): TimelineLegendItem[] {
  const present = new Set<TimelineLegendKey>();
  for (const row of rows) {
    if (row.kind === 'work') {
      if (row.bar) present.add('work');
      continue;
    }
    if (row.kind !== 'session') continue;
    present.add('session');
    for (const cell of row.cells) present.add(cell.status);
  }
  return LEGEND_ORDER
    .filter((key) => present.has(key))
    .map((key) => ({ key, label: LEGEND_LABELS[key] }));
}

/** One selectable directory group in the Timeline's own filter. */
export interface TimelineDirOption {
  /** `TimelineDirRow.groupKey` — what `filterTimelineRows` matches on. */
  groupKey: string;
  projectDir?: string;
  workCount: number;
  sessionCount: number;
}

/**
 * The directory groups the current grid holds, in render order.
 *
 * Built from the rows rather than from the board's cards (which is what
 * `BoardProjectSwitcher` uses): the Timeline draws archived work, so a project
 * whose cards have all been swept off the board still has rows here and must
 * still be filterable.
 */
export function timelineDirOptions(rows: TimelineRow[]): TimelineDirOption[] {
  const options: TimelineDirOption[] = [];
  for (const row of rows) {
    if (row.kind !== 'dir') continue;
    options.push({
      groupKey: row.groupKey,
      projectDir: row.projectDir,
      workCount: row.workCount,
      sessionCount: row.sessionCount,
    });
  }
  return options;
}

/**
 * Keeps only the rows belonging to directory group `groupKey` (`null` = all).
 *
 * Applied *after* `buildTimelineRows` on purpose: the option list has to
 * describe the whole grid, not the filtered slice, or selecting one directory
 * would erase every other option from the filter.
 */
export function filterTimelineRows(
  rows: TimelineRow[],
  groupKey: string | null,
): TimelineRow[] {
  if (groupKey === null) return rows;
  const kept: TimelineRow[] = [];
  let inGroup = false;
  for (const row of rows) {
    if (row.kind === 'dir') inGroup = row.groupKey === groupKey;
    if (inGroup) kept.push(row);
  }
  return kept;
}
