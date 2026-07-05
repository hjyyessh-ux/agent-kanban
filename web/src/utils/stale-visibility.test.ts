import { describe, test, expect } from 'bun:test';
import { shouldShowStaleStatus, staleCardVisualState } from './stale-visibility';

describe('stale-visibility', () => {
  test('shows stale state for in_progress cards only', () => {
    expect(shouldShowStaleStatus({
      status: 'in_progress',
      staleStatus: 'orphan',
      staleDetectedAt: new Date().toISOString(),
    })).toBe(true);

    expect(shouldShowStaleStatus({
      status: 'complete',
      staleStatus: 'orphan',
      staleDetectedAt: new Date().toISOString(),
    })).toBe(false);

    expect(shouldShowStaleStatus({
      status: 'done',
      staleStatus: 'stuck',
      staleDetectedAt: new Date().toISOString(),
    })).toBe(false);
  });

  test('returns no visual stale state outside in_progress', () => {
    expect(staleCardVisualState({
      status: 'complete',
      staleStatus: 'orphan',
      staleDetectedAt: new Date().toISOString(),
    })).toBeNull();

    expect(staleCardVisualState({
      status: 'done',
      staleStatus: 'stuck',
      staleDetectedAt: new Date().toISOString(),
    })).toBeNull();
  });
});
