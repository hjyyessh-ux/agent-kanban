import type { Work } from '../../../../src/core/types';
import { formatShortDate } from './worksAssign';

/**
 * Pure date geometry for the Timeline view (the Board tab's `타임라인`).
 *
 * The view is a day grid: one fixed-width column per day over a horizontally
 * scrolling buffer (see "Scroll buffer" below), and a Work's plan bar spans
 * `startedAt → resolvedAt` clamped to that buffer. Everything here is date
 * math on *local* day boundaries — the same boundaries the column headers are
 * rendered from — so a bar never lands one column off from the header it sits
 * under.
 *
 * Row *grouping* (directory → Work → session) and the per-day card buckets live
 * in `timelineRows.ts`, which builds on the primitives here.
 */

/**
 * Zoom level. Both zooms draw the same one-column-per-day grid; the zoom only
 * picks the column width (`TIMELINE_COLUMN_WIDTH`). It used to pick the *range*
 * (one Monday–Sunday week vs. a whole month, paged with ◀▶), which is why the
 * grid could not scroll a single day.
 */
export type TimelineZoom = 'week' | 'month';

/** Day column width per zoom, px. Fixed so the grid really scrolls sideways. */
export const TIMELINE_COLUMN_WIDTH: Record<TimelineZoom, number> = {
  week: 78,
  month: 34,
};

/** The Works tab's strip: one density, between the two zooms. */
export const STRIP_COLUMN_WIDTH = 56;

/** Milliseconds in a day; only safe for spans that ignore DST (we re-normalize). */
const DAY_MS = 86_400_000;

/** Local midnight of `date`'s day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday-based week start (the mockup's 월~일 column order). */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  // getDay(): 0 = Sunday → 6 days back to Monday.
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

/** Whole local days from `from`'s midnight to `to`'s midnight (may be negative). */
export function dayDiff(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.round((b - a) / DAY_MS);
}

/**
 * The day columns the grid holds — the whole scroll **buffer**, not just what is
 * on screen. Every column index in this module (bars, rails, drag geometry) is
 * relative to `start`.
 */
export interface TimelineRange {
  /** Local midnight of the first column. */
  start: Date;
  /** One column per day, `start` first. */
  days: Date[];
}

/* ── Scroll buffer ────────────────────────────────────────── */
// The grid is a horizontally scrolling strip of fixed-width day columns. Only a
// finite *buffer* of days is rendered; reaching within `BUFFER_EDGE_DAYS` of
// either end grows it by `BUFFER_EXTEND_DAYS`, and the view compensates
// `scrollLeft` for anything added before (or trimmed from) the old first column
// so the dates under the user's eye do not jump. That is what makes the past
// effectively endless while the DOM stays bounded by `TIMELINE_BUFFER_MAX_DAYS`.

export interface TimelineBuffer {
  /** Local midnight of column 0. */
  start: Date;
  dayCount: number;
}

/** Days kept before today when a buffer is (re)built. */
export const BUFFER_INITIAL_PAST_DAYS = 56;
/** Days kept after the last visible day when a buffer is (re)built. */
export const BUFFER_INITIAL_FUTURE_DAYS = 28;
/** Distance from either end that triggers growth. */
export const BUFFER_EDGE_DAYS = 7;
/** How much one growth step adds. */
export const BUFFER_EXTEND_DAYS = 28;
/**
 * Hard cap on rendered columns. Growing past it trims the *opposite* end, so
 * scrolling a year into the past keeps ~24 weeks in the DOM, not 52. Every row
 * renders one background cell per column, so this is a DOM-size bound first.
 *
 * It also bounds the API read: the fetch window is the visible slice plus
 * margins (`timelineFetchWindow`), never more than the buffer plus the
 * alignment slack — well inside the server's `TIMELINE_MAX_WINDOW_DAYS` (400).
 * `timelineModel.test.ts` pins that relationship.
 */
export const TIMELINE_BUFFER_MAX_DAYS = 168;

export function rangeFromBuffer(buffer: TimelineBuffer): TimelineRange {
  return { start: buffer.start, days: buildDays(buffer.start, buffer.dayCount) };
}

/**
 * A fresh buffer around today: `BUFFER_INITIAL_PAST_DAYS` behind it, and enough
 * ahead that `visibleDays` columns starting at today still leave a growth margin.
 * Used on mount and by `오늘`, which may land far from wherever the old buffer
 * had drifted.
 */
export function bufferAroundToday(now: Date, visibleDays = 0): TimelineBuffer {
  const ahead = Math.max(visibleDays, 14) + BUFFER_INITIAL_FUTURE_DAYS;
  return {
    start: addDays(startOfDay(now), -BUFFER_INITIAL_PAST_DAYS),
    dayCount: Math.min(TIMELINE_BUFFER_MAX_DAYS, BUFFER_INITIAL_PAST_DAYS + ahead),
  };
}

export type BufferEdge = 'start' | 'end';

export interface BufferExtension {
  buffer: TimelineBuffer;
  /**
   * Columns inserted before the old column 0 (negative: trimmed from the
   * front). The view adds `shift × columnWidth` to `scrollLeft` so the same
   * dates stay under the viewport, and to anything else holding a column index.
   */
  shift: number;
}

/**
 * Grows `buffer` by `days` at `edge`, trimming the opposite end once it would
 * exceed `max`. Prepending moves every existing column right by `days`;
 * appending past the cap drops columns off the front, moving them left.
 */
export function extendBuffer(
  buffer: TimelineBuffer,
  edge: BufferEdge,
  days = BUFFER_EXTEND_DAYS,
  max = TIMELINE_BUFFER_MAX_DAYS,
): BufferExtension {
  if (edge === 'start') {
    return {
      buffer: {
        start: addDays(buffer.start, -days),
        // Over the cap → the far (future) end is what gets dropped.
        dayCount: Math.min(max, buffer.dayCount + days),
      },
      shift: days,
    };
  }
  const grown = buffer.dayCount + days;
  const trimmed = Math.max(0, grown - max);
  return {
    buffer: { start: addDays(buffer.start, trimmed), dayCount: grown - trimmed },
    shift: -trimmed,
  };
}

/** The day columns currently on screen, as buffer indices (inclusive). */
export interface VisibleColumns {
  first: number;
  last: number;
}

/**
 * Which columns the viewport shows.
 *
 * The label column is `position: sticky` *inside* the scroller, so column `i`
 * sits at content x = `labelWidth + i × columnWidth` and the first column fully
 * right of the label is `scrollLeft / columnWidth` — the label width cancels
 * out. Rounded rather than floored: scroll-snap lands exactly on a column, and a
 * sub-pixel `scrollLeft` (zoomed browsers) must not read as the previous day.
 */
export function visibleColumns(
  scrollLeft: number,
  clientWidth: number,
  labelWidth: number,
  columnWidth: number,
  dayCount: number,
): VisibleColumns {
  if (!(columnWidth > 0) || dayCount <= 0) return { first: 0, last: 0 };
  const lastIndex = dayCount - 1;
  const first = Math.min(lastIndex, Math.max(0, Math.round(scrollLeft / columnWidth)));
  const span = Math.max(1, Math.floor((clientWidth - labelWidth) / columnWidth));
  return { first, last: Math.min(lastIndex, first + span - 1) };
}

/**
 * Which end (if any) the viewport is close enough to that the buffer should
 * grow. The start wins a tie — a viewport wider than the whole buffer grows
 * into the past first, which is where a timeline's content is.
 */
export function bufferEdgeToExtend(
  visible: VisibleColumns,
  dayCount: number,
  edgeDays = BUFFER_EDGE_DAYS,
): BufferEdge | null {
  if (visible.first < edgeDays) return 'start';
  if (visible.last > dayCount - 1 - edgeDays) return 'end';
  return null;
}

/** `scrollLeft` that puts buffer column `column` first in the viewport. */
export function scrollLeftForColumn(column: number, columnWidth: number): number {
  return Math.max(0, column) * columnWidth;
}

/**
 * First visible column for "today": the `오늘` button puts today **second from
 * the left** (one day of context behind it, the rest ahead); the initial view
 * puts it second from the right, because what a timeline mostly shows is work
 * that already ran.
 */
export function firstColumnForToday(
  todayIndex: number,
  visibleDays: number,
  anchor: 'left' | 'right',
): number {
  if (anchor === 'left') return Math.max(0, todayIndex - 1);
  return Math.max(0, todayIndex - Math.max(1, visibleDays) + 2);
}

/* ── API window ───────────────────────────────────────────── */

/** Fetch windows snap to this many days, so scrolling a day does not refetch. */
export const FETCH_ALIGN_DAYS = 14;
/** Extra days fetched on each side of the viewport before alignment. */
export const FETCH_MARGIN_DAYS = 7;
/** A Monday, local — the phase every 14-day block is counted from. */
const FETCH_ALIGN_EPOCH = new Date(2024, 0, 1);

function alignDown(day: Date): Date {
  const offset = dayDiff(FETCH_ALIGN_EPOCH, day);
  const block = Math.floor(offset / FETCH_ALIGN_DAYS) * FETCH_ALIGN_DAYS;
  return addDays(FETCH_ALIGN_EPOCH, block);
}

/** Inclusive ISO window covering `dayCount` whole local days from `start`. */
export function dayWindow(start: Date, dayCount: number): { from: string; to: string } {
  const from = startOfDay(start);
  const to = addDays(from, dayCount);
  return { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() };
}

/**
 * The `GET /api/timeline` window for what is on screen: from the visible
 * columns minus `FETCH_MARGIN_DAYS`, snapped down to a `FETCH_ALIGN_DAYS` block
 * boundary on a fixed phase, for a whole number of blocks that always reaches
 * past the last visible column plus the margin.
 *
 * The length depends only on how many columns are visible, so while scrolling
 * the window — and so `useTimeline`'s request key — changes exactly when the
 * start crosses a block boundary: once per 14 days, not once per day.
 */
export function timelineFetchWindow(
  range: TimelineRange,
  visible: VisibleColumns,
): { from: string; to: string } {
  const first = alignDown(addDays(range.start, visible.first - FETCH_MARGIN_DAYS));
  const span = Math.max(1, visible.last - visible.first + 1);
  const blocks = Math.ceil((span + 2 * FETCH_MARGIN_DAYS + FETCH_ALIGN_DAYS - 1) / FETCH_ALIGN_DAYS);
  return dayWindow(first, blocks * FETCH_ALIGN_DAYS);
}

/* ── Labels ───────────────────────────────────────────────── */

const RANGE_LABEL_FMT = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const RANGE_LABEL_SHORT_FMT = new Intl.DateTimeFormat('ko-KR', {
  month: 'long',
  day: 'numeric',
});

/** Heading for the visible slice, e.g. `2026년 10월 3일 – 10월 16일`. */
export function visibleRangeLabel(range: TimelineRange, visible: VisibleColumns): string {
  const first = range.days[visible.first];
  const last = range.days[visible.last];
  if (!first || !last) return '';
  const end = first.getFullYear() === last.getFullYear()
    ? RANGE_LABEL_SHORT_FMT.format(last)
    : RANGE_LABEL_FMT.format(last);
  return `${RANGE_LABEL_FMT.format(first)} – ${end}`;
}

/** One calendar month's run of columns, for the month band above the header. */
export interface TimelineMonthSegment {
  /** First column of the run (inclusive). */
  startIndex: number;
  /** Last column of the run (inclusive). */
  endIndex: number;
  /** `2026년 10월`. */
  label: string;
}

/**
 * The buffer split at month boundaries. The day header only shows day numbers
 * (`28 29 30 1 2`), so without this band a month change was invisible.
 */
export function monthSegments(range: TimelineRange): TimelineMonthSegment[] {
  const segments: TimelineMonthSegment[] = [];
  range.days.forEach((day, index) => {
    const current = segments[segments.length - 1];
    if (current && day.getDate() !== 1) {
      current.endIndex = index;
      return;
    }
    segments.push({
      startIndex: index,
      endIndex: index,
      label: `${day.getFullYear()}년 ${day.getMonth() + 1}월`,
    });
  });
  return segments;
}

function buildDays(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

/** Column index of `iso` within the range, or `null` when it is not a real date. */
export function columnOf(range: TimelineRange, iso: string | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return dayDiff(range.start, date);
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export interface TimelineBar {
  work: Work;
  /** First visible column (0-based, clamped into the range). */
  startIndex: number;
  /** Last visible column, inclusive (clamped, always `>= startIndex`). */
  endIndex: number;
  /**
   * The bar's *real* start column — negative when the Work began before the
   * range. `startIndex` is the clamped, drawable one.
   *
   * Both exist because they answer different questions. Rendering wants the
   * clamped column (a bar cannot be drawn at column −12). **Editing wants the
   * raw one**: a keyboard nudge on the left handle of a bar that started 8/20,
   * viewed in the 9/1 week, has to move 8/20 → 8/21. Nudging the clamped column
   * moved it to 9/2 instead and silently destroyed nearly two weeks of history.
   */
  rawStartIndex: number;
  /** The bar's real end column — may exceed the last column. See `rawStartIndex`. */
  rawEndIndex: number;
  /** The Work started before the range — the bar's left edge is a cut, not a start. */
  clippedLeft: boolean;
  /** The bar continues past the range's right edge. */
  clippedRight: boolean;
  /** Unresolved Work: the bar runs to today (or the range edge) and stays open. */
  ongoing: boolean;
  /** Unresolved Work carrying an explicit end — a *planned* date, not a completion. */
  plannedEnd: boolean;
  /** `resolvedAt` column when the Work was discarded inside the range. */
  discardedIndex: number | null;
}

/**
 * The true (unclamped) end column of a Work's bar: its `resolvedAt` column, or
 * the today column when it has none.
 *
 * An `active` Work usually has no `resolvedAt` (a terminal transition stamps
 * it), and then the bar simply runs to the today column — past the range's
 * right edge when the user is looking at an earlier week. But `resolvedAt` can
 * also be set *while* the Work is still open, by dragging the bar's right edge
 * or typing a date in the detail dialog: that is a planned end, and the bar
 * ends exactly where it was put rather than tracking today. Clearing the date
 * puts the bar back on today.
 *
 * `updatedAt` is deliberately **not** a fallback for a terminal Work. Every
 * terminal transition stamps `resolvedAt` (docs/invariants.md), so the only
 * records that arrive without one are damaged — and borrowing `updatedAt` made
 * a finished Work's bar grow by a day every time someone edited its title.
 * Drawing to today instead is visible rather than plausible.
 */
function rawEndColumn(work: Work, range: TimelineRange, todayIndex: number): number {
  return columnOf(range, work.resolvedAt) ?? todayIndex;
}

/**
 * Bars for every Work that overlaps the range, in render order: unresolved
 * Works oldest-first, then resolved Works most-recent-first. Works with no
 * overlap are dropped.
 *
 * This is the Work's **plan** bar only. The measured session rails that nest
 * under it — including unassigned sessions, which do appear on the grid marked
 * 미배정 — are built in `timelineRows.ts`.
 */
export function buildBars(works: Work[], range: TimelineRange, now: Date): TimelineBar[] {
  const lastIndex = range.days.length - 1;
  const todayIndex = dayDiff(range.start, now);
  const bars: TimelineBar[] = [];

  for (const work of works) {
    const rawStart = columnOf(range, work.startedAt);
    if (rawStart === null) continue;
    const rawEnd = rawEndColumn(work, range, todayIndex);
    // A Work that ended before the range or starts after it has nothing to draw.
    if (rawEnd < 0 || rawStart > lastIndex) continue;

    const startIndex = Math.max(0, rawStart);
    const endIndex = Math.min(lastIndex, Math.max(rawEnd, rawStart));
    if (endIndex < startIndex) continue;

    bars.push({
      work,
      startIndex,
      endIndex,
      rawStartIndex: rawStart,
      rawEndIndex: Math.max(rawEnd, rawStart),
      clippedLeft: rawStart < 0,
      clippedRight: rawEnd > lastIndex,
      ongoing: work.status === 'active',
      plannedEnd: work.status === 'active' && columnOf(range, work.resolvedAt) !== null,
      discardedIndex:
        work.status === 'discarded' && rawEnd >= 0 && rawEnd <= lastIndex ? rawEnd : null,
    });
  }

  return bars.sort(compareBars);
}

function resolvedTime(work: Work): number {
  const iso = work.resolvedAt ?? work.updatedAt;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function startedTime(work: Work): number {
  const time = new Date(work.startedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Unresolved first (oldest start first), then resolved (most recent first). */
function compareBars(a: TimelineBar, b: TimelineBar): number {
  const aOpen = a.work.status === 'active';
  const bOpen = b.work.status === 'active';
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  if (aOpen) return startedTime(a.work) - startedTime(b.work);
  return resolvedTime(b.work) - resolvedTime(a.work);
}

// ─── Date editing ───────────────────────────────────────────────────
// Both edit paths (a bar-edge drag on the Timeline, the date inputs in the Work
// detail dialog) end up here: they pick a *day* and this module turns it into an
// ISO timestamp. The original timestamp's time-of-day is carried over so moving
// a bar one column never silently rewrites the hour a Work actually started at.

/** Which end of a bar an edit is moving. */
export type TimelineEdge = 'start' | 'end';

/** A bar's column span — the unit both the drag preview and `resizeBar` speak. */
export interface TimelineSpan {
  startIndex: number;
  endIndex: number;
}

/**
 * Day column under a pointer at `clientX`, clamped into the range. `left` is
 * column 0's viewport x and `width` one column's width. The grid scrolls, so
 * column 0 is usually far off-screen to the left (`left` negative); the caller
 * measures it once per drag and shifts it by however far the scroller has
 * moved since (`dragColumnLeft`), which keeps a drag exact under wheel scroll.
 */
export function columnAtPointer(
  clientX: number,
  left: number,
  width: number,
  columnCount: number,
): number {
  if (!(width > 0) || columnCount <= 0) return 0;
  const raw = Math.floor((clientX - left) / width);
  return Math.min(columnCount - 1, Math.max(0, raw));
}

/** Column 0's viewport x now, from a measurement taken at another scroll offset. */
export function dragColumnLeft(
  measuredLeft: number,
  scrollLeftAtMeasure: number,
  scrollLeftNow: number,
): number {
  return measuredLeft - (scrollLeftNow - scrollLeftAtMeasure);
}

/**
 * Move one edge of `span` to `column`. The bar can never invert: dragging the
 * start past the end (or the end before the start) collapses it to a single day
 * instead of flipping it.
 */
export function resizeBar(span: TimelineSpan, edge: TimelineEdge, column: number): TimelineSpan {
  if (edge === 'start') {
    return { startIndex: Math.min(column, span.endIndex), endIndex: span.endIndex };
  }
  return { startIndex: span.startIndex, endIndex: Math.max(column, span.startIndex) };
}

/** Apply `sourceIso`'s time-of-day to a local day, as an ISO string. */
function withTimeOfDay(day: Date, sourceIso: string | undefined): string {
  const source = sourceIso ? new Date(sourceIso) : null;
  const valid = source && !Number.isNaN(source.getTime()) ? source : null;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    valid ? valid.getHours() : 0,
    valid ? valid.getMinutes() : 0,
    valid ? valid.getSeconds() : 0,
    valid ? valid.getMilliseconds() : 0,
  ).toISOString();
}

/**
 * Local end-of-day, where a *manually set* end date lands.
 *
 * Ends are asymmetric with starts on purpose. A start carries a real moment
 * (the first card's `startedAt`), so re-dating it keeps the clock time. An end
 * the user typed or dragged means "the Work ran through this day", and there is
 * no meaningful clock time to carry — an active Work has no `resolvedAt` at
 * all, so the alternative would be to borrow `updatedAt`'s arbitrary time. That
 * arbitrary time also breaks same-day bars: a start at 14:00 with an end
 * borrowed at 09:00 is an inverted instant the store rightly rejects, even
 * though the user picked a perfectly valid one-day span. End-of-day makes every
 * `end >= start` day pair valid.
 */
function endOfDay(day: Date): string {
  return new Date(
    day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999,
  ).toISOString();
}

/**
 * ISO timestamp for day column `column` of `range`, keeping `sourceIso`'s clock
 * time (local midnight without one). Use for start dates and for labels.
 */
export function isoForColumn(range: TimelineRange, column: number, sourceIso?: string): string {
  return withTimeOfDay(addDays(range.start, column), sourceIso);
}

/** `isoForColumn`'s end-date twin — day column `column` at local end-of-day. */
export function endIsoForColumn(range: TimelineRange, column: number): string {
  return endOfDay(addDays(range.start, column));
}

/** `yyyy-mm-dd` for an `<input type="date">`, on the grid's local day boundary. */
export function toDateInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses an `<input type="date">` value; `null` while it is incomplete/invalid. */
function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

/** Inverse of `toDateInputValue` for a **start** date — keeps the clock time. */
export function fromDateInputValue(value: string, sourceIso?: string): string | null {
  const day = parseDateInputValue(value);
  return day ? withTimeOfDay(day, sourceIso) : null;
}

/** Inverse of `toDateInputValue` for an **end** date — lands at end-of-day. */
export function endFromDateInputValue(value: string): string | null {
  const day = parseDateInputValue(value);
  return day ? endOfDay(day) : null;
}

/**
 * Sentence for the undo toast a bar-edge edit leaves behind.
 *
 * A drag and a `→` keypress both rewrite a stored date with no confirmation
 * step, so the only safety net is being told what changed and being able to put
 * it back — the same contract the Works session actions already use
 * (`WorkSessionNotice`).
 */
export function describeWorkDateEdit(
  title: string,
  edge: TimelineEdge,
  iso: string,
  options?: { planned?: boolean },
): string {
  const field = edge === 'start'
    ? '시작일'
    : (options?.planned ? '종료 예정일' : '종료일');
  return `"${title}" ${field}을 ${formatShortDate(iso)}로 옮겼습니다.`;
}

/* ── Failure copy ─────────────────────────────────────────── */

/**
 * A sentence a user can act on, from whatever `fetch`/the route produced.
 *
 * The banner used to print the raw message, so a missing route read as the
 * single word `Not found` above a grid that had *also* drawn itself empty — two
 * signals that together said "nothing ran this week" when the truth was "we
 * never asked successfully". The grid is dimmed alongside this (see
 * `.timeline--errored`), and the raw text is kept in parentheses for anything
 * unrecognized so a bug report still carries it.
 */
export function describeTimelineError(raw: string): string {
  const text = raw.trim();
  if (/not found|404/i.test(text)) {
    return '서버에 타임라인 API가 없습니다. 데몬을 최신 버전으로 다시 시작해 주세요.';
  }
  if (/failed to fetch|networkerror|load failed|econnrefused/i.test(text)) {
    return '서버에 연결할 수 없습니다. 데몬이 실행 중인지 확인해 주세요.';
  }
  if (/must not exceed/i.test(text)) {
    return '조회 기간이 너무 깁니다. 오늘 버튼으로 돌아간 뒤 다시 시도해 주세요.';
  }
  if (/iso 8601|precede/i.test(text)) {
    return '조회 기간이 잘못 전달됐습니다. 오늘로 돌아간 뒤 다시 시도해 주세요.';
  }
  return `타임라인을 불러오는 중 문제가 생겼습니다${text ? ` (원문: ${text})` : ''}.`;
}

/* ── Label column width ───────────────────────────────────── */

/**
 * Default width of the `Work` label column, matching `--tl-label-width`'s CSS
 * fallback.
 *
 * 240px, not the original 180px: at 180 a Korean Work title ellipsized after
 * roughly eight characters, so the default view of a real board was a column of
 * `타임라인 뷰의 범례…`. The column is still resizable in both directions, and a
 * persisted narrower width is untouched.
 */
export const DEFAULT_LABEL_WIDTH = 240;

/**
 * Resize bounds for the label column. The floor keeps a title readable at all
 * (below ~120px even a short project name ellipsizes to nothing), the ceiling
 * keeps at least a few day columns visible on a 1280px viewport.
 */
export const MIN_LABEL_WIDTH = 120;
export const MAX_LABEL_WIDTH = 560;

/** Label-column width step for a keyboard nudge on the resizer. */
export const LABEL_WIDTH_STEP = 16;

/** Clamps a dragged/nudged/persisted width into the resize bounds. */
export function clampLabelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_LABEL_WIDTH;
  return Math.round(Math.min(MAX_LABEL_WIDTH, Math.max(MIN_LABEL_WIDTH, width)));
}
