import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineSessionSpan, Work } from '../../../../src/core/types';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import { useTimeline } from '../../hooks/useTimeline';
import { describeWorkPlanOverrun, formatShortDate, projectDirLabel } from './worksAssign';
import { dirAccentClass } from './worksAffinity';
import type { WorkSessionNoticeState } from './WorkSessionNotice';
import {
  buildRange,
  clampLabelWidth,
  columnAtPointer,
  dayDiff,
  describeTimelineError,
  describeWorkDateEdit,
  endIsoForColumn,
  isWeekend,
  isoForColumn,
  resizeBar,
  startOfDay,
  DEFAULT_LABEL_WIDTH,
  LABEL_WIDTH_STEP,
  MAX_LABEL_WIDTH,
  MIN_LABEL_WIDTH,
  type TimelineBar,
  type TimelineEdge,
  type TimelineMode,
  type TimelineRange,
  type TimelineSpan,
} from './timelineModel';
import {
  buildTimelineRows,
  filterTimelineRows,
  filterTimelineSessions,
  filterTimelineWorks,
  type TimelineSessionFilter,
  rangeWindow,
  timelineDirOptions,
  timelineLegend,
  TIMELINE_STATUS_LABELS,
  type TimelineDayCell,
  type TimelineDirOption,
  type TimelineDirRow,
  type TimelineRow,
  type TimelineSessionRow,
  type TimelineWorkRow,
} from './timelineRows';
import './Timeline.css';

/**
 * Partial date PATCH — never both ends at once. `resolvedAt: null` clears a
 * planned end so an open Work's bar tracks today again (the detail dialog's
 * "지우기" does that; a drag only ever sets a date).
 */
export interface WorkDatePatch {
  startedAt?: string;
  resolvedAt?: string | null;
}

export interface TimelineViewProps {
  works: Work[];
  loading: boolean;
  error: UiAlert | null;
  /** Open the Work detail dialog (WorkDetailDialog, reused from the Works tab). */
  onOpenWork: (work: Work) => void;
  /**
   * Commit a bar-edge edit. Omitted → the bars render read-only (no handles).
   * Errors surface through the shared Works error alert, so this may reject.
   */
  onUpdateWorkDates?: (workId: string, patch: WorkDatePatch) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  /** Open one card's detail — a day cell holding a single card. */
  onOpenCard?: (cardId: string) => void;
  /** Open a session's conversation — the session rail, or a multi-card day cell. */
  onOpenSession?: (sessionId: string) => void;
  /** Start assignment for a 미배정 session row. */
  onAssignSession?: (sessionId: string) => void;
  /**
   * The Board tab's FILTER bar. The same bar is shown above every board view,
   * so what it says must hold here too — see `filterTimelineSessions`.
   */
  sessionFilter?: TimelineSessionFilter;
  /**
   * Show a transient notice with an undo. A bar-edge edit rewrites a stored date
   * with no confirmation, so this is the only way back — it is owned by `App`
   * (same bar the Works session actions use) rather than rendered here.
   */
  onNotify?: (notice: WorkSessionNoticeState) => void;
}

const DOW_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

const MODE_LABELS: Record<TimelineMode, string> = {
  week: '주간',
  month: '월간',
};

const MODES: TimelineMode[] = ['week', 'month'];

/** Persisted label-column width, so a widened label column survives a reload. */
/**
 * What a session row is called. `sessionTitle` when the runtime set one; else
 * the *oldest* card's title (its first prompt — the same rule the Works Inbox
 * and the Work detail use); else the raw id. Claude-runtime cards never carry a
 * `sessionTitle`, so without the middle step every one of their rows read as a
 * UUID while the Inbox row for the same session read as a sentence.
 */
function sessionLabel(session: TimelineSessionSpan): string {
  const explicit = session.sessionTitle?.trim();
  if (explicit) return explicit;
  const oldest = [...session.cards].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  const fromCard = oldest?.title?.trim();
  return fromCard || session.sessionId;
}

const LABEL_WIDTH_STORAGE_KEY = 'kanban-timeline-label-width';
/** Persisted subagent toggle — hidden by default (they triple the row count). */
const SUBAGENT_STORAGE_KEY = 'kanban-timeline-subagents';
/**
 * Whether the how-to-read block has been shown once. The five-line footnote used
 * to be permanent chrome under every grid; it is an onboarding explanation, so
 * it opens on the first visit and then lives behind the `?` button.
 */
const HELP_SEEN_STORAGE_KEY = 'kanban-timeline-help-seen';

function readLabelWidth(): number {
  try {
    const raw = localStorage.getItem(LABEL_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_LABEL_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampLabelWidth(parsed) : DEFAULT_LABEL_WIDTH;
  } catch {
    // Private-mode / disabled storage — the default is a fine answer.
    return DEFAULT_LABEL_WIDTH;
  }
}

function writeLabelWidth(width: number): void {
  try {
    localStorage.setItem(LABEL_WIDTH_STORAGE_KEY, String(width));
  } catch { /* quota exceeded */ }
}

function readShowSubagents(): boolean {
  try {
    return localStorage.getItem(SUBAGENT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** First visit → open the help block. Storage failures count as "already seen". */
function readHelpUnseen(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

const EDGE_LABELS: Record<TimelineEdge, string> = {
  start: '시작일',
  end: '종료일',
};

/** `8/31`-style column header, on the same local day boundaries as the grid. */
const COLUMN_DATE_FMT = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric',
  day: 'numeric',
});

function columnDateLabel(date: Date): string {
  return COLUMN_DATE_FMT.format(date).replace(/\.\s*$/, '').replace(/\.\s*/g, '/');
}

/**
 * Month view has ~34px columns, too narrow for `M/D`, so it falls back to the
 * bare day-of-month the way a calendar grid does — the range label above the
 * grid already names the month.
 */
function compactDateLabel(date: Date): string {
  return String(date.getDate());
}

/** Monday-based day-of-week label for a column header. */
function dowLabel(date: Date): string {
  return DOW_LABELS[(date.getDay() + 6) % 7];
}

function statusClass(work: Work): string {
  return `tl-bar--${work.status}`;
}

/** In-flight edge drag. `origin` is the span the drag started from. */
interface DragState {
  workId: string;
  edge: TimelineEdge;
  origin: TimelineSpan;
  preview: TimelineSpan;
}

/** The day columns' left edge and per-column width, measured from the DOM. */
function measureColumns(
  grid: HTMLElement | null,
  columnCount: number,
): { left: number; width: number } | null {
  if (!grid || columnCount <= 0) return null;
  const first = grid.querySelector<HTMLElement>('[data-tl-col="0"]');
  const last = grid.querySelector<HTMLElement>(`[data-tl-col="${columnCount - 1}"]`);
  if (!first || !last) return null;
  const firstRect = first.getBoundingClientRect();
  const lastRect = last.getBoundingClientRect();
  const width = (lastRect.right - firstRect.left) / columnCount;
  return width > 0 ? { left: firstRect.left, width } : null;
}

/**
 * Every callback the memoized row components need, bundled so the bundle itself
 * can be referentially stable.
 *
 * The rows re-render on a 3s/10s poll cadence *and* on every column a drag
 * crosses, over a grid that is 35 columns × ~60 rows in the month view. That is
 * only affordable if `React.memo` on the row components can actually bail out —
 * which it cannot while `App` hands down a fresh inline arrow per render. So the
 * props arrive here through a ref and the wrappers are created once.
 */
interface TimelineHandlers {
  openWork: (work: Work) => void;
  openCard?: (cardId: string) => void;
  openSession?: (sessionId: string) => void;
  assignSession?: (sessionId: string) => void;
  toggleDir: (groupKey: string) => void;
  toggleWork: (workId: string) => void;
  beginDrag: (bar: TimelineBar, edge: TimelineEdge, event: React.PointerEvent) => void;
  moveDrag: (event: React.PointerEvent) => void;
  endDrag: (bar: TimelineBar) => void;
  nudgeEdge: (bar: TimelineBar, edge: TimelineEdge, delta: number) => void;
}

/**
 * The row's day background: weekend hatching, today's rule, and the row's
 * bottom border. Rendered per cell (rather than as full-height column stripes)
 * so the today rule stays continuous while the month view scrolls sideways.
 */
const RowCells = memo(function RowCells({
  range,
  gridRow,
  todayIndex,
  kind,
}: {
  range: TimelineRange;
  gridRow: number;
  todayIndex: number;
  kind: TimelineRow['kind'];
}) {
  return (
    <>
      {range.days.map((day, index) => {
        const classes = [
          'tl-cell',
          `tl-cell--${kind}`,
          isWeekend(day) ? 'tl-cell--weekend' : '',
          index === todayIndex ? 'tl-cell--today' : '',
        ].filter(Boolean).join(' ');
        return (
          <div
            key={day.getTime()}
            className={classes}
            style={{ gridRow, gridColumn: index + 2 }}
          />
        );
      })}
    </>
  );
});

interface TimelineRowBarProps {
  bar: TimelineBar;
  row: number;
  /** Rendered span — the drag preview while this bar's edge is being dragged. */
  span: TimelineSpan;
  range: TimelineRange;
  dragging: boolean;
  resizable: boolean;
  /** Month view: ~34px columns, so the edge hints shrink instead of vanishing. */
  compact: boolean;
  handlers: TimelineHandlers;
}

/**
 * One Work's plan bar plus its two resize handles. This is the *planned* extent
 * — drag-editable — as opposed to the measured session rails nested under it,
 * which is why it is painted in ink rather than in a status hue: the colour
 * budget is spent on the cards' statuses.
 *
 * The handles are siblings of the bar rather than children: the bar is a
 * `<button>` (click → Work detail), and a button cannot nest interactive
 * children. `.tl-bar-slot` owns the grid placement so both can share it.
 */
const TimelineRowBar = memo(function TimelineRowBar({
  bar,
  row,
  span,
  range,
  dragging,
  resizable,
  compact,
  handlers,
}: TimelineRowBarProps) {
  const { work } = bar;
  // An `active` Work whose planned end has passed. The bar already *stops* at
  // that date, but a bar ending in the past looked exactly like one ending in
  // the future — the ▸ label said "9/1 예정" either way.
  const overrun = describeWorkPlanOverrun(work);
  const classes = [
    'tl-bar',
    statusClass(work),
    overrun ? 'tl-bar--overrun' : '',
    bar.ongoing ? 'tl-bar--ongoing' : '',
    bar.clippedLeft ? 'tl-bar--clipped-left' : '',
    bar.clippedRight ? 'tl-bar--clipped-right' : '',
  ].filter(Boolean).join(' ');

  const slotClasses = [
    'tl-bar-slot',
    bar.clippedLeft ? 'tl-bar-slot--clipped-left' : '',
    bar.clippedRight ? 'tl-bar-slot--clipped-right' : '',
    dragging ? 'tl-bar-slot--dragging' : '',
  ].filter(Boolean).join(' ');

  // Only a real `resolvedAt` dates a discard. `updatedAt` used to stand in, so
  // a title edit re-dated the 폐기 note (same lie `rawEndColumn` used to tell).
  const discardedNote = bar.discardedIndex !== null
    ? (work.resolvedAt ? `· ${formatShortDate(work.resolvedAt)} 폐기` : '· 폐기')
    : '';

  const plannedEndLabel = bar.plannedEnd && work.resolvedAt
    ? formatShortDate(work.resolvedAt)
    : '';

  const renderHandle = (edge: TimelineEdge) => {
    if (!resizable) return null;
    // Position follows the drawn span; the *value* follows the real one. A bar
    // clipped at the left is drawn at column 0 but starts twelve days earlier,
    // and a slider that announces 9/1 for an 8/20 start lies to a screen reader
    // exactly the way the old nudge lied to the store.
    const drawnIndex = edge === 'start' ? span.startIndex : span.endIndex;
    const valueIndex = dragging
      ? drawnIndex
      : (edge === 'start' ? bar.rawStartIndex : bar.rawEndIndex);
    return (
      <span
        role="slider"
        tabIndex={0}
        aria-label={`${work.title} ${EDGE_LABELS[edge]} 조정`}
        aria-valuemin={Math.min(0, bar.rawStartIndex)}
        aria-valuemax={Math.max(range.days.length - 1, bar.rawEndIndex)}
        aria-valuenow={valueIndex}
        aria-valuetext={formatShortDate(isoForColumn(range, valueIndex))}
        className={`tl-bar-handle tl-bar-handle--${edge}`}
        data-tl-handle={edge}
        onPointerDown={(event) => handlers.beginDrag(bar, edge, event)}
        onPointerMove={handlers.moveDrag}
        // `lostpointercapture` is the single end-of-drag signal: the browser
        // fires it after pointerup implicitly releases the capture, and also
        // when the capture is taken away (pointercancel, another pointer). Also
        // listening for pointerup would double-commit the same preview.
        onLostPointerCapture={() => handlers.endDrag(bar)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          handlers.nudgeEdge(bar, edge, event.key === 'ArrowLeft' ? -1 : 1);
        }}
      />
    );
  };

  return (
    <div
      className={slotClasses}
      style={{ gridRow: row, gridColumn: `${span.startIndex + 2} / ${span.endIndex + 3}` }}
    >
      <button
        type="button"
        className={classes}
        onClick={() => handlers.openWork(work)}
        title={work.title}
      >
        {bar.clippedLeft && (
          <span className="tl-bar-edge">
            {compact ? `◂${formatShortDate(work.startedAt)}` : `◂ ${formatShortDate(work.startedAt)}부터`}
          </span>
        )}
        <span className="tl-bar-title">{work.title}</span>
        {discardedNote && <span className="tl-bar-note">{discardedNote}</span>}
        {work.sessionLinks.length > 0 && (
          <span className="tl-bar-count">세션 {work.sessionLinks.length}</span>
        )}
        {work.status === 'done' && (
          <span className="tl-bar-done-mark">{compact ? '✔' : '✔ 완료'}</span>
        )}
        {bar.ongoing && (
          <span className={`tl-bar-ongoing${overrun ? ' tl-bar-ongoing--overrun' : ''}`}>
            {overrun
              ? (compact ? `▸${plannedEndLabel}!` : `▸ ${overrun}`)
              : plannedEndLabel
                ? (compact ? `▸${plannedEndLabel}` : `▸ ${plannedEndLabel} 예정`)
                : (compact ? '▸' : '▸ 진행중')}
          </span>
        )}
      </button>
      {renderHandle('start')}
      {renderHandle('end')}
      {dragging && (
        <span className="tl-bar-preview">
          {formatShortDate(isoForColumn(range, span.startIndex))}
          {' → '}
          {formatShortDate(isoForColumn(range, span.endIndex))}
        </span>
      )}
    </div>
  );
});

function cellTitle(cell: TimelineDayCell): string {
  return cell.cards
    .map((card) => `${TIMELINE_STATUS_LABELS[card.status] ?? card.status} · ${card.title}`)
    .join('\n');
}

/**
 * A session's measured rail plus one block per day it ran.
 *
 * The rail is the session's own extent (violet — a colour no card status uses,
 * so a session never looks like a status). The blocks on top carry the card
 * statuses, which is where the board's palette lives (`TIMELINE_STATUS_LABELS`
 * names them).
 *
 * Click targets follow what the cell contains: one card opens that card, a day
 * with several opens the session conversation that holds them all.
 */
const SessionRailRow = memo(function SessionRailRow({
  row,
  gridRow,
  handlers,
}: {
  row: TimelineSessionRow;
  gridRow: number;
  handlers: TimelineHandlers;
}) {
  const { session, span } = row;
  const cardCount = session.cards.length;
  const { openCard, openSession } = handlers;
  const railClasses = [
    'tl-rail',
    span.ongoing ? 'tl-rail--ongoing' : '',
    span.clippedLeft ? 'tl-rail--clipped-left' : '',
    span.clippedRight ? 'tl-rail--clipped-right' : '',
    row.workId ? '' : 'tl-rail--unassigned',
  ].filter(Boolean).join(' ');

  return (
    <>
      <div
        className={railClasses}
        style={{ gridRow, gridColumn: `${span.startIndex + 2} / ${span.endIndex + 3}` }}
      >
        {openSession ? (
          <button
            type="button"
            className="tl-rail-hit"
            onClick={() => openSession(session.sessionId)}
            title={`${sessionLabel(session)} · 카드 ${cardCount}`}
          >
            <span className="tl-rail-label">카드 {cardCount}</span>
          </button>
        ) : (
          <span className="tl-rail-label">카드 {cardCount}</span>
        )}
      </div>
      {row.cells.map((cell) => {
        const single = cell.cards.length === 1 ? cell.cards[0] : null;
        const openable = single ? Boolean(openCard) : Boolean(openSession);
        const onClick = () => {
          if (single && openCard) openCard(single.id);
          else if (openSession) openSession(session.sessionId);
        };
        return (
          <div
            key={cell.column}
            className="tl-day-slot"
            style={{ gridRow, gridColumn: cell.column + 2 }}
          >
            <button
              type="button"
              className={`tl-day tl-day--${cell.status}`}
              disabled={!openable}
              onClick={onClick}
              title={cellTitle(cell)}
            >
              {cell.cards.length > 1 && (
                <span className="tl-day-count">{cell.cards.length}</span>
              )}
              {/* What ran — the block used to be a bare colour (plus a count),
                  which said *that* something ran on this day but not what. */}
              <span className="tl-day-text">{cell.cards[0]?.title ?? ''}</span>
            </button>
          </div>
        );
      })}
    </>
  );
});

/** Directory group header row. */
const DirRowView = memo(function DirRowView({
  row,
  gridRow,
  range,
  todayIndex,
  handlers,
}: {
  row: TimelineDirRow;
  gridRow: number;
  range: TimelineRange;
  todayIndex: number;
  handlers: TimelineHandlers;
}) {
  return (
    <div className="tl-row">
      <div
        className={`tl-label tl-label--dir ${dirAccentClass(row.projectDir)}`}
        style={{ gridRow, gridColumn: 1 }}
      >
        <button
          type="button"
          className="tl-group-toggle"
          aria-expanded={!row.collapsed}
          onClick={() => handlers.toggleDir(row.groupKey)}
          title={row.projectDir ?? '디렉토리 없음'}
        >
          <span
            className={`tl-group-caret${row.collapsed ? ' tl-group-caret--collapsed' : ''}`}
            aria-hidden="true"
          >
            {row.collapsed ? '▸' : '▾'}
          </span>
          <span className="works-dir-dot" aria-hidden="true" />
          <span className="tl-label-title">
            {row.projectDir ? projectDirLabel(row.projectDir) : '디렉토리 없음'}
          </span>
        </button>
        <span className="tl-label-sub">
          Work {row.workCount} · 세션 {row.sessionCount}
        </span>
      </div>
      <RowCells range={range} gridRow={gridRow} todayIndex={todayIndex} kind="dir" />
    </div>
  );
});

/** Work bracket row: label, day background, and the draggable plan bar. */
const WorkRowView = memo(function WorkRowView({
  row,
  gridRow,
  range,
  todayIndex,
  resizable,
  compact,
  dragPreview,
  handlers,
}: {
  row: TimelineWorkRow;
  gridRow: number;
  range: TimelineRange;
  todayIndex: number;
  resizable: boolean;
  compact: boolean;
  /** Non-null only while *this* Work's bar is being dragged. */
  dragPreview: TimelineSpan | null;
  handlers: TimelineHandlers;
}) {
  const { bar } = row;
  const span: TimelineSpan | null = bar
    ? (dragPreview ?? { startIndex: bar.startIndex, endIndex: bar.endIndex })
    : null;

  return (
    <div className="tl-row">
      <div
        className={`tl-label tl-label--work ${dirAccentClass(row.work.projectDir)}`}
        style={{ gridRow, gridColumn: 1 }}
      >
        <span className="tl-label-line">
          <button
            type="button"
            className="tl-group-toggle tl-group-toggle--caret"
            aria-expanded={!row.collapsed}
            aria-label={`${row.work.title} 세션 ${row.collapsed ? '펼치기' : '접기'}`}
            onClick={() => handlers.toggleWork(row.work.id)}
          >
            <span
              className={`tl-group-caret${row.collapsed ? ' tl-group-caret--collapsed' : ''}`}
              aria-hidden="true"
            >
              {row.collapsed ? '▸' : '▾'}
            </span>
          </button>
          <button
            type="button"
            className="tl-label-link"
            onClick={() => handlers.openWork(row.work)}
            title={row.work.title}
          >
            {row.work.title}
          </button>
        </span>
        <span className="tl-label-sub">
          세션 {row.sessionCount}
          {row.collapsed && row.sessionCount > 0 ? ' · 펼치기' : ''}
        </span>
      </div>
      <RowCells range={range} gridRow={gridRow} todayIndex={todayIndex} kind="work" />
      {bar && span && (
        <TimelineRowBar
          bar={bar}
          row={gridRow}
          span={span}
          range={range}
          dragging={dragPreview !== null}
          resizable={resizable}
          compact={compact}
          handlers={handlers}
        />
      )}
    </div>
  );
});

/** Session row: label (with 미배정 / 폐기 state), day background, rail + cells. */
const SessionRowView = memo(function SessionRowView({
  row,
  gridRow,
  range,
  todayIndex,
  handlers,
}: {
  row: TimelineSessionRow;
  gridRow: number;
  range: TimelineRange;
  todayIndex: number;
  handlers: TimelineHandlers;
}) {
  const title = sessionLabel(row.session);
  const { openSession, assignSession } = handlers;

  return (
    <div className="tl-row" data-session-id={row.session.sessionId}>
      <div
        className={`tl-label tl-label--session${row.workId ? '' : ' tl-label--session-loose'} ${dirAccentClass(row.session.projectDir)}`}
        style={{ gridRow, gridColumn: 1 }}
      >
        <span className="tl-label-line">
          {openSession ? (
            <button
              type="button"
              className="tl-label-link"
              onClick={() => openSession(row.session.sessionId)}
              title={title}
            >
              {title}
            </button>
          ) : (
            <span className="tl-label-title" title={title}>{title}</span>
          )}
        </span>
        {row.workId ? (
          <span className="tl-label-sub">
            {row.session.projectDir ? projectDirLabel(row.session.projectDir) : '디렉토리 없음'}
            {' · 카드 '}
            {row.session.cards.length}
          </span>
        ) : (
          <span className="tl-label-sub tl-label-sub--unassigned">
            {/*
              * A discarded session is unassigned but no longer triage material:
              * it left the Inbox, so the assign modal has nothing to open and
              * the button was inert forever. It keeps its row — the work really
              * ran.
              */}
            {row.session.ignored ? (
              <span className="tl-ignored" title="Works triage에서 폐기한 세션입니다">
                폐기
              </span>
            ) : (
              <>
                <span className="tl-unassigned">미배정</span>
                {assignSession && (
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--primary kv2-btn--small tl-assign-btn"
                    onClick={() => assignSession(row.session.sessionId)}
                  >
                    배정
                  </button>
                )}
              </>
            )}
          </span>
        )}
      </div>
      <RowCells range={range} gridRow={gridRow} todayIndex={todayIndex} kind="session" />
      <SessionRailRow row={row} gridRow={gridRow} handlers={handlers} />
    </div>
  );
});

/**
 * Timeline view — one CSS grid whose columns are **days** and whose rows are
 * directory groups → Work brackets → sessions.
 *
 * Three decisions define it, and all three came from how this board is used:
 *
 * - **A day is the smallest column.** Half the cards here finish in under three
 *   minutes; an hour axis would render them as invisible slivers, so a card
 *   occupies whole days the way it does in ClickUp.
 * - **A session is the smallest row.** Every card belongs to a session, so cards
 *   render as day blocks *inside* their session's row rather than as rows of
 *   their own.
 * - **Only executed work appears.** A card enters the grid from its `startedAt`
 *   (or `completedAt`), never from its creation date — a card parked in `todo`
 *   for two months would otherwise drag a bar across the whole view.
 *
 * Unassigned sessions are shown and marked 미배정; assigning one moves its row
 * under that Work on the next poll. Subagent cards are hidden by default.
 *
 * Sessions come from `GET /api/timeline` (`useTimeline`, windowed so the card
 * archive read stays bounded); the Works come from the shared `useWorks` poll,
 * and session → Work grouping happens here so an optimistic assignment
 * re-groups the grid immediately.
 *
 * Dragging a Work bar's left/right handle re-dates the Work: the preview follows
 * the pointer column-by-column and the drop PATCHes `startedAt` / `resolvedAt`.
 * Moving an *open* Work's right edge records a planned end (`▸ M/D 예정`). The
 * same edit is available as date inputs in the Work detail dialog, and both go
 * through `isoForColumn`/`fromDateInputValue` so a day-level edit preserves the
 * original time-of-day.
 *
 * Rows render through four memoized components (`DirRowView` / `WorkRowView` /
 * `SessionRowView` / `RowCells`) sharing one stable `TimelineHandlers` bundle.
 * That is a performance contract, not a style: a drag re-renders the view once
 * per column crossed, and without the bail-out that repainted every one of the
 * month view's ~60 rows. Keep new callbacks inside the bundle.
 */
export function TimelineView({
  works,
  loading,
  error,
  onOpenWork,
  onUpdateWorkDates,
  onRefresh,
  onClearError,
  onOpenCard,
  onOpenSession,
  onAssignSession,
  onNotify,
  sessionFilter,
}: TimelineViewProps) {
  const [mode, setMode] = useState<TimelineMode>('week');
  const [offset, setOffset] = useState(0);
  const [showSubagents, setShowSubagents] = useState(readShowSubagents);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  // Works start *collapsed*: the Timeline is read at the Work level first, and
  // a Work's sessions are detail you open on purpose. Tracking the expanded set
  // (rather than the collapsed one) is what makes that hold for Works that
  // appear later — a Work the user never touched is collapsed by definition.
  const [expandedWorks, setExpandedWorks] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedWorks = useMemo<ReadonlySet<string>>(
    () => new Set(works.filter((work) => !expandedWorks.has(work.id)).map((work) => work.id)),
    [works, expandedWorks],
  );
  const [dirFilter, setDirFilter] = useState<TimelineDirOption | null>(null);
  const [helpOpen, setHelpOpen] = useState(readHelpUnseen);

  // Pinned to local midnight: the grid only has day resolution, so this keeps
  // the memos stable between renders while still rolling over at midnight (the
  // polls re-render us).
  const todayMs = startOfDay(new Date()).getTime();
  const range = useMemo(() => buildRange(mode, offset, new Date(todayMs)), [mode, offset, todayMs]);
  // Named apiWindow, not window — shadowing the global inside a component that
  // also touches localStorage is a trap waiting to happen.
  const apiWindow = useMemo(() => rangeWindow(range), [range]);
  const timeline = useTimeline({
    from: apiWindow.from,
    to: apiWindow.to,
    includeSubagents: showSubagents,
  });

  const filteredSessions = useMemo(
    () => filterTimelineSessions(timeline.sessions, sessionFilter),
    [timeline.sessions, sessionFilter],
  );
  const filteredWorks = useMemo(
    () => filterTimelineWorks(works, filteredSessions, sessionFilter),
    [works, filteredSessions, sessionFilter],
  );
  const allRows = useMemo(() => buildTimelineRows({
    sessions: filteredSessions,
    works: filteredWorks,
    range,
    now: new Date(todayMs),
    collapsedDirs,
    collapsedWorks,
  }), [filteredSessions, filteredWorks, range, todayMs, collapsedDirs, collapsedWorks]);

  // Options describe the whole grid; the filter narrows what is drawn. Derived
  // in that order so selecting one directory cannot erase the other options.
  const dirOptions = useMemo(() => timelineDirOptions(allRows), [allRows]);
  const rows = useMemo(
    () => filterTimelineRows(allRows, dirFilter?.groupKey ?? null),
    [allRows, dirFilter],
  );
  const legend = useMemo(() => timelineLegend(rows), [rows]);

  const todayIndex = dayDiff(range.start, new Date(todayMs));
  const columnCount = range.days.length;
  const gridStyle = {
    gridTemplateColumns: `var(--tl-label-track) repeat(${columnCount}, minmax(var(--tl-col-min), 1fr))`,
  };

  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * Live drag, held in a ref rather than in state: a pointermove must not
   * re-render the whole view. `dragView` below is the one bit React needs, and
   * only the dragged Work row consumes it.
   */
  const dragRef = useRef<DragState | null>(null);
  const [dragView, setDragView] = useState<{ workId: string; preview: TimelineSpan } | null>(null);
  /**
   * Column geometry, measured **once** per drag. It used to be re-measured on
   * every pointermove (two `querySelector`s and two forced layouts per event);
   * the columns cannot move mid-drag, since a range change aborts the drag and
   * horizontal scrolling is suppressed while the pointer is captured.
   */
  const metricsRef = useRef<{ left: number; width: number } | null>(null);
  const dragging = dragView !== null;

  // Label column width lives here (not in CSS) because it is user-resizable:
  // the grip writes it, `--tl-label-width` on `.timeline` consumes it, and the
  // grid template's first track follows.
  const [labelWidth, setLabelWidth] = useState(readLabelWidth);
  const [resizingLabel, setResizingLabel] = useState(false);
  const labelHeadRef = useRef<HTMLDivElement>(null);

  const resizable = onUpdateWorkDates !== undefined;

  /**
   * Latest props for the stable handler bundle. Written in an effect (never
   * during render) and only read from event handlers, which always run after a
   * commit.
   */
  const latest = useRef({ onOpenWork, onOpenCard, onOpenSession, onAssignSession, onUpdateWorkDates, onNotify, range, columnCount });
  useEffect(() => {
    latest.current = { onOpenWork, onOpenCard, onOpenSession, onAssignSession, onUpdateWorkDates, onNotify, range, columnCount };
  }, [onOpenWork, onOpenCard, onOpenSession, onAssignSession, onUpdateWorkDates, onNotify, range, columnCount]);

  useEffect(() => {
    writeLabelWidth(labelWidth);
  }, [labelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(SUBAGENT_STORAGE_KEY, showSubagents ? '1' : '0');
    } catch { /* quota exceeded */ }
  }, [showSubagents]);

  // Shown once, then reachable from the `?` button for good.
  useEffect(() => {
    if (!helpOpen) return;
    try {
      localStorage.setItem(HELP_SEEN_STORAGE_KEY, '1');
    } catch { /* quota exceeded */ }
  }, [helpOpen]);

  /**
   * PATCH one edge of `bar` onto day column `column`.
   *
   * `column` is a **range-relative index and may be negative**: a Work that
   * started before the visible range is drawn clamped to column 0, but its edge
   * still has to be editable relative to where it really is. Clamping here is
   * what let a `→` on an 8/20 bar viewed in the 9/1 week rewrite `startedAt` to
   * 9/2 — nearly two weeks forward — with no undo.
   */
  const commitEdge = useCallback((bar: TimelineBar, edge: TimelineEdge, column: number) => {
    const { onUpdateWorkDates: update, onNotify: notify, range: activeRange } = latest.current;
    if (!update) return;
    // Inversion is guarded against the bar's *real* opposite edge, for the same
    // reason: a clipped bar's clamped span is not its geometry.
    const next = resizeBar(
      { startIndex: bar.rawStartIndex, endIndex: bar.rawEndIndex },
      edge,
      column,
    );
    const target = edge === 'start' ? next.startIndex : next.endIndex;
    const { work } = bar;
    const previous = work.startedAt;
    // A start keeps its real clock time; an end is a day the Work ran *through*.
    const patch: WorkDatePatch = edge === 'start'
      ? { startedAt: isoForColumn(activeRange, target, previous) }
      : { resolvedAt: endIsoForColumn(activeRange, target) };
    const nextIso = edge === 'start' ? patch.startedAt! : patch.resolvedAt!;
    // Rejections already reached the shared Works error alert via useWorks.
    void update(work.id, patch)
      .then(() => {
        if (!notify) return;
        notify({
          tone: 'success',
          message: describeWorkDateEdit(work.title, edge, nextIso, {
            planned: edge === 'end' && work.status === 'active',
          }),
          undo: {
            label: '되돌리기',
            run: () => update(work.id, edge === 'start'
              ? { startedAt: previous }
              // An open Work with no planned end goes back to tracking today,
              // which `resolvedAt: null` is exactly how to say.
              : { resolvedAt: work.resolvedAt ?? null }),
          },
        });
      })
      .catch(() => {});
  }, []);

  /**
   * Drags run on the handle's own pointer capture, not window listeners. Capture
   * is what makes the pointer keep reporting to the handle after it leaves the
   * 12px grip — and it is established synchronously inside `pointerdown`, so
   * there is no window between the press and a listener being wired up.
   */
  const beginDrag = useCallback((bar: TimelineBar, edge: TimelineEdge, event: React.PointerEvent) => {
    if (!latest.current.onUpdateWorkDates || event.button !== 0) return;
    const handle = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    // `preventDefault()` suppresses the implicit focus a pointerdown gives a
    // `tabIndex` element, so the keyboard path has to be handed it explicitly.
    // Without this, clicking a handle and pressing `→` moved focus to the 월간
    // button instead of nudging the date, and the documented keyboard edit was
    // reachable by Tab only.
    if (handle instanceof HTMLElement) handle.focus();
    const origin: TimelineSpan = { startIndex: bar.startIndex, endIndex: bar.endIndex };
    dragRef.current = { workId: bar.work.id, edge, origin, preview: origin };
    metricsRef.current = measureColumns(gridRef.current, latest.current.columnCount);
    setDragView({ workId: bar.work.id, preview: origin });
  }, []);

  const moveDrag = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    const metrics = metricsRef.current;
    if (!drag || !metrics) return;
    const column = columnAtPointer(
      event.clientX, metrics.left, metrics.width, latest.current.columnCount,
    );
    const preview = resizeBar(drag.origin, drag.edge, column);
    if (preview.startIndex === drag.preview.startIndex
      && preview.endIndex === drag.preview.endIndex) {
      return;
    }
    drag.preview = preview;
    setDragView({ workId: drag.workId, preview });
  }, []);

  const endDrag = useCallback((bar: TimelineBar) => {
    const drag = dragRef.current;
    dragRef.current = null;
    metricsRef.current = null;
    setDragView(null);
    if (!drag) return;
    const origin = drag.edge === 'start' ? drag.origin.startIndex : drag.origin.endIndex;
    const dropped = drag.edge === 'start' ? drag.preview.startIndex : drag.preview.endIndex;
    // A press without a drag never writes.
    if (dropped === origin) return;
    commitEdge(bar, drag.edge, dropped);
  }, [commitEdge]);

  const nudgeEdge = useCallback((bar: TimelineBar, edge: TimelineEdge, delta: number) => {
    const raw = edge === 'start' ? bar.rawStartIndex : bar.rawEndIndex;
    commitEdge(bar, edge, raw + delta);
  }, [commitEdge]);

  const toggleDir = useCallback((key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleWork = useCallback((workId: string) => {
    setExpandedWorks((prev) => {
      const next = new Set(prev);
      if (!next.delete(workId)) next.add(workId);
      return next;
    });
  }, []);

  const openWork = useCallback((work: Work) => latest.current.onOpenWork(work), []);
  const openCard = useCallback((cardId: string) => latest.current.onOpenCard?.(cardId), []);
  const openSession = useCallback(
    (sessionId: string) => latest.current.onOpenSession?.(sessionId),
    [],
  );
  const assignSession = useCallback(
    (sessionId: string) => latest.current.onAssignSession?.(sessionId),
    [],
  );

  // Presence of the optional callbacks decides whether a target is clickable,
  // so the wrappers are only handed over when the real prop exists.
  const canOpenCard = onOpenCard !== undefined;
  const canOpenSession = onOpenSession !== undefined;
  const canAssign = onAssignSession !== undefined;
  const handlers = useMemo<TimelineHandlers>(() => ({
    openWork,
    openCard: canOpenCard ? openCard : undefined,
    openSession: canOpenSession ? openSession : undefined,
    assignSession: canAssign ? assignSession : undefined,
    toggleDir,
    toggleWork,
    beginDrag,
    moveDrag,
    endDrag,
    nudgeEdge,
  }), [
    openWork, openCard, openSession, assignSession, canOpenCard, canOpenSession, canAssign,
    toggleDir, toggleWork, beginDrag, moveDrag, endDrag, nudgeEdge,
  ]);

  /**
   * The grip drags on its own pointer capture, like the bar edge handles. Width
   * is measured from the *header label cell*, not the grid: the label column is
   * `position: sticky`, so its left edge is the visible left edge even when the
   * month view is scrolled horizontally.
   */
  const beginLabelResize = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingLabel(true);
  }, []);

  const moveLabelResize = useCallback((event: React.PointerEvent) => {
    if (!resizingLabel) return;
    const rect = labelHeadRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLabelWidth(clampLabelWidth(event.clientX - rect.left));
  }, [resizingLabel]);

  const nudgeLabelWidth = useCallback((delta: number) => {
    setLabelWidth((prev) => clampLabelWidth(prev + delta));
  }, []);

  // A range/mode change mid-drag would rewrite the columns under the pointer.
  useEffect(() => {
    dragRef.current = null;
    metricsRef.current = null;
    setDragView(null);
  }, [range]);

  const changeMode = (next: TimelineMode) => {
    setMode(next);
    // Week and month offsets are different units, so a mode switch returns to
    // the current period rather than translating the offset.
    setOffset(0);
  };

  const busy = loading || timeline.loading;
  const failed = timeline.error !== null;
  // The selected directory keeps its chip even when this window holds none of
  // its rows — otherwise the filter looks unset while it is still filtering.
  const filterChips = useMemo(() => {
    if (!dirFilter || dirOptions.some((o) => o.groupKey === dirFilter.groupKey)) return dirOptions;
    return [...dirOptions, { ...dirFilter, workCount: 0, sessionCount: 0 }];
  }, [dirOptions, dirFilter]);

  return (
    <div className="tl-view">
      {error && (
        <ErrorAlert
          className="error-banner"
          title={error.title}
          message={error.message}
          actionLabel={error.actionLabel}
          onAction={() => {
            void onRefresh();
          }}
          onDismiss={onClearError}
        />
      )}
      {timeline.error && (
        <ErrorAlert
          className="error-banner"
          title={timeline.error.title}
          // The raw route/network text used to land here, so a missing endpoint
          // read as the single word `Not found` above a grid that had also drawn
          // itself empty — together they said "nothing ran" instead of "we never
          // got an answer".
          message={describeTimelineError(timeline.error.message)}
          actionLabel={timeline.error.actionLabel}
          onAction={() => {
            void timeline.refresh();
          }}
          onDismiss={timeline.clearError}
        />
      )}

      <div className="tl-controls">
        <button
          type="button"
          className="kv2-btn kv2-btn--small"
          aria-label={mode === 'week' ? '이전 주' : '이전 달'}
          onClick={() => setOffset((prev) => prev - 1)}
        >
          ◀
        </button>
        <b className="tl-range-label">{range.label}</b>
        <button
          type="button"
          className="kv2-btn kv2-btn--small"
          aria-label={mode === 'week' ? '다음 주' : '다음 달'}
          onClick={() => setOffset((prev) => prev + 1)}
        >
          ▶
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--ghost"
          disabled={offset === 0}
          onClick={() => setOffset(0)}
        >
          오늘
        </button>

        <span className="tl-seg" role="group" aria-label="타임라인 범위">
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              className="tl-seg-option"
              aria-pressed={mode === option}
              onClick={() => changeMode(option)}
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </span>

        <label className="tl-subagent-toggle">
          <input
            type="checkbox"
            checked={showSubagents}
            onChange={(event) => setShowSubagents(event.target.checked)}
          />
          서브에이전트
        </label>

        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--ghost tl-help-toggle"
          aria-expanded={helpOpen}
          aria-controls="tl-help"
          title="타임라인 읽는 법"
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>

        {/* Only what is actually drawn: a fixed list advertised a 대기 swatch
            that a grid of executed work almost never contains. */}
        <div className="tl-legend">
          {legend.map((item) => (
            <span key={item.key}>
              <i className={`tl-legend-swatch tl-legend-swatch--${item.key}`} aria-hidden="true" />
              {item.label}
            </span>
          ))}
        </div>
      </div>

      {/* The Board's project switcher is hidden in this view (it filters card
          columns that are not rendered here), which left the Timeline with no
          way to narrow a busy grid but collapsing groups one by one. This one is
          built from the grid's own rows, so a project whose cards are all
          archived is still filterable. */}
      {filterChips.length > 1 && (
        <div className="tl-dir-filter" role="group" aria-label="디렉토리 필터">
          <button
            type="button"
            className={`tl-dir-chip${dirFilter === null ? ' is-active' : ''}`}
            aria-pressed={dirFilter === null}
            onClick={() => setDirFilter(null)}
          >
            <span className="tl-dir-chip-label">전체</span>
            <span className="tl-dir-chip-count">{dirOptions.length}</span>
          </button>
          {filterChips.map((option) => {
            const active = dirFilter?.groupKey === option.groupKey;
            const label = option.projectDir ? projectDirLabel(option.projectDir) : '디렉토리 없음';
            return (
              <button
                key={option.groupKey}
                type="button"
                className={`tl-dir-chip ${dirAccentClass(option.projectDir)}${active ? ' is-active' : ''}`}
                aria-pressed={active}
                title={option.projectDir ?? '디렉토리 없음'}
                onClick={() => setDirFilter(active ? null : option)}
              >
                <span className="works-dir-dot" aria-hidden="true" />
                <span className="tl-dir-chip-label">{label}</span>
                <span className="tl-dir-chip-count">{option.sessionCount}</span>
              </button>
            );
          })}
        </div>
      )}

      {helpOpen && (
        <div className="tl-help" id="tl-help">
          <p>
            · 카드는 <b>실제 실행된 날</b>부터 보입니다(생성일 기준이 아님). 최소 단위는 <b>하루</b>라서
            3분 만에 끝난 카드도 하루 칸을 차지합니다.<br />
            · 행 구조는 <b>디렉토리 → Work → 세션</b>이고, Work에 속하지 않은 세션은 <b>미배정</b>으로
            같은 디렉토리 그룹 아래에 표시됩니다. 배정하면 해당 Work 아래로 들어갑니다.<br />
            · 색: 디렉토리(왼쪽 색 띠) / Work 바(먹색, 계획) / 세션 레일(보라, 실측) / 카드 칸(카드 상태).
            칸을 클릭하면 카드 상세, 여러 장이면 세션 대화가 열립니다.<br />
            · Work 바 양 끝의 손잡이를 잡아끌면 날짜가 바뀝니다(손잡이를 클릭한 뒤 ←/→ 키도 하루씩 이동).
            진행 중인 Work의 오른쪽 끝을 옮기면 <b>종료 예정일</b>이 되고, 비우면 다시 오늘까지 이어집니다.
            바꾼 뒤에는 <b>되돌리기</b> 알림이 잠시 남습니다.<br />
            · 라벨이 잘리면 헤더 오른쪽 경계를 잡아끌어 열 너비를 조절하세요(←/→ 키, 더블클릭하면 기본값).
            서브에이전트 카드는 기본으로 숨겨져 있습니다.
          </p>
          <button
            type="button"
            className="kv2-btn kv2-btn--small kv2-btn--ghost"
            onClick={() => setHelpOpen(false)}
          >
            닫기
          </button>
        </div>
      )}

      <p className="tl-mobile-hint">· 그리드를 좌우로 밀어 다른 날짜를 볼 수 있습니다.</p>

      <div
        className={`timeline${mode === 'month' ? ' timeline--month' : ''}${dragging ? ' timeline--dragging' : ''}${resizingLabel ? ' timeline--label-resizing' : ''}${failed ? ' timeline--errored' : ''}`}
        style={{ '--tl-label-width': `${labelWidth}px` } as React.CSSProperties}
      >
        <div className="tl-scroll">
          <div className="tl-grid" style={gridStyle} ref={gridRef}>
            <div
              className="tl-head tl-head--label"
              style={{ gridRow: 1, gridColumn: 1 }}
              ref={labelHeadRef}
            >
              프로젝트 · 세션
              <span
                role="separator"
                aria-orientation="vertical"
                tabIndex={0}
                aria-label="라벨 열 너비 조정"
                aria-valuemin={MIN_LABEL_WIDTH}
                aria-valuemax={MAX_LABEL_WIDTH}
                aria-valuenow={labelWidth}
                aria-valuetext={`${labelWidth}px`}
                className="tl-label-resizer"
                onPointerDown={beginLabelResize}
                onPointerMove={moveLabelResize}
                // Same end-of-drag signal as the bar handles — see renderHandle.
                onLostPointerCapture={() => setResizingLabel(false)}
                onDoubleClick={() => setLabelWidth(DEFAULT_LABEL_WIDTH)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    nudgeLabelWidth(event.key === 'ArrowLeft' ? -LABEL_WIDTH_STEP : LABEL_WIDTH_STEP);
                    return;
                  }
                  if (event.key === 'Home') {
                    event.preventDefault();
                    setLabelWidth(DEFAULT_LABEL_WIDTH);
                  }
                }}
              />
            </div>
            {range.days.map((day, index) => {
              const isToday = index === todayIndex;
              const dateLabel = mode === 'month' ? compactDateLabel(day) : columnDateLabel(day);
              const classes = [
                'tl-head',
                isWeekend(day) ? 'tl-head--weekend' : '',
                isToday ? 'tl-head--today' : '',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={day.getTime()}
                  className={classes}
                  // Drag geometry is measured off these cells (measureColumns).
                  data-tl-col={index}
                  style={{ gridRow: 1, gridColumn: index + 2 }}
                >
                  <span className="tl-dow">{dowLabel(day)}</span>
                  {isToday ? <span className="tl-date-pill">{dateLabel}</span> : dateLabel}
                </div>
              );
            })}

            {rows.map((row, rowIndex) => {
              const gridRow = rowIndex + 2;
              if (row.kind === 'dir') {
                return (
                  <DirRowView
                    key={row.key}
                    row={row}
                    gridRow={gridRow}
                    range={range}
                    todayIndex={todayIndex}
                    handlers={handlers}
                  />
                );
              }
              if (row.kind === 'work') {
                return (
                  <WorkRowView
                    key={row.key}
                    row={row}
                    gridRow={gridRow}
                    range={range}
                    todayIndex={todayIndex}
                    resizable={resizable}
                    compact={mode === 'month'}
                    dragPreview={dragView?.workId === row.work.id ? dragView.preview : null}
                    handlers={handlers}
                  />
                );
              }
              return (
                <SessionRowView
                  key={row.key}
                  row={row}
                  gridRow={gridRow}
                  range={range}
                  todayIndex={todayIndex}
                  handlers={handlers}
                />
              );
            })}

            {rows.length === 0 && (
              <div className="tl-empty" style={{ gridRow: 2 }}>
                {busy && '불러오는 중…'}
                {/* An unanswered read must never be reported as an empty week. */}
                {!busy && failed && '타임라인을 불러오지 못해 비어 있습니다. 위 알림의 다시 시도를 눌러 주세요.'}
                {!busy && !failed && dirFilter
                  && '이 디렉토리에는 이 기간에 실행된 세션이 없습니다. 필터를 전체로 돌리면 다른 프로젝트가 보입니다.'}
                {!busy && !failed && !dirFilter
                  && '이 기간에 실행된 세션이 없습니다. 카드를 실행하면 실행한 날부터 여기에 나타납니다.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
