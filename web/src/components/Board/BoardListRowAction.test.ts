import { describe, expect, test, mock } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { getRowActionConfig } from './BoardListRowAction';
import { CARD_ACTION_COPY } from '../../constants/copy';

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
  test('maps todo to start and calls dispatch', () => {
    const card = makeCard({ status: 'todo' });
    const onDispatch = mock(() => undefined);

    const config = getRowActionConfig(card, undefined, onDispatch);

    expect(config?.kind).toBe('start');
    expect(config?.label).toBe(CARD_ACTION_COPY.start);
    config?.run?.();
    expect(onDispatch).toHaveBeenCalledWith(card);
  });

  test('maps a scheduled todo to start-now', () => {
    const card = makeCard({
      status: 'todo',
      scheduledDispatch: {
        scheduledAt: '2026-04-16T00:00:00.000Z',
        status: 'scheduled',
        updatedAt: '2026-04-15T00:00:00.000Z',
      },
    });

    expect(getRowActionConfig(card)?.label).toBe(CARD_ACTION_COPY.startNow);
  });

  // The List used to offer REOPEN here while BoardCard and Card detail
  // finished the run — all three now share `primaryActionFor`.
  test('maps in_progress to finish and moves to complete', () => {
    const card = makeCard({ status: 'in_progress' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.kind).toBe('finish');
    expect(config?.label).toBe(CARD_ACTION_COPY.finish);
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'complete');
  });

  test('maps complete to done and moves to done', () => {
    const card = makeCard({ status: 'complete' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.kind).toBe('done');
    expect(config?.label).toBe(CARD_ACTION_COPY.done);
    expect(config?.label).not.toBe(CARD_ACTION_COPY.finish);
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'done');
  });

  test('maps done to reopen and moves to todo', () => {
    const card = makeCard({ status: 'done' });
    const onStatusChange = mock(() => undefined);

    const config = getRowActionConfig(card, onStatusChange);

    expect(config?.kind).toBe('reopen');
    expect(config?.label).toBe(CARD_ACTION_COPY.reopen);
    config?.run?.();
    expect(onStatusChange).toHaveBeenCalledWith(card, 'todo');
  });

  test('returns null for child cards', () => {
    const card = makeCard({ parentCardId: 'parent-1' });

    const config = getRowActionConfig(card);

    expect(config).toBeNull();
  });
});
