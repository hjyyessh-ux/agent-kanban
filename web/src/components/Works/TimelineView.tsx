import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Work } from '../../../../src/core/types';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import { formatShortDate, projectDirLabel } from './worksAssign';
import {
  buildBars,
  buildRange,
  columnAtPointer,
  dayDiff,
  endIsoForColumn,
  isWeekend,
  isoForColumn,
  resizeBar,
  startOfDay,
  type TimelineBar,
  type TimelineEdge,
  type TimelineMode,
  type TimelineRange,
  type TimelineSpan,
} from './timelineModel';
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
}

const DOW_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

const MODE_LABELS: Record<TimelineMode, string> = {
  week: '주간',
  month: '월간',
};

const MODES: TimelineMode[] = ['week', 'month'];

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

interface TimelineRowBarProps {
  bar: TimelineBar;
  row: number;
  /** Rendered span — the drag preview while this bar's edge is being dragged. */
  span: TimelineSpan;
  range: TimelineRange;
  dragging: boolean;
  resizable: boolean;
  onOpenWork: (work: Work) => void;
  onEdgePointerDown: (bar: TimelineBar, edge: TimelineEdge, event: React.PointerEvent) => void;
  onEdgePointerMove: (event: React.PointerEvent) => void;
  /** Pointer released (or capture lost) — commit the preview. */
  onEdgePointerUp: (bar: TimelineBar) => void;
  onEdgeNudge: (bar: TimelineBar, edge: TimelineEdge, delta: number) => void;
}

/**
 * One Work's bar plus its two resize handles. The bar carries its own label
 * because it can be much wider than the row's 180px label column, and the
 * mockup puts the clipping hints ("◂ 8/26 부터", "▸ 진행중") on the bar itself
 * where the cut actually is.
 *
 * The handles are siblings of the bar rather than children: the bar is a
 * `<button>` (click → Work detail), and a button cannot nest interactive
 * children. `.tl-bar-slot` owns the grid placement so both can share it.
 */
function TimelineRowBar({
  bar,
  row,
  span,
  range,
  dragging,
  resizable,
  onOpenWork,
  onEdgePointerDown,
  onEdgePointerMove,
  onEdgePointerUp,
  onEdgeNudge,
}: TimelineRowBarProps) {
  const { work } = bar;
  const classes = [
    'tl-bar',
    statusClass(work),
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

  const discardedNote = bar.discardedIndex !== null
    ? `· ${formatShortDate(work.resolvedAt ?? work.updatedAt)} 폐기`
    : '';

  const renderHandle = (edge: TimelineEdge) => {
    if (!resizable) return null;
    const index = edge === 'start' ? span.startIndex : span.endIndex;
    return (
      <span
        role="slider"
        tabIndex={0}
        aria-label={`${work.title} ${EDGE_LABELS[edge]} 조정`}
        aria-valuemin={0}
        aria-valuemax={range.days.length - 1}
        aria-valuenow={index}
        aria-valuetext={formatShortDate(isoForColumn(range, index))}
        className={`tl-bar-handle tl-bar-handle--${edge}`}
        onPointerDown={(event) => onEdgePointerDown(bar, edge, event)}
        onPointerMove={onEdgePointerMove}
        // `lostpointercapture` is the single end-of-drag signal: the browser
        // fires it after pointerup implicitly releases the capture, and also
        // when the capture is taken away (pointercancel, another pointer). Also
        // listening for pointerup would double-commit the same preview.
        onLostPointerCapture={() => onEdgePointerUp(bar)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          onEdgeNudge(bar, edge, event.key === 'ArrowLeft' ? -1 : 1);
        }}
      />
    );
  };

  return (
    <div
      className={slotClasses}
      style={{ gridRow: row, gridColumn: `${span.startIndex + 2} / ${span.endIndex + 3}` }}
    >
      <button type="button" className={classes} onClick={() => onOpenWork(work)} title={work.title}>
        {bar.clippedLeft && (
          <span className="tl-bar-edge">◂ {formatShortDate(work.startedAt)}부터</span>
        )}
        <span className="tl-bar-title">{work.title}</span>
        {discardedNote && <span className="tl-bar-note">{discardedNote}</span>}
        {work.sessionLinks.length > 0 && (
          <span className="tl-bar-count">세션 {work.sessionLinks.length}</span>
        )}
        {bar.ongoing && (
          <span className="tl-bar-ongoing">
            {bar.plannedEnd
              ? `▸ ${formatShortDate(work.resolvedAt ?? '')} 예정`
              : '▸ 진행중'}
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
}

/**
 * Timeline tab (mockup screen ⑤). Rows are Works, columns are days, and a bar
 * spans `startedAt → resolvedAt` — an unresolved Work's bar runs to today and
 * keeps an open (dashed) right edge. Rendered with one CSS grid: every cell and
 * bar gets an explicit `grid-row` / `grid-column`, so no chart or calendar
 * library is involved and the bar geometry is identical in week and month mode.
 *
 * Dragging a bar's left/right handle re-dates the Work: the preview follows the
 * pointer column-by-column and the drop PATCHes `startedAt` / `resolvedAt`. Both
 * edges move on every Work — moving an *open* Work's right edge records a
 * planned end (`▸ M/D 예정`) that survives the later completion. The same edit is
 * available as date inputs in the Work detail dialog, and both go through
 * `isoForColumn`/`fromDateInputValue` so a day-level edit preserves the original
 * time-of-day.
 *
 * Data comes from `useWorks` (10s polling) — the timeline needs no endpoint of
 * its own. Unassigned sessions are deliberately absent: they are not Works yet,
 * which is the nudge to triage them in the Works Inbox.
 */
export function TimelineView({
  works,
  loading,
  error,
  onOpenWork,
  onUpdateWorkDates,
  onRefresh,
  onClearError,
}: TimelineViewProps) {
  const [mode, setMode] = useState<TimelineMode>('week');
  const [offset, setOffset] = useState(0);

  // Pinned to local midnight: the grid only has day resolution, so this keeps
  // the memos stable between renders while still rolling over at midnight (the
  // 10s Works poll re-renders us).
  const todayMs = startOfDay(new Date()).getTime();
  const range = useMemo(() => buildRange(mode, offset, new Date(todayMs)), [mode, offset, todayMs]);
  const bars = useMemo(() => buildBars(works, range, new Date(todayMs)), [works, range, todayMs]);

  const todayIndex = dayDiff(range.start, new Date(todayMs));
  const columnCount = range.days.length;
  const gridStyle = {
    gridTemplateColumns: `var(--tl-label-width) repeat(${columnCount}, minmax(var(--tl-col-min), 1fr))`,
  };

  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragging = drag !== null;

  const resizable = onUpdateWorkDates !== undefined;

  /**
   * PATCH one edge of `bar` onto day column `column`. No-ops when the column
   * did not actually move, so a click-without-drag never writes.
   */
  const applyEdge = useCallback((bar: TimelineBar, edge: TimelineEdge, column: number) => {
    if (!onUpdateWorkDates) return;
    const clamped = Math.min(columnCount - 1, Math.max(0, column));
    const next = resizeBar({ startIndex: bar.startIndex, endIndex: bar.endIndex }, edge, clamped);
    const target = edge === 'start' ? next.startIndex : next.endIndex;
    const current = edge === 'start' ? bar.startIndex : bar.endIndex;
    if (target === current) return;
    const { work } = bar;
    // A start keeps its real clock time; an end is a day the Work ran *through*.
    const patch: WorkDatePatch = edge === 'start'
      ? { startedAt: isoForColumn(range, target, work.startedAt) }
      : { resolvedAt: endIsoForColumn(range, target) };
    // Rejections already reached the shared Works error alert via useWorks.
    void onUpdateWorkDates(work.id, patch).catch(() => {});
  }, [onUpdateWorkDates, range, columnCount]);

  /**
   * Drags run on the handle's own pointer capture, not window listeners. Capture
   * is what makes the pointer keep reporting to the handle after it leaves the
   * 12px grip — and it is established synchronously inside `pointerdown`, so
   * there is no window between the press and a listener being wired up.
   */
  const beginDrag = useCallback((bar: TimelineBar, edge: TimelineEdge, event: React.PointerEvent) => {
    if (!resizable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin: TimelineSpan = { startIndex: bar.startIndex, endIndex: bar.endIndex };
    setDrag({ workId: bar.work.id, edge, origin, preview: origin });
  }, [resizable]);

  const moveDrag = useCallback((event: React.PointerEvent) => {
    if (!drag) return;
    const metrics = measureColumns(gridRef.current, columnCount);
    if (!metrics) return;
    const column = columnAtPointer(event.clientX, metrics.left, metrics.width, columnCount);
    const preview = resizeBar(drag.origin, drag.edge, column);
    if (preview.startIndex === drag.preview.startIndex
      && preview.endIndex === drag.preview.endIndex) {
      return;
    }
    setDrag({ ...drag, preview });
  }, [drag, columnCount]);

  const endDrag = useCallback((bar: TimelineBar) => {
    if (!drag) return;
    setDrag(null);
    applyEdge(bar, drag.edge, drag.edge === 'start' ? drag.preview.startIndex : drag.preview.endIndex);
  }, [drag, applyEdge]);

  // A range/mode change mid-drag would rewrite the columns under the pointer.
  useEffect(() => {
    setDrag(null);
  }, [range]);

  const onEdgeNudge = useCallback((bar: TimelineBar, edge: TimelineEdge, delta: number) => {
    applyEdge(bar, edge, (edge === 'start' ? bar.startIndex : bar.endIndex) + delta);
  }, [applyEdge]);

  const changeMode = (next: TimelineMode) => {
    setMode(next);
    // Week and month offsets are different units, so a mode switch returns to
    // the current period rather than translating the offset.
    setOffset(0);
  };

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

        <div className="tl-legend">
          <span><i className="tl-legend-swatch tl-legend-swatch--active" aria-hidden="true" />active</span>
          <span><i className="tl-legend-swatch tl-legend-swatch--done" aria-hidden="true" />done</span>
          <span><i className="tl-legend-swatch tl-legend-swatch--discarded" aria-hidden="true" />discarded</span>
        </div>
      </div>

      <div
        className={`timeline${mode === 'month' ? ' timeline--month' : ''}${dragging ? ' timeline--dragging' : ''}`}
      >
        <div className="tl-scroll">
          <div className="tl-grid" style={gridStyle} ref={gridRef}>
            <div className="tl-head tl-head--label" style={{ gridRow: 1, gridColumn: 1 }}>
              Work
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

            {bars.map((bar, rowIndex) => {
              const row = rowIndex + 2;
              const isDragging = drag?.workId === bar.work.id;
              const span: TimelineSpan = isDragging && drag
                ? drag.preview
                : { startIndex: bar.startIndex, endIndex: bar.endIndex };
              const outOfRangeStart = bar.clippedLeft
                ? `${formatShortDate(bar.work.startedAt)} 시작`
                : '';
              const sub = [projectDirLabel(bar.work.projectDir), outOfRangeStart]
                .filter(Boolean)
                .join(' · ');
              return (
                <div key={bar.work.id} className="tl-row">
                  <div className="tl-label" style={{ gridRow: row, gridColumn: 1 }}>
                    <span className="tl-label-title">{bar.work.title}</span>
                    {sub && <span className="tl-label-sub">{sub}</span>}
                  </div>
                  {range.days.map((day, index) => {
                    const classes = [
                      'tl-cell',
                      isWeekend(day) ? 'tl-cell--weekend' : '',
                      index === todayIndex ? 'tl-cell--today' : '',
                    ].filter(Boolean).join(' ');
                    return (
                      <div
                        key={day.getTime()}
                        className={classes}
                        style={{ gridRow: row, gridColumn: index + 2 }}
                      />
                    );
                  })}
                  <TimelineRowBar
                    bar={bar}
                    row={row}
                    span={span}
                    range={range}
                    dragging={isDragging}
                    resizable={resizable}
                    onOpenWork={onOpenWork}
                    onEdgePointerDown={beginDrag}
                    onEdgePointerMove={moveDrag}
                    onEdgePointerUp={endDrag}
                    onEdgeNudge={onEdgeNudge}
                  />
                </div>
              );
            })}

            {bars.length === 0 && (
              <div className="tl-empty" style={{ gridRow: 2 }}>
                {loading
                  ? '불러오는 중…'
                  : '이 기간에 걸친 Work이 없습니다. Works 탭 Inbox에서 세션을 배정하면 여기에 나타납니다.'}
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="tl-footnote">
        · 미배정 세션은 타임라인에 나타나지 않습니다 → Works 탭 Inbox에서 배정하세요.
        폐기된 Work는 폐기일에 바가 끊기고 회색 처리됩니다.<br />
        · 행 정렬: 미완료(오래된 순) → 완료(최근 순). 바를 클릭하면 Work 상세가 열립니다.<br />
        · 바 양 끝의 손잡이를 잡아끌면 날짜가 바뀝니다(←/→ 키도 하루씩 이동).
        진행 중인 Work의 오른쪽 끝을 옮기면 <b>종료 예정일</b>이 되고, 비우면 다시 오늘까지 이어집니다.
      </p>
    </div>
  );
}
