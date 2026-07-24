import { describe, expect, test } from 'bun:test';
import {
  formatUtcIsoToKstInput,
  inferSchedulerScheduleInput,
  isValidFiveFieldCron,
  normalizeScheduledDispatchState,
  normalizeSchedulerEntry,
  parseKstDateTimeInputToUtcIso,
  resolveSchedulerScheduleInput,
  SCHEDULER_TIMEZONE,
} from '../core/scheduling';

describe('KST scheduling helpers', () => {
  test('converts KST input to stored UTC ISO and back', () => {
    const utc = parseKstDateTimeInputToUtcIso('2026-07-18T09:30');
    expect(utc).toBe('2026-07-18T00:30:00.000Z');
    expect(formatUtcIsoToKstInput(utc)).toBe('2026-07-18T09:30');
  });

  test('normalizes scheduled dispatch audit timestamps as UTC ISO', () => {
    const normalized = normalizeScheduledDispatchState({
      scheduledAt: '2026-07-18T00:30:00Z',
      status: 'failed',
      dispatchedAt: '2026-07-18T00:31:00Z',
      error: 'dispatch rejected',
      updatedAt: '2026-07-18T00:31:00Z',
    });

    expect(normalized).toEqual({
      scheduledAt: '2026-07-18T00:30:00.000Z',
      status: 'failed',
      dispatchedAt: '2026-07-18T00:31:00.000Z',
      error: 'dispatch rejected',
      updatedAt: '2026-07-18T00:31:00.000Z',
    });
  });
});

describe('scheduler normalization', () => {
  test('resolves quick schedule presets and direct cron input', () => {
    expect(resolveSchedulerScheduleInput({
      mode: 'simple',
      simple: { repeat: 'minutes', interval: 5 },
    })).toMatchObject({
      cron: '*/5 * * * *',
      cronDescription: '매 5분마다',
    });

    expect(resolveSchedulerScheduleInput({
      mode: 'simple',
      simple: { repeat: 'daily', hour: 9, minute: 30 },
    })).toMatchObject({
      cron: '30 9 * * *',
      cronDescription: '매일 09:30',
    });

    expect(resolveSchedulerScheduleInput({
      mode: 'simple',
      simple: { repeat: 'weekdays', hour: 9, minute: 0 },
    })).toMatchObject({
      cron: '0 9 * * 1-5',
      cronDescription: '평일 09:00',
    });

    expect(resolveSchedulerScheduleInput({
      mode: 'simple',
      simple: { repeat: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 },
    })).toMatchObject({
      cron: '0 9 * * 1',
      cronDescription: '월요일 09:00',
    });

    expect(resolveSchedulerScheduleInput({
      mode: 'cron',
      expression: '15 11 * * 2',
    })).toMatchObject({
      cron: '15 11 * * 2',
      cronDescription: '15 11 * * 2',
    });

    expect(() => resolveSchedulerScheduleInput({
      mode: 'cron',
      expression: '매일 09:30',
    })).toThrow('Cron 직접 입력은 5개 필드');
  });

  test('restores simple mode from existing cron when metadata is missing', () => {
    expect(inferSchedulerScheduleInput('*/5 * * * *')).toEqual({
      mode: 'simple',
      simple: { repeat: 'minutes', interval: 5 },
    });
    expect(inferSchedulerScheduleInput('0 9 * * 1-5')).toEqual({
      mode: 'simple',
      simple: { repeat: 'weekdays', hour: 9, minute: 0 },
    });
    expect(inferSchedulerScheduleInput('15 11 1 * *')).toEqual({
      mode: 'cron',
      expression: '15 11 1 * *',
    });
  });

  test('scheduler cron validation stays 5-field only', () => {
    expect(isValidFiveFieldCron('*/5 * * * *')).toBe(true);
    expect(isValidFiveFieldCron('0 9 * * 1-5')).toBe(true);
    expect(isValidFiveFieldCron('0 9 * * * *')).toBe(false);
  });

  test('migrates legacy shell actions to bash and fixes timezone to KST', () => {
    const entry = normalizeSchedulerEntry({
      id: 'scheduler-1',
      name: 'Legacy shell',
      description: 'runs a shell command',
      cron: '0 9 * * *',
      timezone: 'UTC',
      status: 'active',
      action: { type: 'shell', command: 'echo hello', cwd: '/tmp' },
      history: [],
      createdAt: '2026-07-17T00:00:00Z',
      updatedAt: '2026-07-17T00:00:00Z',
    });

    expect(entry?.timezone).toBe(SCHEDULER_TIMEZONE);
    expect(entry?.status).toBe('active');
    expect(entry?.action).toMatchObject({
      type: 'bash',
      command: 'echo hello',
      cwd: '/tmp',
      editState: 'ready',
    });
    expect(entry?.scheduleInput).toEqual({
      mode: 'simple',
      simple: { repeat: 'daily', hour: 9, minute: 0 },
    });
  });

  test('migrates legacy skill actions to inactive prompt actions marked edit-required', () => {
    const entry = normalizeSchedulerEntry({
      id: 'scheduler-2',
      name: 'Legacy skill',
      description: 'used to invoke a skill',
      cron: '0 9 * * *',
      timezone: 'America/Los_Angeles',
      status: 'active',
      action: { type: 'skill', skillName: 'daily-sync', skillInput: '{"team":"core"}' },
      history: [],
      createdAt: '2026-07-17T00:00:00Z',
      updatedAt: '2026-07-17T00:00:00Z',
    });

    expect(entry?.timezone).toBe(SCHEDULER_TIMEZONE);
    expect(entry?.status).toBe('inactive');
    expect(entry?.action).toMatchObject({
      type: 'prompt',
      prompt: '',
      editState: 'edit-required',
      legacy: {
        type: 'skill',
        skillName: 'daily-sync',
        skillInput: '{"team":"core"}',
      },
    });
    expect(entry?.scheduleInput).toEqual({
      mode: 'simple',
      simple: { repeat: 'daily', hour: 9, minute: 0 },
    });
  });
});
