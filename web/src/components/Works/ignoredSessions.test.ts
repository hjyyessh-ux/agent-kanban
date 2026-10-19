import { describe, expect, test } from 'bun:test';
import type { WorkIgnoredSession, WorkInboxSession } from '../../../../src/core/types';
import {
  IGNORED_SESSIONS_PAGE_SIZE,
  filterIgnoredSessions,
  ignoredSessionTitle,
  pageIgnoredSessions,
} from './ignoredSessions';

function ignored(sessionId: string, session?: Partial<WorkInboxSession>): WorkIgnoredSession {
  return {
    sessionId,
    returnsToInbox: true,
    session: session ? ({ sessionId, ...session } as WorkInboxSession) : undefined,
  };
}

const many = Array.from({ length: 4059 }, (_, i) => ignored(`ses_${String(i).padStart(6, '0')}`));

describe('ignoredSessionTitle', () => {
  test('first prompt, then card title, then short id', () => {
    expect(ignoredSessionTitle(ignored('ses_1', { sessionTitle: ' Fix poller ', cardTitle: 'Card' }))).toBe('Fix poller');
    expect(ignoredSessionTitle(ignored('ses_1', { sessionTitle: '  ', cardTitle: 'Card' }))).toBe('Card');
    expect(ignoredSessionTitle(ignored('ses_abcdefghijkl'))).toBe('ses_ab…kl');
  });
});

describe('filterIgnoredSessions', () => {
  const rows = [
    ignored('ses_aaa111', { sessionTitle: 'Telegram poller fix', projectDir: '/work/agent-kanban' }),
    ignored('ses_bbb222', { sessionTitle: 'Wiki ingest', projectDir: '/work/obsidian' }),
    ignored('ses_ccc333'),
  ];

  test('blank query keeps everything', () => {
    expect(filterIgnoredSessions(rows, '   ')).toHaveLength(3);
  });

  test('matches title case-insensitively', () => {
    expect(filterIgnoredSessions(rows, 'POLLER').map((r) => r.sessionId)).toEqual(['ses_aaa111']);
  });

  test('matches the full sessionId, not just the short form', () => {
    expect(filterIgnoredSessions(rows, 'ccc333').map((r) => r.sessionId)).toEqual(['ses_ccc333']);
  });

  test('matches the project directory', () => {
    expect(filterIgnoredSessions(rows, 'obsidian').map((r) => r.sessionId)).toEqual(['ses_bbb222']);
  });

  test('no match yields an empty list', () => {
    expect(filterIgnoredSessions(rows, 'nothing-here')).toEqual([]);
  });
});

describe('pageIgnoredSessions', () => {
  test('first render shows 50 rows of 4059', () => {
    const page = pageIgnoredSessions(many, IGNORED_SESSIONS_PAGE_SIZE);
    expect(IGNORED_SESSIONS_PAGE_SIZE).toBe(50);
    expect(page.visible).toHaveLength(50);
    expect(page.visible[0]?.sessionId).toBe('ses_000000');
    expect(page.remaining).toBe(4009);
  });

  test('더 보기 adds another 50', () => {
    const page = pageIgnoredSessions(many, IGNORED_SESSIONS_PAGE_SIZE * 2);
    expect(page.visible).toHaveLength(100);
    expect(page.remaining).toBe(3959);
  });

  test('a short list has nothing remaining', () => {
    const page = pageIgnoredSessions(many.slice(0, 3), IGNORED_SESSIONS_PAGE_SIZE);
    expect(page.visible).toHaveLength(3);
    expect(page.remaining).toBe(0);
  });
});
