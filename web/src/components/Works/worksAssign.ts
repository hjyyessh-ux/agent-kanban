import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';

// Fallback stale threshold. The live value comes from Works settings
// (`works.stale_days`, surfaced as `config.staleDays`); WorksView passes it down
// and only falls back to this constant before the config has loaded.
export const STALE_WORK_DAYS = 5;
/** An Inbox session older than this is flagged "오래됨" to nudge triage. */
export const OLD_SESSION_DAYS = 14;
/** Resolved Works from the last N days stay visible in the Works tab. */
export const RESOLVED_WINDOW_DAYS = 7;

export const ROLE_LABELS: Record<WorkSessionRole, string> = {
  dev: '개발',
  review: '리뷰',
  debug: '디버그',
};

export const ROLE_OPTIONS: WorkSessionRole[] = ['dev', 'review', 'debug'];

/** Whole days elapsed since an ISO timestamp (>= 0). */
export function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  const diffMs = Date.now() - then;
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

/** Short `M/D` label in KST, matching the mockup's "시작 8/26". */
const SHORT_DATE_FMT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
});

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return SHORT_DATE_FMT.format(date).replace(/\.\s*$/, '').replace(/\.\s*/g, '/');
}

/** Coarse "n분/시간/일 전" label for Inbox activity. */
export function formatTimeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return '어제';
  return `${diffDay}일 전`;
}

/** Last path segment of a projectDir for compact display (`…/agent-kanban` → `agent-kanban`). */
export function projectDirLabel(projectDir: string | undefined): string {
  if (!projectDir) return '';
  const trimmed = projectDir.replace(/\/+$/, '');
  const segment = trimmed.split('/').pop();
  return segment || trimmed;
}

/** `a3f8c2…e1`-style short id for an opaque sessionId. */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId;
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-2)}`;
}

/**
 * Auto-suggested title for a new Work seeded from an Inbox session — the first
 * prompt (sessionTitle) preferred, falling back to the card title. Surrounding
 * quotes are stripped and the result is clipped to a sane heading length.
 * Shared by the inline panel and the assign-all modal.
 */
export function suggestWorkTitle(session: WorkInboxSession): string {
  const raw = (session.sessionTitle ?? session.cardTitle ?? '').trim();
  const unquoted = raw.replace(/^["'“”『「]+/, '').replace(/["'“”』」]+$/, '').trim();
  const firstLine = unquoted.split('\n')[0].trim();
  const MAX = 48;
  if (firstLine.length <= MAX) return firstLine;
  return `${firstLine.slice(0, MAX).trimEnd()}…`;
}

export interface WorkRecommendation {
  work: Work;
  /** True when the Work shares the session's projectDir — the primary signal. */
  sameDirectory: boolean;
}

/**
 * Rank active Works as link targets for an Inbox session: same-`projectDir`
 * Works first (the design's primary recommendation), then remaining active
 * Works, each group ordered by most-recent activity. Done/discarded Works are
 * never recommended. Shared by the inline panel (card 2) and the assign-all
 * modal (card 3) so both agree on ordering and the "추천" flag.
 */
export function recommendWorksForSession(
  session: WorkInboxSession,
  works: Work[],
): WorkRecommendation[] {
  const active = works.filter((work) => work.status === 'active');
  const byRecency = (a: Work, b: Work) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

  const sameDir = session.projectDir
    ? active.filter((work) => work.projectDir === session.projectDir).sort(byRecency)
    : [];
  const sameDirIds = new Set(sameDir.map((work) => work.id));
  const rest = active.filter((work) => !sameDirIds.has(work.id)).sort(byRecency);

  return [
    ...sameDir.map((work) => ({ work, sameDirectory: true })),
    ...rest.map((work) => ({ work, sameDirectory: false })),
  ];
}

/** Human summary of a Work's session role composition, e.g. "개발 2 · 리뷰 1". */
export function summarizeRoles(work: Work): string {
  const counts: Record<WorkSessionRole, number> = { dev: 0, review: 0, debug: 0 };
  let untyped = 0;
  for (const link of work.sessionLinks) {
    if (link.role) counts[link.role] += 1;
    else untyped += 1;
  }
  const parts: string[] = [];
  for (const role of ROLE_OPTIONS) {
    if (counts[role] > 0) parts.push(`${ROLE_LABELS[role]} ${counts[role]}`);
  }
  if (untyped > 0) parts.push(`기타 ${untyped}`);
  return parts.join(' · ');
}
