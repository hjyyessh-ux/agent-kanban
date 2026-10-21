import { describe, expect, test } from 'bun:test';
import { buildCapabilityAlerts } from './capability-errors';

describe('buildCapabilityAlerts', () => {
  test('no errors → no alerts (an empty list is a real empty list)', () => {
    expect(buildCapabilityAlerts([
      { key: 'skills', error: null },
      { key: 'scripts', error: undefined },
      { key: 'skillRoots', error: '  ' },
    ])).toEqual([]);
  });

  test('each failing source becomes its own alert, in order', () => {
    const alerts = buildCapabilityAlerts([
      { key: 'skills', error: 'Failed to sync skills' },
      { key: 'scripts', error: null },
      { key: 'skillRoots', error: 'HTTP 500' },
    ]);
    expect(alerts.map((a) => a.key)).toEqual(['skills', 'skillRoots']);
    expect(alerts[0]?.message).toBe('Failed to sync skills');
    expect(alerts[0]?.title).toContain('Skill');
    expect(alerts[1]?.title).toContain('디렉토리');
  });
});
