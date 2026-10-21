import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../src/core/types';
import { replaceCards, selectArchivableCards, selectCompletableCards } from './useKanbanBoard';

function makeCard(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    id: overrides.id ?? 'card-1',
    title: 'Card title',
    description: 'Card description',
    status: 'todo',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectCompletableCards', () => {
  test('skips favorite cards in complete', () => {
    const result = selectCompletableCards([
      makeCard({ id: 'protected', status: 'complete', favorite: true }),
      makeCard({ id: 'eligible', status: 'complete', favorite: false }),
      makeCard({ id: 'other-status', status: 'done', favorite: false }),
    ]);

    expect(result.map((card) => card.id)).toEqual(['eligible']);
  });

  test('treats undefined favorite as completable', () => {
    const result = selectCompletableCards([
      makeCard({ id: 'default-false', status: 'complete' }),
    ]);

    expect(result.map((card) => card.id)).toEqual(['default-false']);
  });
});

describe('selectArchivableCards', () => {
  test('skips favorite cards in done', () => {
    const result = selectArchivableCards([
      makeCard({ id: 'protected-done', status: 'done', favorite: true }),
      makeCard({ id: 'eligible-done', status: 'done', favorite: false }),
      makeCard({ id: 'other-status', status: 'complete', favorite: false }),
    ]);

    expect(result.map((card) => card.id)).toEqual(['eligible-done']);
  });

  test('includes direct done children of selected non-favorite parents only', () => {
    const result = selectArchivableCards([
      makeCard({ id: 'parent', status: 'done', favorite: false }),
      makeCard({ id: 'child', status: 'done', parentCardId: 'parent', favorite: true }),
      makeCard({ id: 'grandchild', status: 'done', parentCardId: 'child', favorite: false }),
      makeCard({ id: 'unrelated-child', status: 'done', parentCardId: 'other-parent', favorite: false }),
      makeCard({ id: 'favorite-parent', status: 'done', favorite: true }),
      makeCard({ id: 'favorite-parent-child', status: 'done', parentCardId: 'favorite-parent', favorite: false }),
    ]);

    expect(result.map((card) => card.id)).toEqual(['parent', 'child']);
  });

  test('treats undefined favorite as archivable', () => {
    const result = selectArchivableCards([
      makeCard({ id: 'default-false', status: 'done' }),
    ]);

    expect(result.map((card) => card.id)).toEqual(['default-false']);
  });
});

describe('replaceCards', () => {
  test('swaps in updated copies by id and keeps board order', () => {
    const cards = [
      makeCard({ id: 'a', status: 'complete' }),
      makeCard({ id: 'b', status: 'complete' }),
      makeCard({ id: 'c', status: 'todo' }),
    ];
    const seenB = makeCard({ id: 'b', status: 'complete', completedSeenAt: '2026-10-19T00:00:00.000Z' });
    const seenA = makeCard({ id: 'a', status: 'complete', completedSeenAt: '2026-10-19T00:00:00.000Z' });

    const result = replaceCards(cards, [seenB, seenA]);

    expect(result.map((card) => card.id)).toEqual(['a', 'b', 'c']);
    expect(result[0]).toBe(seenA);
    expect(result[1]).toBe(seenB);
    expect(result[2]).toBe(cards[2]);
  });

  test('does not resurrect a card the poll already dropped', () => {
    const cards = [makeCard({ id: 'a' })];
    const result = replaceCards(cards, [makeCard({ id: 'gone' })]);
    expect(result.map((card) => card.id)).toEqual(['a']);
  });

  test('returns the same array for an empty batch', () => {
    const cards = [makeCard({ id: 'a' })];
    expect(replaceCards(cards, [])).toBe(cards);
  });
});
