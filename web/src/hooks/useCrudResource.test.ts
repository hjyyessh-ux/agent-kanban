import { describe, expect, test } from 'bun:test';
import { crudReducer, type CrudState } from './useCrudResource';

interface Entry {
  id: string;
  label: string;
}

describe('crudReducer', () => {
  test('loads, creates, updates, and deletes entries without mutating prior state', () => {
    const initial: CrudState<Entry, string> = { entries: [], loading: true, error: 'old' };
    const loaded = crudReducer(initial, {
      type: 'LOAD',
      entries: [{ id: 'one', label: 'One' }],
    });
    const created = crudReducer(loaded, {
      type: 'CREATE',
      entry: { id: 'two', label: 'Two' },
    });
    const updated = crudReducer(created, {
      type: 'UPDATE',
      entry: { id: 'one', label: 'Updated' },
    });
    const removed = crudReducer(updated, { type: 'DELETE', id: 'two' });

    expect(initial).toEqual({ entries: [], loading: true, error: 'old' });
    expect(loaded).toEqual({
      entries: [{ id: 'one', label: 'One' }],
      loading: false,
      error: null,
    });
    expect(created.entries.map((entry) => entry.id)).toEqual(['one', 'two']);
    expect(updated.entries[0]?.label).toBe('Updated');
    expect(removed.entries).toEqual([{ id: 'one', label: 'Updated' }]);
  });

  test('sets and clears errors while ending the loading state', () => {
    const initial: CrudState<Entry, string> = { entries: [], loading: true, error: null };
    const failed = crudReducer(initial, { type: 'SET_ERROR', error: 'offline' });
    const cleared = crudReducer(failed, { type: 'CLEAR_ERROR' });

    expect(failed).toEqual({ entries: [], loading: false, error: 'offline' });
    expect(cleared).toEqual({ entries: [], loading: false, error: null });
  });
});
