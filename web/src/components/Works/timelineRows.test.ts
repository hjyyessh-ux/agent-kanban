import { describe, expect, test } from 'bun:test';
import type {
  TimelineCard,
  TimelineSessionSpan,
  Work,
  WorkStatus,
} from '../../../../src/core/types';
import { buildRange } from './timelineModel';
import {
  DIR_NONE_KEY,
  buildTimelineRows,
  dayCells,
  filterTimelineRows,
  filterTimelineSessions,
  filterTimelineWorks,
  isTimelineFilterActive,
  gridSpan,
  rangeWindow,
  timelineDirOptions,
  timelineLegend,
  todayColumn,
  TIMELINE_STATUS_LABELS,
  type TimelineRow,
  type TimelineSessionRow,
} from './timelineRows';

// A Thursday, so the week range runs Mon 2026-08-31 … Sun 2026-09-06.
const NOW = new Date('2026-09-03T10:00:00');
const RANGE = buildRange('week', 0, NOW);

function localIso(day: number, hour = 9): string {
  return new Date(2026, 8, day, hour, 0, 0).toISOString();
}

function tlCard(overrides: Partial<TimelineCard> & { id: string }): TimelineCard {
  return {
    title: overrides.id,
    status: 'done',
    startedAt: localIso(1),
    isSubagent: false,
    ...overrides,
  };
}

function span(overrides: Partial<TimelineSessionSpan> & { sessionId: string }): TimelineSessionSpan {
  return {
    agentRuntime: 'opencode',
    startedAt: localIso(1),
    endedAt: localIso(1, 10),
    cards: [tlCard({ id: `${overrides.sessionId}-c1` })],
    ...overrides,
  };
}

function work(overrides: Partial<Work> & { id: string; sessionIds?: string[] }): Work {
  const { sessionIds = [], ...rest } = overrides;
  return {
    title: overrides.id,
    status: 'active' as WorkStatus,
    sessionLinks: sessionIds.map((sessionId) => ({ sessionId, linkedAt: localIso(1) })),
    startedAt: localIso(1),
    createdAt: localIso(1),
    updatedAt: localIso(1),
    ...rest,
  } as Work;
}

function kinds(rows: TimelineRow[]): string[] {
  return rows.map((row) => `${row.kind}:${row.key.split(':').slice(1).join(':')}`);
}

describe('gridSpan', () => {
  test('clamps an interval that starts before the range', () => {
    expect(gridSpan(RANGE, localIso(-5), localIso(2), NOW)).toEqual({
      startIndex: 0,
      endIndex: 2,
      clippedLeft: true,
      clippedRight: false,
      ongoing: false,
    });
  });

  test('renders a three-minute card as a single day', () => {
    const short = gridSpan(
      RANGE,
      new Date(2026, 8, 2, 9, 0).toISOString(),
      new Date(2026, 8, 2, 9, 3).toISOString(),
      NOW,
    );
    expect(short).toMatchObject({ startIndex: 2, endIndex: 2 });
  });

  test('runs an open interval to today and marks it ongoing', () => {
    expect(gridSpan(RANGE, localIso(1), undefined, NOW)).toEqual({
      startIndex: 1,
      endIndex: 3,
      clippedLeft: false,
      clippedRight: false,
      ongoing: true,
    });
  });

  test('is null when the interval misses the range entirely', () => {
    expect(gridSpan(RANGE, localIso(-20), localIso(-15), NOW)).toBeNull();
    expect(gridSpan(RANGE, localIso(20), localIso(21), NOW)).toBeNull();
  });
});

describe('dayCells', () => {
  test('gives one cell per day a card was running on', () => {
    const cells = dayCells(RANGE, [tlCard({
      id: 'c-long',
      startedAt: localIso(1),
      completedAt: localIso(3),
    })], NOW);
    expect(cells.map((cell) => cell.column)).toEqual([1, 2, 3]);
  });

  test('paints a day by its most live card, not its last', () => {
    const cells = dayCells(RANGE, [
      tlCard({ id: 'c-done', status: 'done', startedAt: localIso(2), completedAt: localIso(2, 10) }),
      tlCard({ id: 'c-run', status: 'in_progress', startedAt: localIso(2, 11) }),
    ], NOW);
    const day = cells.find((cell) => cell.column === 2)!;
    expect(day.status).toBe('in_progress');
    expect(day.cards).toHaveLength(2);
  });

  test('drops cards that ran outside the range', () => {
    expect(dayCells(RANGE, [tlCard({
      id: 'c-old',
      startedAt: localIso(-10),
      completedAt: localIso(-9),
    })], NOW)).toEqual([]);
  });
});

describe('buildTimelineRows', () => {
  test('nests sessions under their Work inside a directory group', () => {
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-a', projectDir: '/w/kanban', startedAt: localIso(1), endedAt: localIso(1, 10) }),
        span({ sessionId: 'ses-b', projectDir: '/w/kanban', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      ],
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-a', 'ses-b'] })],
      range: RANGE,
      now: NOW,
    });
    expect(kinds(rows)).toEqual(['dir:/w/kanban', 'work:w-1', 'session:ses-a', 'session:ses-b']);
    const dir = rows[0]!;
    expect(dir).toMatchObject({ kind: 'dir', workCount: 1, sessionCount: 2 });
  });

  test('shows an unassigned session, after the Works in its directory', () => {
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-linked', projectDir: '/w/kanban' }),
        span({ sessionId: 'ses-loose', projectDir: '/w/kanban', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      ],
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-linked'] })],
      range: RANGE,
      now: NOW,
    });
    expect(kinds(rows)).toEqual([
      'dir:/w/kanban',
      'work:w-1',
      'session:ses-linked',
      'session:ses-loose',
    ]);
    const loose = rows[3] as TimelineSessionRow;
    expect(loose.workId).toBeUndefined();
  });

  test('moves a session under the Work as soon as it is assigned', () => {
    const sessions = [span({ sessionId: 'ses-a', projectDir: '/w/kanban' })];
    const before = buildTimelineRows({ sessions, works: [], range: RANGE, now: NOW });
    expect((before[1] as TimelineSessionRow).workId).toBeUndefined();

    const after = buildTimelineRows({
      sessions,
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-a'] })],
      range: RANGE,
      now: NOW,
    });
    expect(kinds(after)).toEqual(['dir:/w/kanban', 'work:w-1', 'session:ses-a']);
    expect((after[2] as TimelineSessionRow).workId).toBe('w-1');
  });

  test('keeps a Work whose sessions ran in another directory in one group', () => {
    // The Work owns its sessions, so its rows must never split across groups.
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-a', projectDir: '/w/kanban' }),
        span({ sessionId: 'ses-b', projectDir: '/w/other', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      ],
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-a', 'ses-b'] })],
      range: RANGE,
      now: NOW,
    });
    expect(rows.filter((row) => row.kind === 'dir')).toHaveLength(1);
    expect(kinds(rows)).toEqual(['dir:/w/kanban', 'work:w-1', 'session:ses-a', 'session:ses-b']);
  });

  test('falls back to the directory most of a Work’s sessions came from', () => {
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-a', projectDir: '/w/kanban' }),
        span({ sessionId: 'ses-b', projectDir: '/w/kanban', startedAt: localIso(2), endedAt: localIso(2, 10) }),
        span({ sessionId: 'ses-c', projectDir: '/w/other', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      ],
      works: [work({ id: 'w-1', projectDir: undefined, sessionIds: ['ses-a', 'ses-b', 'ses-c'] })],
      range: RANGE,
      now: NOW,
    });
    expect(rows[0]).toMatchObject({ kind: 'dir', projectDir: '/w/kanban' });
  });

  test('puts the directory-less bucket last', () => {
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-nodir', projectDir: undefined, startedAt: localIso(3), endedAt: localIso(3, 10) }),
        span({ sessionId: 'ses-dir', projectDir: '/w/kanban' }),
      ],
      works: [],
      range: RANGE,
      now: NOW,
    });
    expect(kinds(rows)).toEqual([
      'dir:/w/kanban',
      'session:ses-dir',
      `dir:${DIR_NONE_KEY}`,
      'session:ses-nodir',
    ]);
  });

  test('leaves out sessions that did not run in the window', () => {
    const rows = buildTimelineRows({
      sessions: [span({
        sessionId: 'ses-old',
        projectDir: '/w/kanban',
        startedAt: localIso(-20),
        endedAt: localIso(-19),
      })],
      works: [],
      range: RANGE,
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  test('keeps an open Work bracket even when nothing ran this week', () => {
    const rows = buildTimelineRows({
      sessions: [],
      works: [work({ id: 'w-quiet', projectDir: '/w/kanban', startedAt: localIso(-20) })],
      range: RANGE,
      now: NOW,
    });
    expect(kinds(rows)).toEqual(['dir:/w/kanban', 'work:w-quiet']);
    expect(rows[1]).toMatchObject({ kind: 'work', sessionCount: 0 });
    expect((rows[1] as { bar: unknown }).bar).not.toBeNull();
  });

  test('collapsing a directory hides everything under it', () => {
    const rows = buildTimelineRows({
      sessions: [span({ sessionId: 'ses-a', projectDir: '/w/kanban' })],
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-a'] })],
      range: RANGE,
      now: NOW,
      collapsedDirs: new Set(['/w/kanban']),
    });
    expect(kinds(rows)).toEqual(['dir:/w/kanban']);
    expect(rows[0]).toMatchObject({ collapsed: true, sessionCount: 1 });
  });

  test('collapsing a Work hides its sessions but keeps its bracket', () => {
    const rows = buildTimelineRows({
      sessions: [span({ sessionId: 'ses-a', projectDir: '/w/kanban' })],
      works: [work({ id: 'w-1', projectDir: '/w/kanban', sessionIds: ['ses-a'] })],
      range: RANGE,
      now: NOW,
      collapsedWorks: new Set(['w-1']),
    });
    expect(kinds(rows)).toEqual(['dir:/w/kanban', 'work:w-1']);
    expect(rows[1]).toMatchObject({ collapsed: true, sessionCount: 1 });
  });

  test('treats a trailing slash as the same directory', () => {
    const rows = buildTimelineRows({
      sessions: [
        span({ sessionId: 'ses-a', projectDir: '/w/kanban/' }),
        span({ sessionId: 'ses-b', projectDir: '/w/kanban', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      ],
      works: [],
      range: RANGE,
      now: NOW,
    });
    expect(rows.filter((row) => row.kind === 'dir')).toHaveLength(1);
  });
});

describe('range helpers', () => {
  test('todayColumn is null when the range does not contain today', () => {
    expect(todayColumn(RANGE, NOW)).toBe(3);
    expect(todayColumn(buildRange('week', -4, NOW), NOW)).toBeNull();
  });

  test('rangeWindow covers the whole first and last day, local time', () => {
    const { from, to } = rangeWindow(RANGE);
    expect(new Date(from).getTime()).toBe(RANGE.start.getTime());
    expect(new Date(to).getTime()).toBe(RANGE.start.getTime() + RANGE.days.length * 86_400_000 - 1);
  });
});

describe('a session truncated by the window reads as clipped', () => {
  test('gridSpan cuts the left edge when the server dropped earlier cards', () => {
    // The reported start is inside the range, but `truncatedBefore` says the
    // session had already been running: the window filter dropped the cards
    // that ran before it, so min() over what arrived is not the real start.
    const span = gridSpan(RANGE, localIso(2), localIso(3), NOW, { truncatedBefore: true });
    expect(span).not.toBeNull();
    expect(span!.startIndex).toBe(2);
    expect(span!.clippedLeft).toBe(true);
  });

  test('without the flag the same interval keeps a closed left edge', () => {
    expect(gridSpan(RANGE, localIso(2), localIso(3), NOW)!.clippedLeft).toBe(false);
  });

  test('buildTimelineRows carries the flag onto the session row', () => {
    const rows = buildTimelineRows({
      sessions: [span({ sessionId: 's-trunc', startedAt: localIso(2), endedAt: localIso(2, 11), truncatedBefore: true })],
      works: [],
      range: RANGE,
      now: NOW,
    });
    const session = rows.find((row): row is TimelineSessionRow => row.kind === 'session');
    expect(session?.span.clippedLeft).toBe(true);
  });
});

describe('timelineLegend', () => {
  const legendKeys = (rows: TimelineRow[]) => timelineLegend(rows).map((item) => item.key);

  test('is empty for an empty grid', () => {
    expect(timelineLegend([])).toEqual([]);
  });

  test('lists only the statuses the grid actually draws', () => {
    const rows = buildTimelineRows({
      sessions: [span({
        sessionId: 's-legend',
        cards: [
          tlCard({ id: 'c-done', status: 'done', startedAt: localIso(1), completedAt: localIso(1, 10) }),
          tlCard({ id: 'c-complete', status: 'complete', startedAt: localIso(2), completedAt: localIso(2, 10) }),
        ],
      })],
      works: [],
      range: RANGE,
      now: NOW,
    });
    // No `work` entry (no bar on the grid) and — the original defect — no
    // `todo` entry, which the fixed six-item list advertised forever even
    // though only executed cards reach this view.
    expect(legendKeys(rows)).toEqual(['session', 'complete', 'done']);
  });

  test('adds the Work layer only once a bar is drawn', () => {
    const rows = buildTimelineRows({
      sessions: [],
      works: [{
        id: 'w-legend',
        title: '진행중 Work',
        status: 'active' as WorkStatus,
        startedAt: localIso(1),
        createdAt: localIso(1),
        updatedAt: localIso(1),
        sessionLinks: [],
      }],
      range: RANGE,
      now: NOW,
    });
    expect(legendKeys(rows)).toEqual(['work']);
  });

  test('every entry the legend can emit has a Korean label', () => {
    const rows = buildTimelineRows({
      sessions: [span({
        sessionId: 's-all',
        cards: [
          tlCard({ id: 'a', status: 'todo', startedAt: localIso(1), completedAt: localIso(1, 10) }),
          tlCard({ id: 'b', status: 'in_progress', startedAt: localIso(2), completedAt: localIso(2, 10) }),
          tlCard({ id: 'c', status: 'complete', startedAt: localIso(3), completedAt: localIso(3, 10) }),
          tlCard({ id: 'd', status: 'done', startedAt: localIso(4), completedAt: localIso(4, 10) }),
        ],
      })],
      works: [],
      range: RANGE,
      now: NOW,
    });
    const items = timelineLegend(rows);
    // Mixed 완료 / Done was the readability defect: one screen, two languages.
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(/[A-Za-z]/.test(item.label.replace('Work', ''))).toBe(false);
    }
    // `complete` is red but not a failure, so its label says what it is.
    expect(items.find((i) => i.key === 'complete')?.label).toBe(TIMELINE_STATUS_LABELS.complete);
    expect(TIMELINE_STATUS_LABELS.complete).toBe('검토 대기');
  });
});

describe('directory filter', () => {
  const rowsFor = () => buildTimelineRows({
    sessions: [
      span({ sessionId: 's-a1', projectDir: '/w/alpha', startedAt: localIso(1), endedAt: localIso(1, 10) }),
      span({ sessionId: 's-a2', projectDir: '/w/alpha', startedAt: localIso(2), endedAt: localIso(2, 10) }),
      span({ sessionId: 's-b1', projectDir: '/w/beta', startedAt: localIso(3), endedAt: localIso(3, 10) }),
      span({ sessionId: 's-none', startedAt: localIso(4), endedAt: localIso(4, 10) }),
    ],
    works: [],
    range: RANGE,
    now: NOW,
  });

  test('offers one option per directory group, in the grid’s own row order', () => {
    const options = timelineDirOptions(rowsFor());
    // Same order the rows are in — most recent activity first, the
    // directory-less bucket always last.
    expect(options.map((o) => o.groupKey)).toEqual(['/w/beta', '/w/alpha', DIR_NONE_KEY]);
    expect(options.find((o) => o.groupKey === '/w/alpha')?.sessionCount).toBe(2);
    expect(options.find((o) => o.groupKey === '/w/beta')?.sessionCount).toBe(1);
  });

  test('exposes groupKey as a field instead of a sliced row key', () => {
    const dirRow = rowsFor().find((row) => row.kind === 'dir');
    expect(dirRow?.kind).toBe('dir');
    if (dirRow?.kind !== 'dir') throw new Error('expected a dir row');
    expect(dirRow.key).toBe(`dir:${dirRow.groupKey}`);
  });

  test('keeps only the selected group’s rows', () => {
    const kept = filterTimelineRows(rowsFor(), '/w/alpha');
    expect(kept.filter((row) => row.kind === 'dir')).toHaveLength(1);
    const sessions = kept.filter((row): row is TimelineSessionRow => row.kind === 'session');
    expect(sessions.map((row) => row.session.sessionId)).toEqual(['s-a2', 's-a1']);
  });

  test('null keeps the whole grid, and an unknown group keeps nothing', () => {
    const all = rowsFor();
    expect(filterTimelineRows(all, null)).toBe(all);
    expect(filterTimelineRows(all, '/w/missing')).toEqual([]);
  });

  test('the directory-less bucket is selectable too', () => {
    const kept = filterTimelineRows(rowsFor(), DIR_NONE_KEY);
    const sessions = kept.filter((row): row is TimelineSessionRow => row.kind === 'session');
    expect(sessions.map((row) => row.session.sessionId)).toEqual(['s-none']);
  });
});

describe('filterTimelineSessions / filterTimelineWorks (Board FILTER bar on the grid)', () => {
  const sessions = [
    span({ sessionId: 's-pay', sessionTitle: '결제 모듈 리팩터링', projectDir: '/w/agent-kanban' }),
    span({ sessionId: 's-cf', projectDir: '/w/mcp-server/', cards: [tlCard({ id: 'c', title: 'cloudflare cache purge' })] }),
    span({ sessionId: 's-none', cards: [tlCard({ id: 'n', title: '오늘 뭐 먹지' })] }),
  ];
  const works = [
    work({ id: 'w-pay', title: '결제 모듈', projectDir: '/w/agent-kanban', sessionIds: ['s-pay'] }),
    work({ id: 'w-cf', title: 'mcp-server cache 개선', projectDir: '/w/mcp-server', sessionIds: ['s-cf'] }),
    work({ id: 'w-empty', title: 'cache 계획만', projectDir: '/w/zetta' }),
  ];

  test('an empty filter is a no-op and keeps the same arrays', () => {
    expect(filterTimelineSessions(sessions, { search: ' ', directory: '' })).toBe(sessions);
    expect(filterTimelineWorks(works, sessions, undefined)).toBe(works);
    expect(isTimelineFilterActive({ search: '  ' })).toBe(false);
  });

  test('search matches the session title, any card title, or the id', () => {
    expect(filterTimelineSessions(sessions, { search: '결제' }).map((s) => s.sessionId)).toEqual(['s-pay']);
    expect(filterTimelineSessions(sessions, { search: 'PURGE' }).map((s) => s.sessionId)).toEqual(['s-cf']);
    expect(filterTimelineSessions(sessions, { search: 's-none' }).map((s) => s.sessionId)).toEqual(['s-none']);
  });

  test('directory compares normalized paths (trailing slash, case)', () => {
    expect(filterTimelineSessions(sessions, { directory: '/w/mcp-server' }).map((s) => s.sessionId)).toEqual(['s-cf']);
    expect(filterTimelineSessions(sessions, { directory: '/W/Agent-Kanban/' }).map((s) => s.sessionId)).toEqual(['s-pay']);
  });

  test('a Work survives through a kept session, or through its own title/directory under search', () => {
    const kept = filterTimelineSessions(sessions, { search: 'cache' });
    expect(kept.map((s) => s.sessionId)).toEqual(['s-cf']);
    // w-cf via its session; w-empty via its own title; w-pay drops.
    expect(filterTimelineWorks(works, kept, { search: 'cache' }).map((w) => w.id)).toEqual(['w-cf', 'w-empty']);
  });

  test('a session-id filter names sessions, so a Work without one is out even if its title matches', () => {
    const kept = filterTimelineSessions(sessions, { sessionId: 's-cf' });
    expect(filterTimelineWorks(works, kept, { sessionId: 's-cf' }).map((w) => w.id)).toEqual(['w-cf']);
  });

  test('directory alone keeps Works of that directory even with no session on the grid', () => {
    const kept = filterTimelineSessions(sessions, { directory: '/w/zetta' });
    expect(kept).toEqual([]);
    expect(filterTimelineWorks(works, kept, { directory: '/w/zetta' }).map((w) => w.id)).toEqual(['w-empty']);
  });
});
