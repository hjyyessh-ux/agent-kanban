import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { filterUnreadOnly } from './board-filters';

const COMPLETED = '2026-10-18T10:00:00.000Z';
const SEEN = '2026-10-18T11:00:00.000Z';

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'complete',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: COMPLETED,
    completedAt: COMPLETED,
    ...overrides,
  };
}

const unread = (id: string, overrides: Partial<KanbanCard> = {}) => makeCard(id, overrides);
const read = (id: string, overrides: Partial<KanbanCard> = {}) => makeCard(id, { completedSeenAt: SEEN, ...overrides });

describe('filterUnreadOnly', () => {
  test('flat columns keep only unread completions', () => {
    const cards = [
      unread('u1'),
      read('r1'),
      makeCard('todo', { status: 'todo', completedAt: undefined }),
      makeCard('done', { status: 'done' }),
    ];

    expect(filterUnreadOnly(cards, { groupBySession: false }).map((card) => card.id)).toEqual(['u1']);
  });

  test('session grouping keeps every complete card of a session that has an unread turn', () => {
    const cards = [
      unread('s1-new', { sessionId: 's1' }),
      read('s1-old', { sessionId: 's1' }),
      makeCard('s1-done', { sessionId: 's1', status: 'done' }),
      read('s2-only', { sessionId: 's2' }),
      unread('loose'),
    ];

    expect(filterUnreadOnly(cards, { groupBySession: true }).map((card) => card.id))
      .toEqual(['s1-new', 's1-old', 'loose']);
    // Without grouping the read turn of the same session drops out.
    expect(filterUnreadOnly(cards, { groupBySession: false }).map((card) => card.id))
      .toEqual(['s1-new', 'loose']);
  });

  test('children of a kept card stay with their parent', () => {
    const cards = [
      unread('parent'),
      makeCard('child', { status: 'in_progress', parentCardId: 'parent', linkKind: 'subagent' }),
      read('other-parent'),
      makeCard('other-child', { status: 'in_progress', parentCardId: 'other-parent', linkKind: 'subagent' }),
    ];

    expect(filterUnreadOnly(cards, { groupBySession: false }).map((card) => card.id))
      .toEqual(['parent', 'child']);
  });

  test('nothing unread leaves an empty board', () => {
    expect(filterUnreadOnly([read('a'), read('b')], { groupBySession: true })).toEqual([]);
  });
});
