import { describe, expect, test } from 'bun:test';
import type { KanbanCard, Work } from '../../../../src/core/types';
import {
  WORK_VISIBLE_SESSIONS,
  countFavoriteCards,
  filterCardsByWork,
  indexWorksBySession,
  resolveWorkDrop,
  resolveWorkFilter,
  selectWorkFragments,
  summarizeGroupFavorites,
  type WorkDragSource,
} from './board-works';
import { filterUnreadOnly } from './board-filters';

let seq = 0;
function card(overrides: Partial<KanbanCard>): KanbanCard {
  seq += 1;
  return {
    id: `c${seq}`,
    title: `Card ${seq}`,
    description: '',
    status: 'complete',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    // Read unless a test says otherwise.
    completedAt: '2026-10-20T01:00:00.000Z',
    completedSeenAt: '2026-10-20T02:00:00.000Z',
    ...overrides,
  };
}

/** A complete turn answered at `hour` (UTC) on 10-20 — larger hour = newer. */
function turn(sessionId: string | undefined, hour: number, overrides: Partial<KanbanCard> = {}): KanbanCard {
  const at = `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return card({ sessionId, completedAt: at, completedSeenAt: at, updatedAt: at, ...overrides });
}

function work(id: string, sessionIds: string[]): Work {
  return {
    id,
    title: `Work ${id}`,
    status: 'active',
    sessionLinks: sessionIds.map((sessionId) => ({ sessionId, linkedAt: '2026-10-19T00:00:00.000Z' })),
    startedAt: '2026-10-19T00:00:00.000Z',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  };
}

const unread = { completedSeenAt: undefined };

describe('selectWorkFragments — splitting', () => {
  test('groups a column by Work, newest session first, showing the newest two', () => {
    const cards = [
      turn('s1', 1), turn('s2', 3), turn('s3', 5), turn('s3', 6),
      turn('s9', 4), // linked to no Work
    ];
    const model = selectWorkFragments({ cards, works: [work('W1', ['s1', 's2', 's3'])] });

    const [fragment] = model.complete.fragments;
    expect(model.complete.fragments).toHaveLength(1);
    expect(fragment.groups.map((group) => group.sessionId)).toEqual(['s3', 's2', 's1']);
    expect(WORK_VISIBLE_SESSIONS).toBe(2);
    expect(fragment.visibleGroups.map((group) => group.sessionId)).toEqual(['s3', 's2']);
    expect(fragment.hiddenCount).toBe(1);
    expect(fragment.sessionCount).toBe(3);
    expect(fragment.groups[0].cards).toHaveLength(2);
    expect(model.complete.unassigned.map((group) => group.sessionId)).toEqual(['s9']);
  });

  test('orders fragments in a column by their newest session', () => {
    const cards = [turn('a1', 2), turn('b1', 7), turn('a2', 5)];
    const model = selectWorkFragments({ cards, works: [work('A', ['a1', 'a2']), work('B', ['b1'])] });
    expect(model.complete.fragments.map((fragment) => fragment.work.id)).toEqual(['B', 'A']);
  });

  test('every column is present, empty ones included', () => {
    const model = selectWorkFragments({ cards: [], works: [work('W1', ['s1'])] });
    for (const status of ['todo', 'in_progress', 'complete', 'done'] as const) {
      expect(model[status]).toEqual({ status, fragments: [], unassigned: [] });
    }
  });

  test('children ride inside their parent and never form their own group', () => {
    const parent = turn('s1', 3);
    const child = card({ sessionId: 'child-session', parentCardId: parent.id, linkKind: 'subagent' });
    const model = selectWorkFragments({ cards: [parent, child], works: [work('W1', ['s1'])] });
    expect(model.complete.fragments[0].groups).toHaveLength(1);
    expect(model.complete.unassigned).toEqual([]);
  });
});

describe('selectWorkFragments — unassigned', () => {
  test('a card without sessionId is always unassigned, even when a Work links an odd id', () => {
    const loose = card({ sessionId: undefined });
    const model = selectWorkFragments({ cards: [loose], works: [work('W1', [`card:${loose.id}`, ''])] });
    expect(model.complete.fragments).toEqual([]);
    expect(model.complete.unassigned).toHaveLength(1);
    expect(model.complete.unassigned[0].key).toBe(`card:${loose.id}`);
  });

  test('a session linked only to a Work that was not passed in is unassigned', () => {
    const model = selectWorkFragments({ cards: [turn('s1', 1)], works: [] });
    expect(model.complete.unassigned.map((group) => group.sessionId)).toEqual(['s1']);
  });
});

describe('selectWorkFragments — spread across columns', () => {
  const cards = [
    turn('s1', 1),                              // complete
    turn('s2', 2, { status: 'done' }),          // done
    turn('s3', 3, { status: 'in_progress' }),   // in progress
    turn('s4', 4, { status: 'done' }),          // done
    turn('s1', 5, { status: 'done' }),          // s1 also has a done turn
  ];
  const model = selectWorkFragments({ cards, works: [work('W1', ['s1', 's2', 's3', 's4'])] });

  test('x / y counts this column against distinct sessions everywhere', () => {
    const complete = model.complete.fragments[0];
    expect(complete.sessionCount).toBe(1);
    expect(complete.totalSessionCount).toBe(4); // s1 counted once across complete + done
    const done = model.done.fragments[0];
    expect(done.sessionCount).toBe(3);
    expect(done.totalSessionCount).toBe(4);
  });

  test('other columns are listed in board order with their session counts', () => {
    expect(model.complete.fragments[0].elsewhere).toEqual([
      { status: 'in_progress', sessionCount: 1 },
      { status: 'done', sessionCount: 3 },
    ]);
    expect(model.in_progress.fragments[0].elsewhere).toEqual([
      { status: 'complete', sessionCount: 1 },
      { status: 'done', sessionCount: 3 },
    ]);
  });
});

describe('selectWorkFragments — unread', () => {
  test('sums unread across the fragment and inside the folded sessions', () => {
    const cards = [
      turn('s1', 9, unread),
      turn('s2', 8),
      turn('s3', 7, unread), turn('s3', 6, unread),
    ];
    const [fragment] = selectWorkFragments({ cards, works: [work('W1', ['s1', 's2', 's3'])] }).complete.fragments;
    expect(fragment.unreadCount).toBe(3);
    expect(fragment.hiddenCount).toBe(1);
    expect(fragment.hiddenUnreadCount).toBe(2);
  });

  test('unread-only hides a Work whose sessions are all read, and the done column empties', () => {
    const board = [
      turn('a1', 3, unread), turn('a1', 2),
      turn('b1', 4),
      turn('b2', 5, { status: 'done' }),
    ];
    const visible = filterUnreadOnly(board, { groupBySession: true });
    const model = selectWorkFragments({ cards: visible, boardCards: board, works: [work('A', ['a1']), work('B', ['b1', 'b2'])] });

    expect(model.complete.fragments.map((fragment) => fragment.work.id)).toEqual(['A']);
    // Session grouping keeps the read turn beside the unread one.
    expect(model.complete.fragments[0].groups[0].cards).toHaveLength(2);
    expect(model.done.fragments).toEqual([]);
  });
});

describe('WORK filter', () => {
  const works = [work('A', ['a1']), work('B', ['b1'])];
  const index = indexWorksBySession(works);
  const parent = turn('a1', 1);
  const child = card({ parentCardId: parent.id, linkKind: 'subagent', sessionId: undefined });
  const board = [parent, child, turn('b1', 2), turn('x1', 3), card({ sessionId: undefined })];

  test('all is a no-op', () => {
    expect(filterCardsByWork(board, 'all', index)).toBe(board);
  });

  test('one Work keeps its sessions and their children, and hides other Works', () => {
    const kept = filterCardsByWork(board, { workId: 'A' }, index);
    expect(kept.map((entry) => entry.id)).toEqual([parent.id, child.id]);
    const model = selectWorkFragments({ cards: kept, boardCards: board, works });
    expect(model.complete.fragments.map((fragment) => fragment.work.id)).toEqual(['A']);
    expect(model.complete.unassigned).toEqual([]);
  });

  test('unassigned keeps unlinked sessions and session-less cards, and hides every Work', () => {
    const kept = filterCardsByWork(board, 'unassigned', index);
    expect(kept.map((entry) => entry.sessionId)).toEqual(['x1', undefined]);
    const model = selectWorkFragments({ cards: kept, works });
    expect(model.complete.fragments).toEqual([]);
    expect(model.complete.unassigned).toHaveLength(2);
  });

  test('a Work that is no longer active falls back to all', () => {
    expect(resolveWorkFilter({ workId: 'A' }, works)).toEqual({ workId: 'A' });
    expect(resolveWorkFilter({ workId: 'gone' }, works)).toBe('all');
    expect(resolveWorkFilter('unassigned', [])).toBe('unassigned');
  });
});

describe('favorites', () => {
  test('Work ★ counts top-level favorites of the whole Work on the board, ignoring filters', () => {
    const favDone = turn('s2', 1, { status: 'done', favorite: true });
    const favComplete = turn('s1', 2, { favorite: true });
    const favChild = card({ parentCardId: favComplete.id, linkKind: 'subagent', favorite: true, sessionId: 's1' });
    const otherWorkFav = turn('x1', 3, { favorite: true });
    const board = [favDone, favComplete, favChild, otherWorkFav, turn('s1', 4)];

    // Only the complete column is visible (e.g. a filter) — ★ still sees the done card.
    const visible = board.filter((entry) => entry.status === 'complete' && entry.id !== otherWorkFav.id);
    const model = selectWorkFragments({ cards: visible, boardCards: board, works: [work('W1', ['s1', 's2']), work('W2', ['x1'])] });
    expect(model.complete.fragments.map((fragment) => [fragment.work.id, fragment.favoriteCount])).toEqual([['W1', 2]]);
  });

  test('session ★ N counts the group, and Show N more · ★ k counts only the folded turns', () => {
    const cards = [
      turn('s1', 9, { favorite: true }),
      turn('s1', 8),
      turn('s1', 7, { favorite: true }),
      turn('s1', 6, { favorite: true }),
    ];
    const [group] = selectWorkFragments({ cards, works: [work('W1', ['s1'])] }).complete.fragments[0].groups;
    expect(countFavoriteCards(group.cards)).toBe(3);
    expect(summarizeGroupFavorites(group, 2)).toEqual({ total: 3, hidden: 2 });
    expect(summarizeGroupFavorites(group, 5)).toEqual({ total: 3, hidden: 0 });
  });
});

describe('indexWorksBySession', () => {
  test('the first Work linking a session wins', () => {
    const index = indexWorksBySession([work('A', ['s1']), work('B', ['s1', 's2'])]);
    expect(index.get('s1')?.id).toBe('A');
    expect(index.get('s2')?.id).toBe('B');
  });
});

describe('resolveWorkDrop', () => {
  const source = (overrides: Partial<WorkDragSource> = {}): WorkDragSource => ({
    cardId: 'c1',
    sessionId: 's1',
    status: 'complete',
    title: 'Session one',
    ...overrides,
  });

  test('an unassigned session dropped on a Work in its column links it', () => {
    expect(resolveWorkDrop(source(), { kind: 'work', workId: 'W1', status: 'complete' }))
      .toEqual({ kind: 'link', toWorkId: 'W1' });
  });

  test('a session in another Work moves; its own Work is no target', () => {
    const inW2 = source({ workId: 'W2' });
    expect(resolveWorkDrop(inW2, { kind: 'work', workId: 'W1', status: 'complete' }))
      .toEqual({ kind: 'move', fromWorkId: 'W2', toWorkId: 'W1' });
    expect(resolveWorkDrop(inW2, { kind: 'work', workId: 'W2', status: 'complete' })).toBeNull();
  });

  test('the same column UNASSIGNED zone unlinks; an unassigned session has nothing to leave', () => {
    expect(resolveWorkDrop(source({ workId: 'W2' }), { kind: 'unassigned', status: 'complete' }))
      .toEqual({ kind: 'unlink', fromWorkId: 'W2' });
    expect(resolveWorkDrop(source(), { kind: 'unassigned', status: 'complete' })).toBeNull();
  });

  test('column-bound targets in another column are not Works drops (status meaning stays)', () => {
    const fromDone = source({ status: 'done', workId: 'W2' });
    expect(resolveWorkDrop(fromDone, { kind: 'work', workId: 'W1', status: 'complete' })).toBeNull();
    expect(resolveWorkDrop(fromDone, { kind: 'unassigned', status: 'complete' })).toBeNull();
  });

  test('tray targets (no status) work from any column', () => {
    const card = source({ status: 'in_progress', workId: 'W2' });
    expect(resolveWorkDrop(card, { kind: 'work', workId: 'W1' })).toEqual({ kind: 'move', fromWorkId: 'W2', toWorkId: 'W1' });
    expect(resolveWorkDrop(card, { kind: 'unassigned' })).toEqual({ kind: 'unlink', fromWorkId: 'W2' });
  });

  test('＋ 새 Work creates for an unassigned session and splits one out of a Work', () => {
    expect(resolveWorkDrop(source(), { kind: 'new' })).toEqual({ kind: 'create' });
    expect(resolveWorkDrop(source({ workId: 'W2' }), { kind: 'new' })).toEqual({ kind: 'moveToNew', fromWorkId: 'W2' });
  });

  test('a source without a session is never assignable', () => {
    const loose = source({ sessionId: undefined });
    for (const target of [
      { kind: 'work', workId: 'W1', status: 'complete' },
      { kind: 'work', workId: 'W1' },
      { kind: 'unassigned' },
      { kind: 'new' },
    ] as const) {
      expect(resolveWorkDrop(loose, target)).toBeNull();
    }
  });
});
