import { describe, expect, test } from 'bun:test';
import { resolveModalTabTarget, shouldCloseModalOnKey } from './useModalAccessibility';

describe('useModalAccessibility helpers', () => {
  test('treats Escape as a close key', () => {
    expect(shouldCloseModalOnKey('Escape')).toBe(true);
    expect(shouldCloseModalOnKey('Enter')).toBe(false);
  });

  test('wraps tab focus within the modal container', () => {
    const container = { id: 'container' };
    const first = { id: 'first' };
    const second = { id: 'second' };

    expect(resolveModalTabTarget(second, [first, second], container, false)).toBe(first);
    expect(resolveModalTabTarget(first, [first, second], container, true)).toBe(second);
    expect(resolveModalTabTarget(container, [first, second], container, true)).toBe(second);
    expect(resolveModalTabTarget(first, [first, second], container, false)).toBeNull();
  });
});
