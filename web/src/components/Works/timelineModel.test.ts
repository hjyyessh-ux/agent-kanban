import { describe, expect, test } from 'bun:test';
import type { Work } from '../../../../src/core/types';
import {
  buildBars,
  buildRange,
  clampLabelWidth,
  columnAtPointer,
  columnOf,
  describeTimelineError,
  describeWorkDateEdit,
  endFromDateInputValue,
  endIsoForColumn,
  fromDateInputValue,
  isWeekend,
  isoForColumn,
  resizeBar,
  startOfWeek,
  toDateInputValue,
  DEFAULT_LABEL_WIDTH,
  MAX_LABEL_WIDTH,
  MIN_LABEL_WIDTH,
} from './timelineModel';

/** 2026-09-02 is a Wednesday — the mockup's "today". */
const NOW = new Date(2026, 8, 2, 14, 30);

function work(partial: Partial<Work> & Pick<Work, 'id' | 'title' | 'status' | 'startedAt'>): Work {
  return {
    sessionLinks: [],
    createdAt: partial.startedAt,
    updatedAt: partial.startedAt,
    ...partial,
  };
}

/** Local-midnight ISO string, so tests bucket the same way the grid does. */
function localIso(year: number, month: number, day: number, hour = 9): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe('buildRange', () => {
  test('week view spans Monday–Sunday around today', () => {
    const range = buildRange('week', 0, NOW);
    expect(range.days).toHaveLength(7);
    expect(range.start.getDay()).toBe(1); // Monday
    expect(range.start.getDate()).toBe(31); // 8/31
    expect(range.days[6].getDate()).toBe(6); // 9/6
    expect(range.label).toContain('2026');
  });

  test('week offset shifts by whole weeks', () => {
    expect(buildRange('week', -1, NOW).start.getDate()).toBe(24); // 8/24
    expect(buildRange('week', 1, NOW).start.getDate()).toBe(7); // 9/7
  });

  test('month view widens to whole Monday-aligned weeks', () => {
    const range = buildRange('month', 0, NOW);
    expect(range.days.length % 7).toBe(0);
    expect(range.days.length).toBeGreaterThanOrEqual(28);
    expect(range.days.length).toBeLessThanOrEqual(35);
    expect(range.start).toEqual(startOfWeek(new Date(2026, 8, 1)));
    // The whole month has to be covered by the padded weeks.
    expect(columnOf(range, localIso(2026, 9, 30))).toBeLessThan(range.days.length);
  });

  test('weekend columns are Saturday and Sunday', () => {
    const range = buildRange('week', 0, NOW);
    expect(range.days.map(isWeekend)).toEqual([false, false, false, false, false, true, true]);
  });
});

describe('buildBars', () => {
  const range = buildRange('week', 0, NOW);

  test('an active Work extends to today with an open right edge', () => {
    const [bar] = buildBars(
      [work({ id: 'w1', title: 'Quick Actions QA', status: 'active', startedAt: localIso(2026, 9, 1) })],
      range,
      NOW,
    );
    expect(bar.startIndex).toBe(1); // 9/1 = Tuesday
    expect(bar.endIndex).toBe(2); // today, 9/2
    expect(bar.ongoing).toBe(true);
    expect(bar.clippedLeft).toBe(false);
    expect(bar.clippedRight).toBe(false);
  });

  test('an active Work with a planned end stops there instead of tracking today', () => {
    const [bar] = buildBars(
      [work({
        id: 'w1p',
        title: '종료 예정 있는 진행중',
        status: 'active',
        startedAt: localIso(2026, 8, 31),
        // Set by dragging the bar's right edge / the detail dialog, *before*
        // the Work is completed — a plan, not a completion stamp.
        resolvedAt: localIso(2026, 9, 4, 18),
      })],
      range,
      NOW,
    );
    expect(bar.startIndex).toBe(0);
    expect(bar.endIndex).toBe(4); // 9/4, two days past today
    expect(bar.plannedEnd).toBe(true);
    // Still unresolved, so the bar keeps its open right edge.
    expect(bar.ongoing).toBe(true);
  });

  test('a planned end in the past pulls the bar back off today', () => {
    const [bar] = buildBars(
      [work({
        id: 'w1q',
        title: '예정일이 지난 진행중',
        status: 'active',
        startedAt: localIso(2026, 8, 31),
        resolvedAt: localIso(2026, 9, 1, 18),
      })],
      range,
      NOW,
    );
    // What you dragged is what you see — the bar does not silently re-extend.
    expect(bar.endIndex).toBe(1);
    expect(bar.plannedEnd).toBe(true);
  });

  test('an active Work with no planned end is not flagged plannedEnd', () => {
    const [bar] = buildBars(
      [work({ id: 'w1r', title: '평범한 진행중', status: 'active', startedAt: localIso(2026, 9, 1) })],
      range,
      NOW,
    );
    expect(bar.plannedEnd).toBe(false);
    expect(bar.endIndex).toBe(2); // today
  });

  test('a Work started before the range is clipped on the left', () => {
    const [bar] = buildBars(
      [work({ id: 'w2', title: 'ArgoCD ACL', status: 'active', startedAt: localIso(2026, 8, 26) })],
      range,
      NOW,
    );
    expect(bar.startIndex).toBe(0);
    expect(bar.clippedLeft).toBe(true);
    expect(bar.endIndex).toBe(2);
  });

  test('a done Work ends on its resolvedAt column', () => {
    const [bar] = buildBars(
      [work({
        id: 'w3',
        title: 'CDA 토큰',
        status: 'done',
        startedAt: localIso(2026, 8, 31),
        resolvedAt: localIso(2026, 9, 1, 18),
      })],
      range,
      NOW,
    );
    expect(bar.startIndex).toBe(0);
    expect(bar.endIndex).toBe(1);
    expect(bar.ongoing).toBe(false);
    expect(bar.plannedEnd).toBe(false); // a completed end is not a plan
    expect(bar.discardedIndex).toBeNull();
  });

  test('a discarded Work is cut at its discard column', () => {
    const [bar] = buildBars(
      [work({
        id: 'w4',
        title: 'bun macro 실험',
        status: 'discarded',
        startedAt: localIso(2026, 8, 19),
        resolvedAt: localIso(2026, 9, 2, 11),
        resolution: 'abandoned',
      })],
      range,
      NOW,
    );
    expect(bar.clippedLeft).toBe(true);
    expect(bar.endIndex).toBe(2);
    expect(bar.discardedIndex).toBe(2);
    expect(bar.ongoing).toBe(false);
  });

  test('an active Work bar runs past the right edge of an earlier week', () => {
    const pastWeek = buildRange('week', -1, NOW);
    const [bar] = buildBars(
      [work({ id: 'w5', title: 'ArgoCD ACL', status: 'active', startedAt: localIso(2026, 8, 26) })],
      pastWeek,
      NOW,
    );
    expect(bar.startIndex).toBe(2); // 8/26 = Wednesday of 8/24 week
    expect(bar.endIndex).toBe(6); // clamped to Sunday
    expect(bar.clippedRight).toBe(true);
    expect(bar.ongoing).toBe(true);
  });

  test('Works with no overlap are dropped', () => {
    const bars = buildBars(
      [
        work({
          id: 'old',
          title: 'ended before',
          status: 'done',
          startedAt: localIso(2026, 8, 10),
          resolvedAt: localIso(2026, 8, 12),
        }),
        work({ id: 'future', title: 'starts later', status: 'active', startedAt: localIso(2026, 9, 20) }),
      ],
      range,
      NOW,
    );
    expect(bars).toEqual([]);
  });

  test('rows sort unresolved oldest-first, then resolved most-recent-first', () => {
    const bars = buildBars(
      [
        work({
          id: 'done-old',
          title: 'done earlier',
          status: 'done',
          startedAt: localIso(2026, 8, 31),
          resolvedAt: localIso(2026, 8, 31, 20),
        }),
        work({ id: 'active-new', title: 'active newer', status: 'active', startedAt: localIso(2026, 9, 2) }),
        work({
          id: 'done-new',
          title: 'done later',
          status: 'done',
          startedAt: localIso(2026, 8, 31),
          resolvedAt: localIso(2026, 9, 1, 20),
        }),
        work({ id: 'active-old', title: 'active older', status: 'active', startedAt: localIso(2026, 8, 31) }),
      ],
      range,
      NOW,
    );
    expect(bars.map((bar) => bar.work.id)).toEqual(['active-old', 'active-new', 'done-new', 'done-old']);
  });
});

describe('columnAtPointer', () => {
  // A 7-column grid whose first day column starts at x=180 and is 100px wide.
  const LEFT = 180;
  const WIDTH = 100;

  test('maps a pointer inside a column to that column', () => {
    expect(columnAtPointer(180, LEFT, WIDTH, 7)).toBe(0);
    expect(columnAtPointer(279, LEFT, WIDTH, 7)).toBe(0);
    expect(columnAtPointer(280, LEFT, WIDTH, 7)).toBe(1);
    expect(columnAtPointer(645, LEFT, WIDTH, 7)).toBe(4);
  });

  test('clamps outside the grid instead of returning a phantom column', () => {
    expect(columnAtPointer(0, LEFT, WIDTH, 7)).toBe(0);
    expect(columnAtPointer(99999, LEFT, WIDTH, 7)).toBe(6);
  });

  test('a degenerate measurement falls back to the first column', () => {
    expect(columnAtPointer(500, LEFT, 0, 7)).toBe(0);
    expect(columnAtPointer(500, LEFT, WIDTH, 0)).toBe(0);
  });
});

describe('resizeBar', () => {
  const span = { startIndex: 2, endIndex: 5 };

  test('moves only the dragged edge', () => {
    expect(resizeBar(span, 'start', 0)).toEqual({ startIndex: 0, endIndex: 5 });
    expect(resizeBar(span, 'end', 6)).toEqual({ startIndex: 2, endIndex: 6 });
  });

  test('a bar collapses instead of inverting', () => {
    expect(resizeBar(span, 'start', 6)).toEqual({ startIndex: 5, endIndex: 5 });
    expect(resizeBar(span, 'end', 0)).toEqual({ startIndex: 2, endIndex: 2 });
  });
});

describe('isoForColumn', () => {
  const range = buildRange('week', 0, NOW); // 8/31 (Mon) – 9/6 (Sun)

  test('a column resolves to that day, keeping the source time-of-day', () => {
    const moved = new Date(isoForColumn(range, 3, localIso(2026, 8, 31, 14)));
    expect(moved.getMonth()).toBe(8); // September
    expect(moved.getDate()).toBe(3);
    expect(moved.getHours()).toBe(14);
  });

  test('no source timestamp lands on local midnight', () => {
    const moved = new Date(isoForColumn(range, 0));
    expect(moved.getDate()).toBe(31);
    expect(moved.getHours()).toBe(0);
    expect(moved.getMinutes()).toBe(0);
  });

  test('an unparseable source is ignored rather than poisoning the result', () => {
    const moved = new Date(isoForColumn(range, 1, 'not-a-date'));
    expect(moved.getDate()).toBe(1);
    expect(moved.getHours()).toBe(0);
  });
});

describe('end dates land at end-of-day', () => {
  const range = buildRange('week', 0, NOW);

  test('a dragged end covers the whole day it was dropped on', () => {
    const end = new Date(endIsoForColumn(range, 3));
    expect(end.getDate()).toBe(3); // 9/3
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });

  test('a same-day span is never an inverted instant', () => {
    // Start at 14:00, end typed on the same day → 23:59:59.999 > 14:00, so the
    // store's ordering check passes instead of rejecting a valid one-day bar.
    const start = localIso(2026, 9, 2, 14);
    const end = endFromDateInputValue('2026-09-02');
    expect(Date.parse(end!)).toBeGreaterThan(Date.parse(start));
  });

  test('endFromDateInputValue rejects a partial value like its start twin', () => {
    expect(endFromDateInputValue('2026-09')).toBeNull();
    expect(endFromDateInputValue('')).toBeNull();
  });
});

describe('date input round-trip', () => {
  test('toDateInputValue uses the grid local day, not UTC', () => {
    expect(toDateInputValue(localIso(2026, 9, 2, 23))).toBe('2026-09-02');
    expect(toDateInputValue(undefined)).toBe('');
    expect(toDateInputValue('not-a-date')).toBe('');
  });

  test('fromDateInputValue keeps the original time-of-day', () => {
    const iso = fromDateInputValue('2026-09-04', localIso(2026, 9, 2, 16));
    expect(iso).not.toBeNull();
    const date = new Date(iso!);
    expect(date.getDate()).toBe(4);
    expect(date.getHours()).toBe(16);
  });

  test('a partial or malformed input value yields null (mid-edit, not a clear)', () => {
    expect(fromDateInputValue('')).toBeNull();
    expect(fromDateInputValue('2026-09')).toBeNull();
    expect(fromDateInputValue('나중에')).toBeNull();
  });

  test('round-trips through the date input without drifting a day', () => {
    const original = localIso(2026, 9, 2, 8);
    const value = toDateInputValue(original);
    expect(new Date(fromDateInputValue(value, original)!).getTime()).toBe(new Date(original).getTime());
  });
});

describe('clampLabelWidth', () => {
  test('keeps an in-range width, rounded to whole pixels', () => {
    expect(clampLabelWidth(240)).toBe(240);
    expect(clampLabelWidth(240.6)).toBe(241);
  });

  test('clamps a drag that runs past either bound', () => {
    expect(clampLabelWidth(20)).toBe(MIN_LABEL_WIDTH);
    expect(clampLabelWidth(-500)).toBe(MIN_LABEL_WIDTH);
    expect(clampLabelWidth(9999)).toBe(MAX_LABEL_WIDTH);
  });

  test('falls back to the default for a corrupt persisted value', () => {
    expect(clampLabelWidth(Number.NaN)).toBe(DEFAULT_LABEL_WIDTH);
    expect(clampLabelWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LABEL_WIDTH);
  });
});

/**
 * A bar clipped by the visible range keeps its *real* columns alongside its
 * drawn ones. This is the regression the keyboard nudge fell into: it read the
 * clamped `startIndex`, so `→` on a bar that started twelve days before the
 * grid moved `startedAt` twelve days forward instead of one day back-to-front.
 */
describe('clipped bars keep their real edit columns', () => {
  // Grid = Mon 2026-08-31 … Sun 2026-09-06; the Work started 2026-08-20.
  const range = buildRange('week', 0, NOW);
  const startIso = localIso(2026, 8, 20, 14);
  const [bar] = buildBars(
    [work({ id: 'wclip', title: '오래 걸린 Work', status: 'active', startedAt: startIso })],
    range,
    NOW,
  );

  test('exposes the raw start column while drawing at column 0', () => {
    expect(bar!.startIndex).toBe(0);
    expect(bar!.clippedLeft).toBe(true);
    expect(bar!.rawStartIndex).toBe(-11); // 8/20 is 11 days before 8/31
  });

  test('a one-day nudge off the raw column lands on the day after the real start', () => {
    // What the fixed nudge does: raw column + 1, keeping the clock time.
    const nudged = isoForColumn(range, bar!.rawStartIndex + 1, startIso);
    expect(nudged).toBe(localIso(2026, 8, 21, 14));

    // What the old clamped nudge did — eleven days of history, destroyed.
    const clamped = isoForColumn(range, bar!.startIndex + 1, startIso);
    expect(clamped).toBe(localIso(2026, 9, 1, 14));
    expect(clamped).not.toBe(nudged);
  });

  test('the inversion guard runs against the raw span, not the drawn one', () => {
    const span = { startIndex: bar!.rawStartIndex, endIndex: bar!.rawEndIndex };
    // Moving the start one day right cannot collapse a bar that really is
    // 11 columns wide, even though its drawn span is only 3.
    expect(resizeBar(span, 'start', bar!.rawStartIndex + 1).startIndex).toBe(-10);
  });

  test('an ongoing bar reports today as its raw end', () => {
    expect(bar!.rawEndIndex).toBe(2); // today, 9/2
    expect(bar!.endIndex).toBe(2);
  });

  test('a bar running past the range keeps its real end column', () => {
    const earlier = buildRange('week', -1, NOW); // Mon 8/24 … Sun 8/30
    const [past] = buildBars(
      [work({ id: 'wpast', title: '지난주부터', status: 'active', startedAt: localIso(2026, 8, 25) })],
      earlier,
      NOW,
    );
    expect(past!.endIndex).toBe(6); // clamped to Sunday
    expect(past!.rawEndIndex).toBe(9); // 9/2 is column 9 of the 8/24 week
    expect(past!.clippedRight).toBe(true);
  });
});

describe('a terminal Work never borrows updatedAt for its end', () => {
  const range = buildRange('week', 0, NOW);

  test('a done Work with no resolvedAt draws to today, not to updatedAt', () => {
    const [bar] = buildBars(
      [work({
        id: 'wbroken',
        title: '종료일 없는 done',
        status: 'done',
        startedAt: localIso(2026, 8, 31),
        // A title edit two days after the fact. The old fallback let this grow
        // the bar, so a finished Work aged every time it was touched.
        updatedAt: localIso(2026, 9, 4, 10),
      })],
      range,
      NOW,
    );
    expect(bar!.endIndex).toBe(2); // today (9/2), *not* 9/4
  });

  test('a resolvedAt still wins when it is there', () => {
    const [bar] = buildBars(
      [work({
        id: 'wok',
        title: '정상 done',
        status: 'done',
        startedAt: localIso(2026, 8, 31),
        resolvedAt: localIso(2026, 9, 1, 18),
        updatedAt: localIso(2026, 9, 5, 10),
      })],
      range,
      NOW,
    );
    expect(bar!.endIndex).toBe(1);
  });
});

describe('describeTimelineError', () => {
  test('turns a bare route miss into a sentence with an action', () => {
    const message = describeTimelineError('Not found');
    expect(message).not.toBe('Not found');
    expect(message).toContain('데몬');
    expect(message.endsWith('.')).toBe(true);
  });

  test('names the network as the problem when the fetch never landed', () => {
    expect(describeTimelineError('Failed to fetch')).toContain('연결할 수 없습니다');
  });

  test('explains an over-long window in terms the toolbar can fix', () => {
    expect(describeTimelineError('window must not exceed 400 days')).toContain('기간이 너무 깁니다');
  });

  test('keeps an unrecognized message readable instead of dropping it', () => {
    const message = describeTimelineError('EPERM: operation not permitted');
    expect(message).toContain('문제가 생겼습니다');
    expect(message).toContain('EPERM');
  });
});

describe('describeWorkDateEdit', () => {
  test('names the field and the new day for an undo toast', () => {
    expect(describeWorkDateEdit('배포 자동화', 'start', localIso(2026, 8, 21)))
      .toBe('"배포 자동화" 시작일을 8/21로 옮겼습니다.');
  });

  test('calls an open Work’s end what it is — a plan', () => {
    expect(describeWorkDateEdit('배포 자동화', 'end', localIso(2026, 9, 5), { planned: true }))
      .toContain('종료 예정일');
    expect(describeWorkDateEdit('배포 자동화', 'end', localIso(2026, 9, 5)))
      .toContain('종료일');
  });
});
