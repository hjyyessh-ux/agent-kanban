import type {
  KanbanCard,
  KanbanStatus,
  Work,
  WorkCompletionPreview,
  WorkInboxSession,
  WorkListSort,
  WorkSessionLink,
  WorkSessionRole,
  WorksConfigDto,
} from '../../../../src/core/types';
import { resolveAgentRuntime } from '../../../../src/core/runtime-config';
import { selectWorks, workPlanOverrunDays } from '../../../../src/core/work-list';
import { resolveWorkStartedAt } from '../../../../src/plugin/works/work-lifecycle';

// Fallback stale threshold. The live value comes from Works settings
// (`works.stale_days`, surfaced as `config.staleDays`); WorksView passes it down
// and only falls back to this constant before the config has loaded.
export const STALE_WORK_DAYS = 5;
/** An Inbox session older than this is flagged "오래됨" to nudge triage. */
export const OLD_SESSION_DAYS = 14;

export const ROLE_LABELS: Record<WorkSessionRole, string> = {
  dev: '개발',
  review: '리뷰',
  debug: '디버그',
};

export const ROLE_OPTIONS: WorkSessionRole[] = ['dev', 'review', 'debug'];

/**
 * A Work's status, in the language the rest of the screen is written in.
 *
 * `active` used to render as the literal `ACTIVE` while its two siblings were
 * `완료` and `폐기`, so one badge called the same field by two conventions and
 * leaked the wire enum to the reader. The wire value stays `active`; only the
 * label changes.
 */
export const WORK_STATUS_LABELS: Record<Work['status'], string> = {
  active: '진행 중',
  done: '완료',
  discarded: '폐기',
};

/**
 * The detail dialog's single status badge — status plus how long the Work has
 * run, which is the one thing the badge and the 기간 row used to both claim
 * ("ACTIVE · 3일째" above "3일째 active").
 *
 * An open Work is counted to today (`…일째`, still running); a terminal one
 * reports the span it took, because "3일째" for something finished in March is
 * a claim about the present about a Work that has none.
 */
export function describeWorkStatusBadge(
  work: Pick<Work, 'status' | 'startedAt' | 'resolvedAt'>,
  now?: number,
): string {
  const days = workAgeDays(work, now);
  const label = WORK_STATUS_LABELS[work.status];
  return work.status === 'active' ? `${label} · ${days}일째` : `${label} · ${days}일 소요`;
}

/** One 산출물 chip: a count, its label, and the statuses that label covers. */
export interface WorkArtifactChip {
  label: string;
  count: number;
  /** Tooltip spelling out which card statuses the count includes. */
  hint: string;
}

/**
 * The 산출물 row's card counts.
 *
 * The labels used to be the wire statuses (`done 5`, `in_progress 1`) and one of
 * them was wrong on top of being English: `inProgressCount` is
 * `todo + in_progress` (see `buildWorkSessionsResponse`), so `in_progress 1`
 * counted cards that had never started. Each chip is now named after what its
 * number actually sums, and the hint lists the statuses using the board's own
 * Korean names.
 */
export function describeWorkArtifacts(totals: {
  cardCount: number;
  doneCount: number;
  inProgressCount: number;
}): WorkArtifactChip[] {
  return [
    { label: '카드', count: totals.cardCount, hint: '이 Work에 속한 카드 전체' },
    { label: '끝난 카드', count: totals.doneCount, hint: '완료 + 검토 대기' },
    { label: '남은 카드', count: totals.inProgressCount, hint: '대기 + 진행중' },
  ];
}

/** Whole days elapsed since an ISO timestamp (>= 0). */
export function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  const diffMs = Date.now() - then;
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

/**
 * How many days a Work spans, counted inclusively (its first day is day 1).
 *
 * A terminal Work is measured **to its own `resolvedAt`**, not to today: a Work
 * finished in March must not read "180일째" in September. Only an `active` Work
 * runs to the clock — including one carrying a *planned* `resolvedAt`, which is
 * a forecast, not an end. A Work with no usable dates reports 1 day rather than
 * 0, so the badge never says "0일째".
 */
export function workAgeDays(
  work: Pick<Work, 'status' | 'startedAt' | 'resolvedAt'>,
  now: number = Date.now(),
): number {
  const start = Date.parse(work.startedAt);
  if (Number.isNaN(start)) return 1;
  const resolved = work.status === 'active' ? NaN : Date.parse(work.resolvedAt ?? '');
  const end = Number.isNaN(resolved) ? now : resolved;
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
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

/**
 * Projects an already-linked session back into the Inbox DTO shape so the move
 * dialog can reuse `WorkAssignInline` (and with it `recommendWorksForSession` /
 * `suggestWorkTitle`) instead of growing a second "where does this session
 * belong" panel. Derived from the session's cards — oldest card for the title,
 * newest activity for the timestamp — falling back to the link itself for a
 * session whose cards have all been archived away.
 */
export function inboxSessionFromLink(
  link: WorkSessionLink,
  cards: KanbanCard[],
): WorkInboxSession {
  const owned = cards
    .filter((card) => card.sessionId === link.sessionId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const oldest = owned[0];
  const lastActivity = owned.map((card) => card.updatedAt).filter(Boolean).sort().at(-1);

  return {
    sessionId: link.sessionId,
    sessionTitle: oldest?.sessionTitle,
    cardTitle: oldest?.title ?? shortSessionId(link.sessionId),
    cardId: oldest?.id ?? '',
    cardStatus: oldest?.status ?? 'done',
    projectDir: link.projectDir ?? oldest?.projectDir,
    agentRuntime: resolveAgentRuntime({ agentRuntime: oldest?.agentRuntime }),
    agentType: oldest?.agentType,
    model: oldest?.model,
    relatedCardCount: owned.length,
    // A projected link is addressed as a session in its own right; the subagent
    // distinction only matters while a session is still in the Inbox.
    sessionKind: 'main',
    updatedAt: lastActivity ?? link.linkedAt,
  };
}

/**
 * The Inbox row's 상태 칩 — what state this session is actually in, or null when
 * there is nothing worth saying.
 *
 * Every Inbox row used to look identical: a session whose agent was still
 * running, one whose card had never been dispatched, and one that finished a
 * week ago were the same grey line of text. They are not the same triage
 * decision — a running session is not finished enough to assign, a `todo` one
 * never started — so each gets a chip and a *settled* session gets none, which
 * keeps the row quiet in the common case.
 *
 * `subagent` outranks the card status: the row's real problem is that it is a
 * duplicate of its parent (whose own row is right there, still unassigned —
 * once the parent is assigned the server stops returning this row at all).
 */
export interface SessionStateChip {
  label: string;
  /** Drives the `.works-inbox-state--{tone}` colour. */
  tone: 'subagent' | 'running' | 'idle';
}

export function describeSessionState(
  session: Pick<WorkInboxSession, 'cardStatus' | 'sessionKind'>,
): SessionStateChip | null {
  if (session.sessionKind === 'subagent') return { label: 'subagent', tone: 'subagent' };
  if (session.cardStatus === 'in_progress') return { label: '실행 중', tone: 'running' };
  if (session.cardStatus === 'todo') return { label: '미실행', tone: 'idle' };
  return null;
}

export interface WorkRecommendation {
  work: Work;
  /** True when the Work shares the session's projectDir — the primary signal. */
  sameDirectory: boolean;
  /**
   * True when the Work already holds a session this one continues (subagent
   * parent / queue chain / resumed session). Outranks `sameDirectory`: a shared
   * directory says "same project", lineage says "same piece of work".
   */
  chained: boolean;
}

/**
 * Rank active Works as link targets for an Inbox session: session **lineage**
 * first, then same-`projectDir`, then the remaining active Works, each group
 * ordered by most-recent activity. Done/discarded Works are never recommended.
 * Shared by the inline panel (card 2), the assign-all modal (card 3), and the
 * move dialog so all three agree on ordering and on the badges.
 *
 * - `excludeWorkId` drops the Work a session already belongs to — "move it to
 *   where it already is" is not a destination.
 * - `chained` — Works holding a session this one continues (see
 *   `chainedWorkIds` in `worksAffinity.ts`). Pass it only where the lineage is
 *   actually known and `works.assign_suggest_resume_chain` is on; omitting it
 *   reproduces the plain same-dir-first ordering exactly. A Work that is both
 *   chained and same-directory ranks in the chained group and shows both marks.
 * - `options.preferSameDir` — `works.assign_prefer_same_dir`. `false` drops the
 *   same-directory *group*, leaving lineage-then-recency; the `sameDirectory`
 *   flag is still reported, because the 같은 디렉토리 mark describes the Work
 *   whether or not it is being ranked on. Defaults to `true`, which is the
 *   documented default and what every caller did before the setting was wired
 *   up — it was read and written by the settings panel and consulted nowhere,
 *   so turning it off changed nothing.
 */
export function recommendWorksForSession(
  session: WorkInboxSession,
  works: Work[],
  excludeWorkId?: string,
  chained?: ReadonlySet<string>,
  options?: { preferSameDir?: boolean },
): WorkRecommendation[] {
  const preferSameDir = options?.preferSameDir !== false;
  const active = works.filter(
    (work) => work.status === 'active' && work.id !== excludeWorkId,
  );
  const byRecency = (a: Work, b: Work) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

  const isSameDir = (work: Work) =>
    Boolean(session.projectDir) && work.projectDir === session.projectDir;
  const isChained = (work: Work) => Boolean(chained?.has(work.id));

  const lineage = active.filter(isChained).sort(byRecency);
  const sameDir = preferSameDir
    ? active.filter((work) => !isChained(work) && isSameDir(work)).sort(byRecency)
    : [];
  const chosen = new Set([...lineage, ...sameDir].map((work) => work.id));
  const rest = active.filter((work) => !chosen.has(work.id)).sort(byRecency);

  return [...lineage, ...sameDir, ...rest].map((work) => ({
    work,
    sameDirectory: isSameDir(work),
    chained: isChained(work),
  }));
}

/**
 * Confirmation text for deleting a Work. `DELETE /api/works/:id` has no status
 * guard and drops only the Work: the cards stay where they are and every linked
 * session becomes unassigned again, which makes deletion the one way to pull a
 * completed Work's sessions back into the Inbox for re-triage. That escape hatch
 * is kept open deliberately, so the wording states the consequences instead of
 * blocking the action — and for a `done` Work it says outright what deletion
 * does *not* undo (the bulk archive, the wiki documents).
 *
 * Pure so the copy is testable; the caller passes it to `window.confirm`.
 */
export function confirmDeleteWorkMessage(work: Work): string {
  const sessionCount = work.sessionLinks.length;
  if (work.status === 'done') {
    return [
      '⚠ 완료된 Work를 삭제합니다.',
      `   연결된 세션 ${sessionCount}개가 Inbox로 돌아오지만, 이미 archive된 카드는 복구되지 않습니다.`,
      '   생성된 wiki 문서도 그대로 남습니다.',
    ].join('\n');
  }
  return [
    `"${work.title}"을 삭제합니다.`,
    `연결된 세션 ${sessionCount}개는 Inbox로 돌아가고, 카드는 보드에 그대로 남습니다.`,
  ].join('\n');
}

/**
 * Should completing a Work go through the confirmation dialog?
 *
 * `works.done_confirm` decides, but the **unloaded** config resolves to `true`
 * rather than falling through. The old gate read `config?.doneConfirm` directly,
 * so a click landing before the config request came back saw `undefined`, took
 * it as "no confirmation needed", and bulk-archived without a prompt. The
 * setting can only *skip* the dialog when it has actually been read as `false`.
 */
export function requiresDoneConfirm(config: WorksConfigDto | null | undefined): boolean {
  return config?.doneConfirm !== false;
}

/** Status labels for the completion preview's card breakdown, board order. */
const PREVIEW_STATUS_LABELS: Array<[KanbanStatus, string]> = [
  ['todo', '대기'],
  ['in_progress', '진행중'],
  // Same words as the Timeline legend (`TIMELINE_STATUS_LABELS`): `complete`
  // is the agent waiting on the user, `done` is the finished column — the old
  // `done 6` printed the wire enum in the one dialog that should read plainly.
  ['complete', '검토 대기'],
  ['done', '완료'],
];

/** `대기 2 · 진행중 1` — the non-zero statuses of a completion preview, board order. */
export function describeCompletionByStatus(preview: WorkCompletionPreview): string {
  return PREVIEW_STATUS_LABELS
    .filter(([status]) => preview.byStatus[status] > 0)
    .map(([status, label]) => `${label} ${preview.byStatus[status]}`)
    .join(' · ');
}

/** Why completing this Work is currently refused, or null when it may proceed. */
export type WorkCompletionBlock = 'running' | 'conflict' | 'already-archived' | null;

export function workCompletionBlock(
  preview: WorkCompletionPreview | null | undefined,
): WorkCompletionBlock {
  if (!preview) return null;
  // A card with a live agent run cannot be archived: the sweep would pull it out
  // from under the runtime, whose completion hook then fails with `Card not
  // found` and leaves the wiki summarizing an unfinished transcript. The server
  // answers `409`; the dialog says so before the user clicks.
  if (preview.conflictingCardIds?.length) return 'conflict';
  if (preview.runningCardIds.length > 0) return 'running';
  if (preview.alreadyArchived) return 'already-archived';
  return null;
}

/**
 * The confirmation dialog's headline. States the irreversible part in cards,
 * because "이 Work를 완료합니다" does not tell anyone what is about to be
 * destroyed — the previous `window.confirm` copy said only that a bulk archive
 * would happen, with no count and no way to see it first.
 */
export function describeWorkCompletion(preview: WorkCompletionPreview | null | undefined): string {
  if (!preview) return '산하 카드를 일괄 done 처리한 뒤 archive합니다. 다시 열기로 보드에 복원할 수 있습니다.';
  if (preview.alreadyArchived) {
    return `이 Work의 카드 ${preview.cardCount}장은 이미 archive됐습니다. 더 archive할 카드가 없습니다.`;
  }
  if (preview.sweepCardCount === 0) {
    return preview.favoriteCardIds.length > 0
      ? '보드에 남은 카드가 전부 즐겨찾기입니다. archive 없이 Work 상태만 완료로 기록됩니다.'
      : '보드에 남은 카드가 없습니다. Work 상태만 완료로 기록됩니다.';
  }
  return `카드 ${preview.sweepCardCount}장이 done 처리된 뒤 archive됩니다. 다시 열기로 보드에 복원할 수 있습니다.`;
}

/**
 * The favorites line under the headline, or '' when nothing is pinned.
 *
 * `favorite` means "keep this card on the board", and the completion sweep now
 * honours it — so the dialog has to say which cards it will *not* archive.
 * Without this the headline's card count and the board afterwards disagreed
 * with no explanation.
 */
export function describeKeptFavorites(
  preview: WorkCompletionPreview | null | undefined,
): string {
  const kept = preview?.favoriteCardIds.length ?? 0;
  if (kept === 0) return '';
  return `⭐ 즐겨찾기 카드 ${kept}장은 보드에 그대로 남습니다 (archive되지 않습니다).`;
}

/** The blocking line shown in place of the confirm action, or '' when unblocked. */
export function describeWorkCompletionBlock(
  preview: WorkCompletionPreview | null | undefined,
): string {
  switch (workCompletionBlock(preview)) {
    case 'conflict':
      return '다른 Work에 연결된 하위 카드가 있습니다. 세션 연결을 정리한 뒤 다시 시도하세요.';
    case 'running':
      return `실행 중 카드 ${preview!.runningCardIds.length}장이 있어 완료할 수 없습니다. `
        + '에이전트가 끝난 뒤 다시 시도하세요.';
    case 'already-archived':
      return '이미 archive된 Work입니다.';
    default:
      return '';
  }
}

/**
 * Confirmation text for discarding a Work. Cheap compared to completion — no
 * card is touched — but still terminal and still without an undo, so it gets the
 * same dialog rather than firing straight off the button.
 */
export function describeWorkDiscard(work: Work): string {
  return `"${work.title}"을 폐기합니다. 카드 ${work.sessionLinks.length}개 세션은 보드에 그대로 남고, `
    + 'wiki는 이 Work의 그룹핑만 해제합니다. 폐기한 Work는 다시 열 수 있습니다.';
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

/**
 * Resolved (done/discarded) Works, most recently resolved first. The Works tab
 * shows only the *count* of these up front and hides the list behind a toggle —
 * there is no date window, because an "old" resolved Work is exactly what you
 * come looking for when you do open the section. Undated resolutions sort by
 * `updatedAt` so a record with no `resolvedAt` still lands in a sane place.
 */
export function resolvedWorksNewestFirst(works: Work[]): Work[] {
  const resolvedTime = (work: Work): number => {
    const stamp = new Date(work.resolvedAt ?? work.updatedAt).getTime();
    return Number.isNaN(stamp) ? 0 : stamp;
  };
  return works
    .filter((work) => work.status !== 'active')
    .sort((a, b) => resolvedTime(b) - resolvedTime(a));
}

// ─── 모두 배정하기 modal: keyboard + progress ────────────────────────────────

/** The part of a key event's target the shortcut rule cares about. */
export interface ShortcutTarget {
  /** Uppercase tag name, as the DOM reports it. */
  tagName: string;
  isContentEditable?: boolean;
}

export interface BulkAssignKeyInput {
  key: string;
  target: ShortcutTarget;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** How many recommendations the 1–9 grid can actually address. */
  recommendationCount: number;
}

/**
 * What a key press in the assign-all modal means, or `null` for "leave this
 * event alone" (no handling, no `preventDefault`).
 */
export type BulkAssignShortcut =
  | { action: 'connect' }
  | { action: 'select-new' }
  | { action: 'skip' }
  | { action: 'discard' }
  | { action: 'select-recommendation'; index: number };

/** Form controls that must keep their own keystrokes. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** Elements whose own activation behaviour Enter/Space belongs to. */
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

/**
 * The assign-all modal's single-key shortcuts, as a pure rule.
 *
 * The modal binds `keydown` on `window` in the capture phase (it has to — see
 * `BulkAssignModal`), which means **every** key press in the dialog arrives
 * here regardless of where focus sits. That is what made this dangerous: `Enter`
 * was handled above the typing check, so pressing it while the `X 폐기` button
 * had focus ran 연결하고 다음 *and* `preventDefault`ed the button's own
 * activation; and the typing check listed only `INPUT`/`TEXTAREA`, so `x` typed
 * with the 역할 `<select>` focused discarded the session — permanently, since
 * the ignore list had no way back at the time.
 *
 * Two rules, therefore:
 *
 * - A **focused control activates itself**. On `BUTTON`/`A` (and
 *   `contenteditable`), `Enter` is that element's own key and the modal takes
 *   nothing: the `×`, `X 폐기`, `S 건너뛰기` and `연결하고 다음` buttons all do
 *   exactly what they say when Enter is pressed on them.
 * - While **typing**, only `Enter` is a shortcut. `INPUT`, `TEXTAREA`,
 *   `SELECT` and `contenteditable` all count as typing, so no letter or digit
 *   the user types into the title field or picks in the role select can ever
 *   trigger a triage action.
 */
export function resolveBulkAssignShortcut(input: BulkAssignKeyInput): BulkAssignShortcut | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null;

  const tag = input.target.tagName.toUpperCase();
  const editable = input.target.isContentEditable === true;
  const typing = TYPING_TAGS.has(tag) || editable;
  const activatable = ACTIVATABLE_TAGS.has(tag) || editable;

  if (input.key === 'Enter') {
    // The element under focus owns Enter; submitting from the title input is
    // still a shortcut, which is the one case the modal wants.
    return activatable ? null : { action: 'connect' };
  }
  if (typing) return null;

  switch (input.key.toLowerCase()) {
    case 'n':
      return { action: 'select-new' };
    case 's':
      return { action: 'skip' };
    case 'x':
      return { action: 'discard' };
    default:
      break;
  }
  if (/^[1-9]$/.test(input.key)) {
    const index = Number(input.key) - 1;
    return index < input.recommendationCount ? { action: 'select-recommendation', index } : null;
  }
  return null;
}

/** Outcomes recorded so far in one assign-all walk. */
export interface BulkAssignTally {
  linked: number;
  skipped: number;
  discarded: number;
}

export const EMPTY_BULK_ASSIGN_TALLY: BulkAssignTally = { linked: 0, skipped: 0, discarded: 0 };

/**
 * The live half of the modal's progress line.
 *
 * `n / N` alone froze the moment triage started: N stayed at the snapshot size
 * while sessions were being linked and discarded out of the Inbox, so the one
 * number on screen described a queue that no longer existed. The counts here are
 * announced (`aria-live`) as they change, and `남은` is the honest remainder.
 */
export function describeBulkAssignProgress(tally: BulkAssignTally, remaining: number): string {
  const parts: string[] = [];
  if (tally.linked > 0) parts.push(`연결 ${tally.linked}`);
  if (tally.skipped > 0) parts.push(`건너뜀 ${tally.skipped}`);
  if (tally.discarded > 0) parts.push(`폐기 ${tally.discarded}`);
  parts.push(remaining > 0 ? `남은 ${remaining}개` : '남은 세션 없음');
  return parts.join(' · ');
}

/** One Inbox row's vertical extent, measured in list-container coordinates. */
export interface InboxRowExtent {
  sessionId: string;
  top: number;
  bottom: number;
}

/**
 * Index of the row under `y`, clamped to the list's ends so a pointer dragged
 * past the first or last row keeps extending the selection instead of losing
 * it. `rows` must be in list order (top to bottom); an empty list gives -1.
 *
 * Hit-testing by row — rather than intersecting a pixel rectangle — is what
 * makes the drag immune to the list shifting under the pointer mid-drag, which
 * is also why `columnAtPointer` in `timelineModel.ts` works the same way.
 */
export function rowIndexAtPointer(y: number, rows: InboxRowExtent[]): number {
  if (rows.length === 0) return -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (y <= rows[index].bottom) return index;
  }
  return rows.length - 1;
}

/** Session ids of the inclusive row range between two indices, either order. */
export function sessionIdsBetween(
  rows: InboxRowExtent[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (fromIndex < 0 || toIndex < 0) return [];
  const first = Math.min(fromIndex, toIndex);
  const last = Math.max(fromIndex, toIndex);
  return rows.slice(first, last + 1).map((row) => row.sessionId);
}

/**
 * Collapses a multi-session selection into one `WorkInboxSession` so the bulk
 * assignment can reuse `WorkAssignInline` — and with it
 * `recommendWorksForSession` / `suggestWorkTitle` — instead of growing a second
 * ranking implementation for "these N sessions".
 *
 * The oldest session seeds the identity (its first prompt is the best title
 * guess for the work the whole batch belongs to), and `projectDir` survives only
 * when every selected session agrees on it: a mixed-directory batch has no
 * "same directory" Work to recommend, and the Work it creates should not claim
 * one either.
 */
export function mergeSessionsForAssign(sessions: WorkInboxSession[]): WorkInboxSession | null {
  if (sessions.length === 0) return null;
  const byAge = [...sessions].sort(
    (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
  );
  const oldest = byAge[0];
  const sharedDir = sessions.every((session) => session.projectDir === oldest.projectDir)
    ? oldest.projectDir
    : undefined;

  // Lineage is unioned, not taken from the representative: any selected
  // session's chain is a reason to recommend a Work for the whole batch.
  const lineage = new Set(sessions.flatMap((session) => session.relatedSessionIds ?? []));

  return {
    ...oldest,
    projectDir: sharedDir,
    relatedCardCount: sessions.reduce((sum, session) => sum + session.relatedCardCount, 0),
    relatedSessionIds: lineage.size > 0 ? [...lineage] : undefined,
  };
}

/**
 * `예정 2일 초과` for an `active` Work whose planned end has passed, or `''`.
 *
 * A planned end that had come and gone looked exactly like one still in the
 * future: the list printed `시작 8/26` and the Timeline drew the bar stopping at
 * a date in the past with no mark at all. The day count comes from the shared
 * `workPlanOverrunDays`, so the chip, the list tint and the Timeline bar all
 * agree on when a Work is late.
 */
export function describeWorkPlanOverrun(
  work: Pick<Work, 'status' | 'resolvedAt'>,
  now?: number,
): string {
  const days = workPlanOverrunDays(work, now);
  return days > 0 ? `예정 ${days}일 초과` : '';
}

/** The sort options the Active list offers, in order, with their labels. */
export const WORK_LIST_SORT_LABELS: Array<[WorkListSort, string]> = [
  ['updated', '최근 활동'],
  ['stale', '오래 방치된 순'],
  ['planned', '예정일 임박순'],
];

/**
 * The reopen confirmation's headline.
 *
 * Reopening is the one Work transition that *restores* rather than destroys, so
 * the copy leads with what comes back — and with the part that does not: the
 * completion sweep flipped every card to `done` and their previous statuses are
 * recorded nowhere, so they return `done`.
 *
 * `null` means the archive-inclusive read has not answered (or failed). The
 * action is still offered — a restore is not destructive — but the number is not
 * invented.
 */
export function describeWorkReopen(archivedCardCount: number | null): string {
  if (archivedCardCount === null) {
    return 'archive된 카드를 보드로 되돌리고 Work를 다시 진행 중으로 바꿉니다. '
      + '(복원할 카드 수를 확인하지 못했습니다)';
  }
  if (archivedCardCount === 0) {
    return 'archive된 카드가 없습니다. Work 상태만 다시 진행 중으로 바꿉니다.';
  }
  return `archive된 카드 ${archivedCardCount}장을 보드로 되돌리고 Work를 다시 진행 중으로 바꿉니다. `
    + '카드는 완료 처리된 상태(done)로 돌아옵니다.';
}

/**
 * What merging `from` into `to` would change, as lines for the confirmation.
 *
 * A merge re-dates the target's Timeline bar and closes the source, and both
 * were silent: the only merge-shaped path before this was moving sessions out
 * one at a time, and the user found out what happened by watching the list.
 *
 * The start date is computed with the server's own `resolveWorkStartedAt` over
 * the board cards and the post-merge link set — same function, same rule, no
 * second implementation to drift.
 */
export function describeWorkMergeImpact(
  from: Work,
  to: Work,
  cards: KanbanCard[],
): string[] {
  const lines: string[] = [];
  const held = new Set(to.sessionLinks.map((link) => link.sessionId));
  const moving = from.sessionLinks.filter((link) => !held.has(link.sessionId));
  const skipped = from.sessionLinks.length - moving.length;

  lines.push(
    moving.length > 0
      ? `세션 ${moving.length}개가 "${to.title}"으로 옮겨져 총 ${to.sessionLinks.length + moving.length}개가 됩니다.`
      : `"${to.title}"이 이미 이 세션들을 갖고 있어 옮길 세션이 없습니다.`,
  );
  if (skipped > 0) {
    lines.push(`이미 "${to.title}"에 있는 세션 ${skipped}개는 대상의 링크를 그대로 둡니다.`);
  }

  const nextStart = resolveWorkStartedAt(cards, {
    ...to,
    sessionLinks: [...to.sessionLinks, ...moving],
  });
  if (formatShortDate(nextStart) !== formatShortDate(to.startedAt)) {
    lines.push(
      `"${to.title}"의 시작일이 ${formatShortDate(to.startedAt)} → ${formatShortDate(nextStart)}로 조정됩니다.`,
    );
  }

  lines.push(`"${from.title}"은 폐기(병합됨)로 닫히고, 어디로 합쳐졌는지 기록됩니다.`);
  if (from.summary) lines.push('이 Work의 Summary와 메모는 그대로 남습니다.');
  return lines;
}

/**
 * Works this Work may be merged into: `active` targets only, self excluded,
 * ordered like every other Work picker (most recent activity first).
 *
 * `active` only, because the store's move gate refuses both ends of an archived
 * or mid-completion Work — offering one would be a `409` waiting to happen.
 */
export function mergeTargetsFor(work: Work, works: Work[], q?: string): Work[] {
  return selectWorks(
    works.filter((candidate) => candidate.id !== work.id),
    { status: 'active', q },
  );
}
