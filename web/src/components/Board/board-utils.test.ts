import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { groupCardsByParent, sortCardsForColumn } from './board-utils';

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'todo',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('groupCardsByParent — linkKind filtering', () => {
  test('nested child is not a top-level card', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested' });
    const result = groupCardsByParent([parent, child]);
    expect(result.map((c) => c.id)).toEqual(['p1']);
  });

  test('nested child is attached to parent.childCards', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested' });
    const result = groupCardsByParent([parent, child]);
    expect(result[0].childCards?.map((c) => c.id)).toEqual(['c1']);
  });

  test('worker child is excluded from top-level and attached to parent', () => {
    const parent = makeCard('p1');
    const worker = makeCard('w1', { parentCardId: 'p1', linkKind: 'worker' });
    const result = groupCardsByParent([parent, worker]);
    expect(result.map((c) => c.id)).toEqual(['p1']);
    expect(result[0].childCards?.map((c) => c.id)).toEqual(['w1']);
  });

  test('orphaned nested child (parent not in view) is silently omitted', () => {
    const child = makeCard('c1', { parentCardId: 'missing', linkKind: 'nested' });
    const result = groupCardsByParent([child]);
    expect(result).toHaveLength(0);
  });

  test('card without linkKind is a top-level card', () => {
    const card = makeCard('standalone');
    const result = groupCardsByParent([card]);
    expect(result.map((c) => c.id)).toEqual(['standalone']);
    expect(result[0].childCards).toBeUndefined();
  });

  test('multiple nested children all attached to parent', () => {
    const parent = makeCard('p1');
    const c1 = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested' });
    const c2 = makeCard('c2', { parentCardId: 'p1', linkKind: 'nested' });
    const result = groupCardsByParent([parent, c1, c2]);
    expect(result).toHaveLength(1);
    expect(result[0].childCards?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('sortCardsForColumn — todo column manual ordering', () => {
  test('with no todoOrder set, falls back to newest-first by createdAt', () => {
    const a = makeCard('a', { createdAt: '2026-06-01T00:00:00.000Z' });
    const b = makeCard('b', { createdAt: '2026-06-02T00:00:00.000Z' });
    const result = sortCardsForColumn('todo', [a, b]);
    expect(result.map((c) => c.id)).toEqual(['b', 'a']);
  });

  test('cards with todoOrder sort ascending by it, regardless of createdAt', () => {
    const a = makeCard('a', { createdAt: '2026-06-02T00:00:00.000Z', todoOrder: 2 });
    const b = makeCard('b', { createdAt: '2026-06-01T00:00:00.000Z', todoOrder: 1 });
    const result = sortCardsForColumn('todo', [a, b]);
    expect(result.map((c) => c.id)).toEqual(['b', 'a']);
  });

  test('a freshly created (unordered) card lands on top, above manually-ordered cards', () => {
    const dragged = makeCard('dragged', { createdAt: '2026-06-01T00:00:00.000Z', todoOrder: 1 });
    const freshlyCreated = makeCard('fresh', { createdAt: '2026-06-03T00:00:00.000Z' });
    const result = sortCardsForColumn('todo', [dragged, freshlyCreated]);
    expect(result.map((c) => c.id)).toEqual(['fresh', 'dragged']);
  });
});
