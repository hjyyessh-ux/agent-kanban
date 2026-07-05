import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { groupCardsByParent } from './board-utils';

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
