import { describe, test, expect, afterEach } from 'bun:test';
import { trackDispatch, isDispatched, clearDispatch, matchesDispatchedPrompt, _testing } from '../plugin/hooks/dispatch-tracker';

const { dispatchMap, TTL_MS } = _testing;

afterEach(() => {
  dispatchMap.clear();
});

describe('dispatch-tracker', () => {
  test('trackDispatch registers sessionId → cardId', () => {
    trackDispatch('ses-1', 'card-1', 'prompt');
    expect(isDispatched('ses-1')).toBe('card-1');
  });

  test('isDispatched returns undefined for unknown session', () => {
    expect(isDispatched('ses-unknown')).toBeUndefined();
  });

  test('isDispatched does NOT consume entry (can be called multiple times)', () => {
    trackDispatch('ses-1', 'card-1', 'prompt');
    expect(isDispatched('ses-1')).toBe('card-1');
    expect(isDispatched('ses-1')).toBe('card-1');
    expect(isDispatched('ses-1')).toBe('card-1');
  });

  test('clearDispatch removes entry', () => {
    trackDispatch('ses-1', 'card-1', 'prompt');
    clearDispatch('ses-1');
    expect(isDispatched('ses-1')).toBeUndefined();
  });

  test('clearDispatch is safe for non-existent session', () => {
    clearDispatch('ses-nonexistent'); // should not throw
    expect(isDispatched('ses-nonexistent')).toBeUndefined();
  });

  test('multiple sessions tracked independently', () => {
    trackDispatch('ses-1', 'card-1', 'prompt-1');
    trackDispatch('ses-2', 'card-2', 'prompt-2');
    trackDispatch('ses-3', 'card-3', 'prompt-3');
    expect(isDispatched('ses-1')).toBe('card-1');
    expect(isDispatched('ses-2')).toBe('card-2');
    expect(isDispatched('ses-3')).toBe('card-3');
  });

  test('expired entries are cleaned up on trackDispatch', () => {
    // Manually insert an expired entry
    dispatchMap.set('ses-old', { cardId: 'card-old', promptText: 'old', timestamp: Date.now() - TTL_MS - 1000 });
    expect(dispatchMap.has('ses-old')).toBe(true);

    // trackDispatch triggers cleanup
    trackDispatch('ses-new', 'card-new', 'new');
    expect(dispatchMap.has('ses-old')).toBe(false);
    expect(isDispatched('ses-new')).toBe('card-new');
  });

  test('expired entries are cleaned up on isDispatched', () => {
    dispatchMap.set('ses-old', { cardId: 'card-old', promptText: 'old', timestamp: Date.now() - TTL_MS - 1000 });
    expect(isDispatched('ses-old')).toBeUndefined();
  });

  test('non-expired entries survive cleanup', () => {
    trackDispatch('ses-recent', 'card-recent', 'recent');
    // Manually add expired entry
    dispatchMap.set('ses-old', { cardId: 'card-old', promptText: 'old', timestamp: Date.now() - TTL_MS - 1000 });

    // Trigger cleanup via isDispatched
    expect(isDispatched('ses-recent')).toBe('card-recent');
    expect(dispatchMap.has('ses-old')).toBe(false);
    expect(dispatchMap.has('ses-recent')).toBe(true);
  });

  test('matchesDispatchedPrompt only matches identical prompt text', () => {
    trackDispatch('ses-1', 'card-1', 'Original prompt');

    expect(matchesDispatchedPrompt('ses-1', 'Original prompt')).toBe('card-1');
    expect(matchesDispatchedPrompt('ses-1', 'Different prompt')).toBeUndefined();
    expect(matchesDispatchedPrompt('ses-unknown', 'Original prompt')).toBeUndefined();
  });
});
