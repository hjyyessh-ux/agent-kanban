import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../core/types';
import {
  buildTimelineSessions,
  cardExecutionSpan,
  checkTimelineWindow,
  timelineArchiveMonths,
  TIMELINE_MAX_WINDOW_DAYS,
} from '../core/timeline-aggregate';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const WINDOW = {
  from: '2026-08-31T00:00:00.000Z',
  to: '2026-09-06T23:59:59.999Z',
  includeSubagents: false,
  now: NOW,
};

function card(overrides: Partial<KanbanCard> & { id: string }): KanbanCard {
  return {
    title: overrides.id,
    status: 'complete',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    sessionId: 'ses-1',
    ...overrides,
  } as KanbanCard;
}

describe('timelineArchiveMonths', () => {
  const available = ['2026-09', '2026-08', '2026-07', '2026-06', '2025-12'];

  test('reads the window month and every later one, plus one month of slack', () => {
    // A card that ran in August can be archived in September or later, never in
    // July — but the KST/UTC boundary puts an early-August run in 2026-07.
    expect(timelineArchiveMonths(available, '2026-08-15T00:00:00.000Z'))
      .toEqual(['2026-07', '2026-08', '2026-09']);
  });

  test('a window inside the current month reads only two files', () => {
    expect(timelineArchiveMonths(available, '2026-09-02T00:00:00.000Z'))
      .toEqual(['2026-08', '2026-09']);
  });

  test('steps back across a year boundary', () => {
    expect(timelineArchiveMonths(['2025-11', '2025-12', '2026-01'], '2026-01-05T00:00:00.000Z'))
      .toEqual(['2025-12', '2026-01']);
  });

  test('reads nothing for an unparseable window', () => {
    expect(timelineArchiveMonths(available, 'not-a-date')).toEqual([]);
  });
});

describe('cardExecutionSpan', () => {
  test('is null for a card that was only ever planned', () => {
    expect(cardExecutionSpan({})).toBeNull();
    expect(cardExecutionSpan({ startedAt: undefined, completedAt: undefined })).toBeNull();
  });

  test('leaves the end open while the card is running', () => {
    expect(cardExecutionSpan({ startedAt: '2026-09-01T01:00:00.000Z' }))
      .toEqual({ startedAt: '2026-09-01T01:00:00.000Z' });
  });

  test('treats a completion with no recorded start as a single instant', () => {
    // Otherwise a legacy card would draw an open rail to today over work that
    // is demonstrably finished.
    expect(cardExecutionSpan({ completedAt: '2026-09-01T01:00:00.000Z' })).toEqual({
      startedAt: '2026-09-01T01:00:00.000Z',
      completedAt: '2026-09-01T01:00:00.000Z',
    });
  });

  test('reads the two timestamps as min/max rather than trusting their order', () => {
    expect(cardExecutionSpan({
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:00.000Z',
    })).toEqual({
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-02T00:00:00.000Z',
    });
  });

  test('ignores an unparseable timestamp', () => {
    expect(cardExecutionSpan({ startedAt: 'nope', completedAt: '2026-09-01T00:00:00.000Z' }))
      .toEqual({ startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:00.000Z' });
    expect(cardExecutionSpan({ startedAt: 'nope' })).toBeNull();
  });
});

describe('buildTimelineSessions', () => {
  test('drops cards that never executed, however old they are', () => {
    const sessions = buildTimelineSessions([
      card({ id: 'c-todo', status: 'todo', createdAt: '2025-01-01T00:00:00.000Z' }),
    ], WINDOW);
    expect(sessions).toEqual([]);
  });

  test('drops cards with no session — there would be no row to draw them on', () => {
    const sessions = buildTimelineSessions([
      card({ id: 'c-1', sessionId: undefined, startedAt: '2026-09-01T00:00:00.000Z' }),
    ], WINDOW);
    expect(sessions).toEqual([]);
  });

  test('rolls a session up to min start / max end over its cards', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-2',
        startedAt: '2026-09-02T03:00:00.000Z',
        completedAt: '2026-09-02T03:04:00.000Z',
      }),
      card({
        id: 'c-1',
        startedAt: '2026-09-01T09:00:00.000Z',
        completedAt: '2026-09-01T09:03:00.000Z',
      }),
    ], WINDOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(sessions[0]!.endedAt).toBe('2026-09-02T03:04:00.000Z');
    expect(sessions[0]!.cards.map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });

  test('leaves the session open while any of its cards is still running', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-done',
        startedAt: '2026-09-01T09:00:00.000Z',
        completedAt: '2026-09-01T09:03:00.000Z',
      }),
      card({ id: 'c-running', status: 'in_progress', startedAt: '2026-09-04T09:00:00.000Z' }),
    ], WINDOW);
    expect(sessions[0]!.endedAt).toBeUndefined();
  });

  test('keeps a session that started before the window but overlaps it', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-long',
        startedAt: '2026-08-20T00:00:00.000Z',
        completedAt: '2026-09-01T00:00:00.000Z',
      }),
    ], WINDOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  test('keeps a card still running from before the window (its end is now)', () => {
    const sessions = buildTimelineSessions([
      card({ id: 'c-open', status: 'in_progress', startedAt: '2026-07-01T00:00:00.000Z' }),
    ], WINDOW);
    expect(sessions).toHaveLength(1);
  });

  test('drops what finished before the window and what starts after it', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-old',
        sessionId: 'ses-old',
        startedAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-01T00:10:00.000Z',
      }),
      card({
        id: 'c-future',
        sessionId: 'ses-future',
        startedAt: '2026-10-01T00:00:00.000Z',
        completedAt: '2026-10-01T00:10:00.000Z',
      }),
    ], WINDOW);
    expect(sessions).toEqual([]);
  });

  test('hides subagent cards unless asked for, and never lets one carry a session alone', () => {
    const cards = [
      card({
        id: 'c-sub',
        sessionId: 'ses-sub',
        parentCardId: 'c-parent',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:05:00.000Z',
      }),
    ];
    expect(buildTimelineSessions(cards, WINDOW)).toEqual([]);
    const shown = buildTimelineSessions(cards, { ...WINDOW, includeSubagents: true });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.cards[0]!.isSubagent).toBe(true);
  });

  test('ignores deleted cards', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-del',
        deletedAt: '2026-09-03T00:00:00.000Z',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:05:00.000Z',
      }),
    ], WINDOW);
    expect(sessions).toEqual([]);
  });

  test('dedupes a card seen in both the board and an archive month', () => {
    const executed = card({
      id: 'c-dupe',
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:05:00.000Z',
    });
    const sessions = buildTimelineSessions([executed, { ...executed }], WINDOW);
    expect(sessions[0]!.cards).toHaveLength(1);
  });

  test('labels a session from its newest card and orders sessions by start', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-late',
        sessionId: 'ses-a',
        sessionTitle: 'renamed later',
        projectDir: '/w/agent-kanban',
        startedAt: '2026-09-03T00:00:00.000Z',
        completedAt: '2026-09-03T00:05:00.000Z',
      }),
      card({
        id: 'c-early',
        sessionId: 'ses-a',
        sessionTitle: 'first title',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:05:00.000Z',
      }),
      card({
        id: 'c-b',
        sessionId: 'ses-b',
        startedAt: '2026-08-31T12:00:00.000Z',
        completedAt: '2026-08-31T12:05:00.000Z',
      }),
    ], WINDOW);
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses-b', 'ses-a']);
    expect(sessions[1]!.sessionTitle).toBe('renamed later');
    expect(sessions[1]!.projectDir).toBe('/w/agent-kanban');
  });

  test('defaults a legacy card with no runtime to opencode', () => {
    const sessions = buildTimelineSessions([
      card({ id: 'c-legacy', startedAt: '2026-09-01T00:00:00.000Z' }),
    ], WINDOW);
    expect(sessions[0]!.agentRuntime).toBe('opencode');
  });
});

describe('checkTimelineWindow', () => {
  test('accepts a normal grid window', () => {
    const check = checkTimelineWindow(
      '2026-08-31T00:00:00.000Z', '2026-09-06T23:59:59.999Z',
    );
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('expected ok');
    expect(check.from).toBe('2026-08-31T00:00:00.000Z');
  });

  test('names the missing or unparseable end of the window', () => {
    expect(checkTimelineWindow(null, '2026-09-06T00:00:00.000Z'))
      .toEqual({ ok: false, error: 'from must be an ISO 8601 timestamp' });
    expect(checkTimelineWindow('2026-09-01T00:00:00.000Z', 'nope'))
      .toEqual({ ok: false, error: 'to must be an ISO 8601 timestamp' });
  });

  test('rejects a reversed window', () => {
    const check = checkTimelineWindow('2026-09-07T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected a rejection');
    expect(check.error).toContain('precede');
  });

  /**
   * The window is the *only* bound on how much archive the route parses, and it
   * is an unauthenticated GET — `from=1970&to=2030` used to read every archive
   * month on the disk.
   */
  test('refuses a window longer than the cap', () => {
    const check = checkTimelineWindow('1970-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected a rejection');
    expect(check.error).toBe(`window must not exceed ${TIMELINE_MAX_WINDOW_DAYS} days`);
  });

  test('accepts a window exactly at the cap', () => {
    const from = Date.parse('2026-01-01T00:00:00.000Z');
    const to = from + TIMELINE_MAX_WINDOW_DAYS * 86_400_000;
    expect(checkTimelineWindow(new Date(from).toISOString(), new Date(to).toISOString()).ok)
      .toBe(true);
    expect(checkTimelineWindow(new Date(from).toISOString(), new Date(to + 1).toISOString()).ok)
      .toBe(false);
  });
});

describe('sessions that reach back past the window', () => {
  test('flags a session whose earlier cards the window dropped', () => {
    const sessions = buildTimelineSessions([
      // Ran and finished a week before the window — excluded from `cards`.
      card({
        id: 'c-early',
        sessionId: 'ses-long',
        startedAt: '2026-08-24T01:00:00.000Z',
        completedAt: '2026-08-24T02:00:00.000Z',
      }),
      card({
        id: 'c-inside',
        sessionId: 'ses-long',
        startedAt: '2026-09-01T01:00:00.000Z',
        completedAt: '2026-09-01T02:00:00.000Z',
      }),
    ], WINDOW);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cards.map((c) => c.id)).toEqual(['c-inside']);
    // min() over what arrived is 9/1, so without the flag the rail would draw a
    // closed left edge over a session that had been running for a week.
    expect(sessions[0]!.startedAt).toBe('2026-09-01T01:00:00.000Z');
    expect(sessions[0]!.truncatedBefore).toBe(true);
  });

  test('leaves a session that really started inside the window unflagged', () => {
    const sessions = buildTimelineSessions([
      card({
        id: 'c-only',
        sessionId: 'ses-short',
        startedAt: '2026-09-01T01:00:00.000Z',
        completedAt: '2026-09-01T02:00:00.000Z',
      }),
    ], WINDOW);
    expect(sessions[0]!.truncatedBefore).toBeUndefined();
  });

  test('does not double-signal a session already clipped by its own startedAt', () => {
    const sessions = buildTimelineSessions([
      // Overlaps the window (still running at `from`), so it is included and
      // its own `startedAt` already sits before the window — the client's
      // `columnOf` clips it without help.
      card({
        id: 'c-spanning',
        sessionId: 'ses-span',
        startedAt: '2026-08-28T01:00:00.000Z',
        completedAt: '2026-09-01T02:00:00.000Z',
      }),
      card({
        id: 'c-older',
        sessionId: 'ses-span',
        startedAt: '2026-08-20T01:00:00.000Z',
        completedAt: '2026-08-20T02:00:00.000Z',
      }),
    ], WINDOW);
    expect(sessions[0]!.startedAt).toBe('2026-08-28T01:00:00.000Z');
    expect(sessions[0]!.truncatedBefore).toBeUndefined();
  });

  test('a still-running card is never treated as having ended before the window', () => {
    const sessions = buildTimelineSessions([
      card({ id: 'c-open', sessionId: 'ses-open', startedAt: '2026-08-20T01:00:00.000Z' }),
    ], WINDOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAt).toBeUndefined();
    expect(sessions[0]!.truncatedBefore).toBeUndefined();
  });
});
