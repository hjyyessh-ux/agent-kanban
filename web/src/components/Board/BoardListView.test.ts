import { describe, expect, test } from 'bun:test';
import type { V2ColumnViewModel } from './board-selectors';
import { orderColumnsForList } from './BoardListView';

function makeColumn(status: V2ColumnViewModel['status']): V2ColumnViewModel {
  return {
    status,
    label: status,
    cards: [],
    count: 0,
  };
}

describe('BoardListView', () => {
  test('orders list sections as done -> complete -> in_progress -> todo', () => {
    const input: V2ColumnViewModel[] = [
      makeColumn('todo'),
      makeColumn('in_progress'),
      makeColumn('complete'),
      makeColumn('done'),
    ];

    const ordered = orderColumnsForList(input);

    expect(ordered.map((column) => column.status)).toEqual([
      'done',
      'complete',
      'in_progress',
      'todo',
    ]);
  });
});
