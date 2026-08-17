import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { selectColumns } from './board-selectors';

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'todo',
    agentRuntime: 'claude',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function getTodoCard(cards: KanbanCard[], id: string) {
  const cols = selectColumns(cards);
  return cols.find((c) => c.status === 'todo')!.cards.find((vm) => vm.id === id)!;
}

describe('selectColumns — nested child tree', () => {
  test('single-runtime card has empty nestedChildren and no children', () => {
    const card = makeCard('standalone');
    const vm = getTodoCard([card], 'standalone');
    expect(vm.nestedChildren).toHaveLength(0);
    expect(vm.hasChildren).toBe(false);
    expect(vm.workerChildCount).toBe(0);
  });

  test('nested child populates nestedChildren on parent', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const vm = getTodoCard([parent, child], 'p1');
    expect(vm.nestedChildren).toHaveLength(1);
    expect(vm.nestedChildren[0].id).toBe('c1');
    expect(vm.nestedChildren[0].status).toBe('in_progress');
    expect(vm.nestedChildren[0].linkKind).toBe('nested');
  });

  test('nested child does not appear as a column-level card', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'todo' });
    const allIds = selectColumns([parent, child]).flatMap((c) => c.cards.map((vm) => vm.id));
    expect(allIds).toContain('p1');
    expect(allIds).not.toContain('c1');
  });

  test('child counts are accurate across statuses', () => {
    const parent = makeCard('p1');
    const c1 = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const c2 = makeCard('c2', { parentCardId: 'p1', linkKind: 'nested', status: 'complete' });
    const c3 = makeCard('c3', { parentCardId: 'p1', linkKind: 'nested', status: 'todo' });
    const vm = getTodoCard([parent, c1, c2, c3], 'p1');
    expect(vm.childCount).toBe(3);
    expect(vm.childInProgressCount).toBe(1);
    expect(vm.childDoneCount).toBe(1);
    expect(vm.childTodoCount).toBe(1);
    expect(vm.nestedChildren).toHaveLength(3);
  });

  test('worker child increments workerChildCount but not nestedChildren', () => {
    const parent = makeCard('p1');
    const worker = makeCard('w1', { parentCardId: 'p1', linkKind: 'worker', status: 'in_progress' });
    const vm = getTodoCard([parent, worker], 'p1');
    expect(vm.workerChildCount).toBe(1);
    expect(vm.nestedChildren).toHaveLength(0);
    expect(vm.childCount).toBe(1);
  });

  test('mixed nested+worker children are correctly split', () => {
    const parent = makeCard('p1');
    const nested = makeCard('n1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const worker = makeCard('w1', { parentCardId: 'p1', linkKind: 'worker', status: 'todo' });
    const vm = getTodoCard([parent, nested, worker], 'p1');
    expect(vm.nestedChildren).toHaveLength(1);
    expect(vm.nestedChildren[0].id).toBe('n1');
    expect(vm.workerChildCount).toBe(1);
    expect(vm.childCount).toBe(2);
  });

  test('derives scheduled fields for scheduled todo cards in KST', () => {
    const vm = getTodoCard([
      makeCard('scheduled', {
        scheduledDispatch: {
          scheduledAt: '2026-07-18T00:30:00.000Z',
          status: 'scheduled',
          updatedAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    ], 'scheduled');

    expect(vm.hasScheduledBadge).toBe(true);
    expect(vm.scheduledStatus).toBe('scheduled');
    expect(vm.scheduledAtLabel).toBe('2026-07-18 09:30 KST');
    expect(vm.scheduledBadgeLabel).toBe('예약됨 · 2026-07-18 09:30 KST');
  });

  test('preserves Quick Action execution provenance for board and list renderers', () => {
    const vm = getTodoCard([
      makeCard('quick-action', {
        originChannel: 'quick_action',
        executionKind: 'script',
        quickActionId: 'qa-1',
        scriptName: 'Deploy service',
      }),
    ], 'quick-action');

    expect(vm).toMatchObject({
      originChannel: 'quick_action',
      executionKind: 'script',
      quickActionId: 'qa-1',
      scriptName: 'Deploy service',
    });
  });
});
