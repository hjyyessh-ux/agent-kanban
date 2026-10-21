import { describe, expect, test } from 'bun:test';
import { formatElapsedKo, formatRelativeTime, resolveRunDurationMs } from './format-duration';

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-16T12:00:00.000Z').getTime();

  test('uses compact relative labels for recent activity', () => {
    expect(formatRelativeTime('2026-07-16T11:59:45.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-16T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeTime('2026-07-16T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-13T12:00:00.000Z', now)).toBe('3d ago');
  });
});

describe('formatElapsedKo', () => {
  test('always carries seconds so a ticking clock never looks frozen', () => {
    expect(formatElapsedKo(34_000)).toBe('34초');
    expect(formatElapsedKo((12 * 60 + 34) * 1000 + 999)).toBe('12분 34초');
    expect(formatElapsedKo(12 * 60_000)).toBe('12분 0초');
    expect(formatElapsedKo((3600 + 2 * 60 + 5) * 1000)).toBe('1시간 2분 5초');
  });

  test('clamps clock skew to zero and rejects non-finite input', () => {
    expect(formatElapsedKo(-5_000)).toBe('0초');
    expect(formatElapsedKo(Number.NaN)).toBe('');
  });
});

describe('resolveRunDurationMs', () => {
  test('prefers the recorded durationMs', () => {
    expect(resolveRunDurationMs({
      durationMs: 1_000,
      startedAt: '2026-07-16T11:00:00.000Z',
      completedAt: '2026-07-16T12:00:00.000Z',
    })).toBe(1_000);
  });

  test('falls back to completedAt − startedAt', () => {
    expect(resolveRunDurationMs({
      startedAt: '2026-07-16T11:42:00.000Z',
      completedAt: '2026-07-16T12:00:00.000Z',
    })).toBe(18 * 60_000);
  });

  test('is null when the span is unknown or negative', () => {
    expect(resolveRunDurationMs({ startedAt: '2026-07-16T11:00:00.000Z' })).toBeNull();
    expect(resolveRunDurationMs({
      startedAt: '2026-07-16T12:00:00.000Z',
      completedAt: '2026-07-16T11:00:00.000Z',
    })).toBeNull();
  });
});
