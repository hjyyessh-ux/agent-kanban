import type { WorkIgnoredSession } from '../../../../src/core/types';
import { shortSessionId } from './worksAssign';

/**
 * Rows the 무시한 세션 panel renders per step. The list is append-only in
 * practice (thousands of ids on a long-lived install), and rendering all of it
 * at once froze the Works tab.
 */
export const IGNORED_SESSIONS_PAGE_SIZE = 50;

/** First prompt → card title → short id: the same name the Inbox row used. */
export function ignoredSessionTitle(entry: WorkIgnoredSession): string {
  const summary = entry.session;
  return summary?.sessionTitle?.trim()
    || summary?.cardTitle
    || shortSessionId(entry.sessionId);
}

/**
 * Case-insensitive substring match on title, full sessionId and projectDir.
 * A blank query keeps everything.
 *
 *   "kanban"  → rows whose title or `/…/agent-kanban` dir contains it
 *   "a3f8c2"  → the row whose sessionId contains it
 */
export function filterIgnoredSessions(
  sessions: readonly WorkIgnoredSession[],
  query: string,
): WorkIgnoredSession[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sessions];
  return sessions.filter((entry) => [
    ignoredSessionTitle(entry),
    entry.sessionId,
    entry.session?.projectDir ?? '',
  ].some((field) => field.toLowerCase().includes(needle)));
}

export interface IgnoredSessionsPage {
  visible: WorkIgnoredSession[];
  /** Rows still hidden behind `더 보기`. */
  remaining: number;
}

/** The first `limit` rows plus how many are left. */
export function pageIgnoredSessions(
  sessions: readonly WorkIgnoredSession[],
  limit: number,
): IgnoredSessionsPage {
  const size = Math.max(0, limit);
  return {
    visible: sessions.slice(0, size),
    remaining: Math.max(0, sessions.length - size),
  };
}
