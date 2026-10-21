import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { selectColumns } from './board-selectors';
import { orderColumnsForList } from './BoardListView';
import {
  isTypingTarget,
  nextUnreadTarget,
  selectBoardNavOrder,
  type UnreadNavEntry,
} from './unread-navigation';
import { selectWorkFragments } from './board-works';

const SEEN = '2026-10-18T23:00:00.000Z';

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'complete',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete card whose completion lands at `hour` — later hour = newer. */
function completeAt(id: string, hour: number, overrides: Partial<KanbanCard> = {}): KanbanCard {
  const at = `2026-10-18T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return makeCard(id, { completedAt: at, updatedAt: at, responseAt: at, ...overrides });
}

function entry(id: string, unread: boolean, status: UnreadNavEntry['status'] = 'complete'): UnreadNavEntry {
  return { id, unread, status };
}

describe('nextUnreadTarget', () => {
  const entries = [
    entry('a', false, 'todo'),
    entry('b', true),
    entry('c', false),
    entry('d', true),
    entry('e', true, 'done'),
  ];

  test('with no cursor, next starts from the top and prev from the bottom', () => {
    expect(nextUnreadTarget(entries, null, 'next')?.id).toBe('b');
    expect(nextUnreadTarget(entries, null, 'prev')?.id).toBe('e');
  });

  test('moves past the cursor and wraps around the board', () => {
    expect(nextUnreadTarget(entries, 'b', 'next')?.id).toBe('d');
    expect(nextUnreadTarget(entries, 'e', 'next')?.id).toBe('b');
    expect(nextUnreadTarget(entries, 'b', 'prev')?.id).toBe('e');
  });

  test('a cursor that was just read still anchors the position', () => {
    // `c` is read, but sits between b and d.
    expect(nextUnreadTarget(entries, 'c', 'next')?.id).toBe('d');
    expect(nextUnreadTarget(entries, 'c', 'prev')?.id).toBe('b');
  });

  test('a cursor gone from the board starts from the edge', () => {
    expect(nextUnreadTarget(entries, 'gone', 'next')?.id).toBe('b');
    expect(nextUnreadTarget(entries, 'gone', 'prev')?.id).toBe('e');
  });

  test('a status limits the walk to one column (the column pill)', () => {
    expect(nextUnreadTarget(entries, 'd', 'next', 'complete')?.id).toBe('b');
    expect(nextUnreadTarget(entries, 'e', 'next', 'complete')?.id).toBe('b');
  });

  test('the only unread card returns itself; none returns null', () => {
    expect(nextUnreadTarget([entry('x', true)], 'x', 'next')?.id).toBe('x');
    expect(nextUnreadTarget([entry('x', false)], null, 'next')).toBeNull();
    expect(nextUnreadTarget([], null, 'prev')).toBeNull();
  });
});

describe('selectBoardNavOrder', () => {
  const cards = [
    makeCard('todo-1', { status: 'todo' }),
    completeAt('s1-old', 1, { sessionId: 's1' }),
    completeAt('s1-new', 5, { sessionId: 's1' }),
    completeAt('s2-only', 3, { sessionId: 's2', completedSeenAt: SEEN }),
  ];

  test('flat complete column follows the column sort, unread flags from the view model', () => {
    const order = selectBoardNavOrder(selectColumns(cards), cards, { groupComplete: false, groupDone: true });
    expect(order.map((item) => item.id)).toEqual(['todo-1', 's1-new', 's2-only', 's1-old']);
    expect(order.map((item) => item.unread)).toEqual([false, true, false, true]);
    expect(order.every((item) => item.groupKey === undefined)).toBe(true);
  });

  test('session-grouped column walks groups newest-first, turns newest-first, with group keys', () => {
    const order = selectBoardNavOrder(selectColumns(cards), cards, { groupComplete: true, groupDone: true });
    expect(order.map((item) => item.id)).toEqual(['todo-1', 's1-new', 's1-old', 's2-only']);
    expect(order.find((item) => item.id === 's1-old')?.groupKey).toBe('session:s1');
  });

  test('works layout walks Work fragments first, then the unassigned groups', () => {
    // s2 is older than s1, but its Work fragment is drawn above the UNASSIGNED zone.
    const works = [{
      id: 'W1',
      title: 'Work one',
      status: 'active' as const,
      sessionLinks: [{ sessionId: 's2', linkedAt: SEEN }],
      startedAt: SEEN,
      createdAt: SEEN,
      updatedAt: SEEN,
    }];
    const model = selectWorkFragments({ cards, works });
    const order = selectBoardNavOrder(selectColumns(cards), cards, { groupComplete: true, groupDone: true, works: model });
    expect(order.map((item) => item.id)).toEqual(['todo-1', 's2-only', 's1-new', 's1-old']);
    expect(order.find((item) => item.id === 's2-only')?.groupKey).toBe('session:s2');
  });

  test('list order puts complete ahead of todo', () => {
    const order = selectBoardNavOrder(
      orderColumnsForList(selectColumns(cards)),
      cards,
      { groupComplete: false, groupDone: false },
    );
    expect(order.map((item) => item.id)).toEqual(['s1-new', 's2-only', 's1-old', 'todo-1']);
  });
});

describe('isTypingTarget', () => {
  test('fields and editable content swallow the shortcut; everything else does not', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
