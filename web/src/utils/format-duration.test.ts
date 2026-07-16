import { describe, expect, test } from 'bun:test';
import { formatRelativeTime } from './format-duration';

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-16T12:00:00.000Z').getTime();

  test('uses compact relative labels for recent activity', () => {
    expect(formatRelativeTime('2026-07-16T11:59:45.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-16T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeTime('2026-07-16T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-13T12:00:00.000Z', now)).toBe('3d ago');
  });
});
