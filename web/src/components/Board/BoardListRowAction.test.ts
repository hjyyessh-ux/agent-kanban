import { describe, expect, test, mock } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { getRowActionConfig } from './BoardListRowAction';

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'card-1',
    title: 'Test card',
    description: 'desc',
    status: 'todo',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('BoardListRowAction', () => {
  test('maps todo to START and calls dispatch', () => {
    const card = makeCard({ status: 'todo' });
    const onDispatch = mock(() => undefined);

    const config = getRowActionConfig(card, undefined, onDispatch);

    expect(config?.label).toBe('START');
    config?.run?.();
    expect(onDispatch).toHaveBeenCalledWith(card);
  });

  test('maps in_progress to REOPEN and moves to todo', () => {
    const card = makeCard({ status: 'in_progress' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.label).toBe('REOPEN');
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'todo');
  });

  test('maps complete to DONE and moves to done', () => {
    const card = makeCard({ status: 'complete' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.label).toBe('DONE');
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'done');
  });

  test('maps done to REOPEN and moves to todo', () => {
    const card = makeCard({ status: 'done' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.label).toBe('REOPEN');
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'todo');
  });

  test('returns null for child cards', () => {
    const card = makeCard({ parentCardId: 'parent-1' });

    const config = getRowActionConfig(card);

    expect(config).toBeNull();
  });
});
