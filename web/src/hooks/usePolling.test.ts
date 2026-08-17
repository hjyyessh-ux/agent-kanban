import { describe, expect, test } from 'bun:test';
import { startPolling } from './usePolling';

describe('startPolling', () => {
  test('runs through the scheduled callback and clears the same timer on cleanup', () => {
    const timerId = setInterval(() => {}, 60_000);
    clearInterval(timerId);
    let scheduledCallback: (() => void) | undefined;
    let scheduledInterval: number | undefined;
    let clearedTimer: ReturnType<typeof setInterval> | undefined;
    let callCount = 0;

    const cleanup = startPolling(
      () => {
        callCount += 1;
      },
      10_000,
      (callback, interval) => {
        scheduledCallback = callback;
        scheduledInterval = interval;
        return timerId;
      },
      (id) => {
        clearedTimer = id;
      },
    );

    expect(scheduledInterval).toBe(10_000);
    scheduledCallback?.();
    expect(callCount).toBe(1);
    cleanup();
    expect(clearedTimer).toBe(timerId);
  });
});
