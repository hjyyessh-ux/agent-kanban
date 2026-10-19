import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import {
  buildDirectoryOptions,
  buildDirectoryTotals,
  filterDirectoryOptions,
  formatActivityAge,
  formatDirectoryCountBreakdown,
  splitDirectoryOptions,
  type DirectoryOption,
} from './directory-display';
import { selectColumns } from './board-selectors';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'todo',
    createdAt: iso(30 * DAY),
    updatedAt: iso(30 * DAY),
    ...overrides,
  };
}

function option(value: string, overrides: Partial<DirectoryOption> = {}): DirectoryOption {
  return {
    value,
    label: value.split('/').pop() ?? value,
    count: 1,
    doneCount: 0,
    childCount: 0,
    latestActivity: 0,
    recentCount: 0,
    ...overrides,
  };
}

describe('count definition', () => {
  const cards: KanbanCard[] = [
    makeCard('a1', { projectDir: '/w/a', status: 'todo' }),
    makeCard('a2', { projectDir: '/w/a', status: 'in_progress' }),
    makeCard('a3', { projectDir: '/w/a', status: 'complete' }),
    makeCard('a4', { projectDir: '/w/a', status: 'done' }),
    makeCard('a5', { projectDir: '/w/a', status: 'complete', parentCardId: 'a2', linkKind: 'subagent' }),
    makeCard('b1', { projectDir: '/w/b', status: 'done' }),
    makeCard('n1', { status: 'todo' }),
  ];

  test('a project chip counts in-flight top-level cards only', () => {
    const a = buildDirectoryOptions(cards, NOW).find((entry) => entry.value === '/w/a');
    expect(a).toMatchObject({ count: 3, doneCount: 1, childCount: 1 });
  });

  test('a project with only done cards still appears, with count 0', () => {
    const b = buildDirectoryOptions(cards, NOW).find((entry) => entry.value === '/w/b');
    expect(b).toMatchObject({ count: 0, doneCount: 1, childCount: 0 });
  });

  test('All uses the same definition, cards without a projectDir included', () => {
    expect(buildDirectoryTotals(cards)).toEqual({ count: 4, doneCount: 2, childCount: 1 });
  });

  test('All equals the sum of the todo/in_progress/complete column counts', () => {
    const activeColumnSum = selectColumns(cards)
      .filter((column) => column.status !== 'done')
      .reduce((sum, column) => sum + column.count, 0);
    expect(buildDirectoryTotals(cards).count).toBe(activeColumnSum);
  });

  test('a linked child whose parent is gone still counts as child, not active', () => {
    const orphan = makeCard('o1', { projectDir: '/w/a', parentCardId: 'missing', linkKind: 'worker' });
    expect(buildDirectoryTotals([orphan])).toEqual({ count: 0, doneCount: 0, childCount: 1 });
  });

  test('tooltip breakdown text', () => {
    expect(formatDirectoryCountBreakdown({ count: 12, doneCount: 40, childCount: 2 }))
      .toBe('active 12 · done 40 · child 2');
  });
});

describe('ordering', () => {
  test('recent 7-day activity beats a larger but stale project', () => {
    const cards = [
      ...['1', '2', '3'].map((id) => makeCard(`big${id}`, { projectDir: '/w/big' })),
      makeCard('fresh', { projectDir: '/w/fresh', updatedAt: iso(2 * DAY) }),
    ];
    expect(buildDirectoryOptions(cards, NOW).map((entry) => entry.value)).toEqual(['/w/fresh', '/w/big']);
  });

  test('activity older than 7 days does not count as recent', () => {
    const cards = [makeCard('x', { projectDir: '/w/x', updatedAt: iso(8 * DAY) })];
    expect(buildDirectoryOptions(cards, NOW)[0].recentCount).toBe(0);
  });

  test('without recent activity, the in-flight card count decides', () => {
    const cards = [
      makeCard('s1', { projectDir: '/w/small' }),
      makeCard('l1', { projectDir: '/w/large' }),
      makeCard('l2', { projectDir: '/w/large' }),
      makeCard('d1', { projectDir: '/w/small', status: 'done' }),
      makeCard('d2', { projectDir: '/w/small', status: 'done' }),
    ];
    expect(buildDirectoryOptions(cards, NOW).map((entry) => entry.value)).toEqual(['/w/large', '/w/small']);
  });

  test('duplicate project names get their parent as a hint', () => {
    const cards = [
      makeCard('1', { projectDir: '/w/zadar/workspace' }),
      makeCard('2', { projectDir: '/w/other/workspace' }),
    ];
    expect(buildDirectoryOptions(cards, NOW).map((entry) => entry.label).sort())
      .toEqual(['workspace · other', 'workspace · zadar']);
  });
});

describe('splitDirectoryOptions (Top-N)', () => {
  const options = ['a', 'b', 'c', 'd', 'e'].map((value) => option(value));
  const layout = { widths: [100, 100, 100, 100, 100], gap: 10, moreWidth: 80, selected: '' };

  test('everything fits → no More', () => {
    const split = splitDirectoryOptions(options, { ...layout, available: 550 });
    expect(split.visible).toHaveLength(5);
    expect(split.overflow).toHaveLength(0);
  });

  test('overflow reserves room for the More trigger', () => {
    // All five need 550; with More reserved (10 + 80) the budget is 459 → four chips (440).
    const split = splitDirectoryOptions(options, { ...layout, available: 549 });
    expect(split.visible.map((entry) => entry.value)).toEqual(['a', 'b', 'c', 'd']);
    expect(split.overflow.map((entry) => entry.value)).toEqual(['e']);
  });

  test('stops at the first chip that does not fit (keeps order)', () => {
    const split = splitDirectoryOptions(options, {
      ...layout,
      widths: [100, 300, 20, 20, 20],
      available: 300,
    });
    expect(split.visible.map((entry) => entry.value)).toEqual(['a']);
  });

  test('a selected option that would overflow replaces the last visible chip', () => {
    const split = splitDirectoryOptions(options, { ...layout, available: 400, selected: 'e' });
    // budget 310 → a, b fit (220); e (110) does not fit beside both, so b gives way.
    expect(split.visible.map((entry) => entry.value)).toEqual(['a', 'e']);
    expect(split.overflow.map((entry) => entry.value)).toEqual(['b', 'c', 'd']);
  });

  test('a selected option already visible stays where it is', () => {
    const split = splitDirectoryOptions(options, { ...layout, available: 400, selected: 'b' });
    expect(split.visible.map((entry) => entry.value)).toEqual(['a', 'b']);
  });

  test('the selected option is shown even when nothing else fits', () => {
    const split = splitDirectoryOptions(options, { ...layout, available: 50, selected: 'c' });
    expect(split.visible.map((entry) => entry.value)).toEqual(['c']);
  });

  test('unmeasured layout shows every option', () => {
    const split = splitDirectoryOptions(options, { ...layout, widths: [], available: 0 });
    expect(split.visible).toHaveLength(5);
  });
});

describe('More search + age', () => {
  const options = [
    option('/Users/me/zdd-zetta2'),
    option('/Users/me/zepetoful-fe'),
    option('/Users/me/agent-kanban'),
  ];

  test('matches label or full path, case-insensitive', () => {
    expect(filterDirectoryOptions(options, 'ZE').map((entry) => entry.label))
      .toEqual(['zdd-zetta2', 'zepetoful-fe']);
    expect(filterDirectoryOptions(options, '/users/me').map((entry) => entry.label)).toHaveLength(3);
    expect(filterDirectoryOptions(options, '  ')).toBe(options);
  });

  test('compact age of the last activity', () => {
    expect(formatActivityAge(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(formatActivityAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3h');
    expect(formatActivityAge(NOW - 2 * DAY, NOW)).toBe('2d');
    expect(formatActivityAge(0, NOW)).toBe('—');
  });
});
