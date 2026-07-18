import { describe, expect, test } from 'bun:test';
import {
  buildDefaultScheduleInput,
  formatScheduledKstLabel,
  validateScheduleInputKst,
} from './ScheduledDispatchUi';

describe('ScheduledDispatchUi', () => {
  test('formats a UTC schedule as a KST label', () => {
    expect(formatScheduledKstLabel('2026-07-18T00:30:00.000Z')).toBe('2026-07-18 09:30 KST');
  });

  test('rejects invalid and past KST inputs using the shared server validation', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');

    expect(validateScheduleInputKst('not-a-date', now).error).toBe('Invalid KST datetime input: not-a-date');
    expect(validateScheduleInputKst('2026-07-17T08:59', now).error).toBe('scheduledAt must be a future KST datetime');
    expect(validateScheduleInputKst('2026-07-17T09:05', now)).toEqual({
      error: null,
      scheduledAtUtc: '2026-07-17T00:05:00.000Z',
    });
  });

  test('builds a future default KST input', () => {
    const input = buildDefaultScheduleInput(new Date('2026-07-17T00:00:00.000Z'));
    expect(input >= '2026-07-17T09:10').toBe(true);
  });
});
