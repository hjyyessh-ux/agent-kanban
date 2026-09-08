import type {
  AgentRuntime,
  KanbanCard,
  TimelineCard,
  TimelineSessionSpan,
  Work,
  WorkSessionSummary,
  WorkSessionsResponse,
} from './types';
import { resolveAgentRuntime } from './runtime-config';

/** `YYYY-MM` key of an instant, in UTC — the same slice `archiveCards` files by. */
function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Which archive month files a timeline window has to read.
 *
 * Archive files are keyed by `card.updatedAt.slice(0, 7)` (UTC), and a card is
 * never updated *before* it ran — so a card that executed inside the window can
 * only live in the window's own month or a **later** one (a card that sat in
 * `complete` for two months before being archived is filed under the archive
 * month). One month of slack before the window covers the UTC/local skew at a
 * month boundary: 2026-03-01 00:30 KST is 2026-02-28 UTC.
 *
 * The result is bounded by how far back the window reaches — a window inside the
 * current month reads ~2 files, not the whole archive — and `loadArchives()` is
 * deliberately not involved, so the wiki and Telegram paths keep their own
 * full-archive scans unchanged.
 */
export function timelineArchiveMonths(available: string[], fromIso: string): string[] {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return [];
  const floor = monthKey(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1)));
  return available.filter((month) => month >= floor).sort();
}

/**
 * When a card actually ran, or null when it never did.
 *
 * The timeline shows execution, not intent: a card with neither `startedAt` nor
 * `completedAt` has only ever been planned, so it is dropped no matter how old
 * its `createdAt` is. The two fields are read as min/max rather than trusted in
 * order, and a card that recorded only `completedAt` becomes a single instant —
 * treating it as "still running" would draw an open rail to today over what is
 * really finished work.
 */
export function cardExecutionSpan(
  card: Pick<KanbanCard, 'startedAt' | 'completedAt'>,
): { startedAt: string; completedAt?: string } | null {
  const started = validInstant(card.startedAt);
  const completed = validInstant(card.completedAt);
  if (started === null && completed === null) return null;
  if (started === null) return { startedAt: completed!, completedAt: completed! };
  if (completed === null) return { startedAt: started };
  return Date.parse(started) <= Date.parse(completed)
    ? { startedAt: started, completedAt: completed }
    : { startedAt: completed, completedAt: started };
}

function validInstant(value: string | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Longest window `GET /api/timeline` will serve, in days.
 *
 * The window is the *only* thing bounding how much archive the route parses:
 * `timelineArchiveMonths` reads every month from the window's month −1 upward,
 * so `from=1970-01-01` reads the entire archive in one unauthenticated GET. The
 * grid itself never asks for more than 35 columns (a month view rounded up to
 * whole weeks), so 400 days leaves room for a year-scale view later while still
 * refusing the pathological request.
 */
export const TIMELINE_MAX_WINDOW_DAYS = 400;

const DAY_MS = 86_400_000;

/** Outcome of validating a requested timeline window — narrows the raw params. */
export type TimelineWindowCheck =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

/**
 * Validates a requested timeline window. Pure, so the route stays a thin
 * translation layer and the length cap is unit-testable without a server.
 */
export function checkTimelineWindow(
  from: string | null,
  to: string | null,
): TimelineWindowCheck {
  if (!from || Number.isNaN(Date.parse(from))) {
    return { ok: false, error: 'from must be an ISO 8601 timestamp' };
  }
  if (!to || Number.isNaN(Date.parse(to))) {
    return { ok: false, error: 'to must be an ISO 8601 timestamp' };
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (toMs < fromMs) return { ok: false, error: 'to must not precede from' };
  if (toMs - fromMs > TIMELINE_MAX_WINDOW_DAYS * DAY_MS) {
    return { ok: false, error: `window must not exceed ${TIMELINE_MAX_WINDOW_DAYS} days` };
  }
  return { ok: true, from, to };
}

export interface TimelineAggregateOptions {
  /** Window start, ISO 8601. Callers pass the first grid day at 00:00 local. */
  from: string;
  /** Window end, ISO 8601. Callers pass the last grid day at 23:59:59.999 local. */
  to: string;
  /** Subagent cards (`parentCardId` set) are hidden unless this is true. */
  includeSubagents: boolean;
  /** Clock, injected so a running card's open end is testable. */
  now: Date;
  /**
   * Sessions discarded from Works triage (`works.json` `ignoredSessionIds`).
   * They keep their row — they really did run — but come back flagged
   * `ignored: true` so the row drops its 배정 button: the session is no longer in
   * the Inbox, so the assign modal it opened had nothing to assign and the
   * button was permanently inert.
   */
  ignoredSessionIds?: ReadonlySet<string>;
}

/**
 * Rolls executed cards up into session rows — the timeline's minimum unit.
 *
 * A session is included when at least one of its cards *overlaps* the window,
 * not merely started inside it, so a session running since last week still
 * shows on this week's grid. Its measured extent is min/max over the included
 * cards, and `endedAt` is left absent while any of them is still running.
 *
 * Cards with no `sessionId` are dropped: there would be no row to draw them on.
 * Pure — the caller decides which months to feed it (`timelineArchiveMonths`).
 */
export function buildTimelineSessions(
  cards: KanbanCard[],
  options: TimelineAggregateOptions,
): TimelineSessionSpan[] {
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  const nowMs = options.now.getTime();

  /**
   * Instants are tracked as `{ ms, iso }` pairs so the response echoes the
   * card's own timestamp string rather than a re-serialized one.
   */
  interface Instant { ms: number; iso: string }
  interface Accumulator {
    sessionId: string;
    sessionTitle?: string;
    projectDir?: string;
    agentRuntime: AgentRuntime;
    cards: TimelineCard[];
    start: Instant;
    /** Latest finish seen; `null` until some card in the session has finished. */
    end: Instant | null;
    /** Some card is still running, so the session has no end yet. */
    running: boolean;
    /** `startedAt` of the card that supplied the display metadata so far. */
    metaAt: number;
  }
  const bySession = new Map<string, Accumulator>();
  const seenCardIds = new Set<string>();
  /**
   * Sessions that had a card finish before the window opened. That card is not
   * in the response — it is outside the window the caller asked for — but its
   * session's real start is *earlier* than the `startedAt` we report, and the
   * grid has to say so instead of drawing a closed left edge.
   */
  const truncatedBefore = new Set<string>();

  for (const card of cards) {
    if (card.deletedAt) continue;
    if (!card.sessionId) continue;
    const isSubagent = Boolean(card.parentCardId);
    if (isSubagent && !options.includeSubagents) continue;
    if (seenCardIds.has(card.id)) continue;

    const span = cardExecutionSpan(card);
    if (!span) continue;
    const start: Instant = { ms: Date.parse(span.startedAt), iso: span.startedAt };
    const end: Instant | null = span.completedAt
      ? { ms: Date.parse(span.completedAt), iso: span.completedAt }
      : null;
    if (start.ms > to) continue;
    if ((end?.ms ?? nowMs) < from) {
      truncatedBefore.add(card.sessionId);
      continue;
    }

    seenCardIds.add(card.id);
    const entry: TimelineCard = {
      id: card.id,
      title: card.title,
      status: card.status,
      startedAt: span.startedAt,
      completedAt: span.completedAt,
      isSubagent,
    };
    const runtime = resolveAgentRuntime(card);

    const acc = bySession.get(card.sessionId);
    if (!acc) {
      bySession.set(card.sessionId, {
        sessionId: card.sessionId,
        sessionTitle: card.sessionTitle,
        projectDir: card.projectDir,
        agentRuntime: runtime,
        cards: [entry],
        start,
        end,
        running: end === null,
        metaAt: start.ms,
      });
      continue;
    }

    acc.cards.push(entry);
    if (start.ms < acc.start.ms) acc.start = start;
    if (end === null) acc.running = true;
    else if (acc.end === null || end.ms > acc.end.ms) acc.end = end;
    // The newest execution wins the label: a session's title and directory can
    // both be filled in after its first card ran.
    if (start.ms >= acc.metaAt) {
      acc.metaAt = start.ms;
      acc.sessionTitle = card.sessionTitle ?? acc.sessionTitle;
      acc.projectDir = card.projectDir ?? acc.projectDir;
      acc.agentRuntime = runtime;
    }
  }

  const accumulators = Array.from(bySession.values());
  accumulators.sort((a, b) => a.start.ms - b.start.ms);
  const ignoredSessionIds = options.ignoredSessionIds;
  return accumulators.map((acc) => ({
    sessionId: acc.sessionId,
    sessionTitle: acc.sessionTitle,
    projectDir: acc.projectDir,
    agentRuntime: acc.agentRuntime,
    startedAt: acc.start.iso,
    endedAt: acc.running ? undefined : acc.end?.iso,
    cards: acc.cards.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    // Only meaningful when the reported start is itself inside the window: a
    // session already clipped by `startedAt < from` needs no second signal.
    truncatedBefore: truncatedBefore.has(acc.sessionId) && acc.start.ms >= from ? true : undefined,
    ignored: ignoredSessionIds?.has(acc.sessionId) === true ? true : undefined,
  }));
}

// ─── Work detail (GET /api/works/:id/sessions) ──────────────────────
// The Work detail dialog has the same archive problem the Timeline has, for the
// same reason: completing a Work sweeps every card under it into the monthly
// archive, so anything derived from the board list describes a finished Work as
// empty. These helpers reuse this module's archive-window machinery
// (`timelineArchiveMonths`) rather than growing a second one.

/**
 * Earliest instant a Work's cards can be filed under — the `from` to hand
 * `timelineArchiveMonths`.
 *
 * `Work.startedAt` is by definition `min()` over every linked session's earliest
 * card time, so it is normally the answer on its own; `createdAt` and each
 * `linkedAt` are folded in so that a *manually re-dated* Work (the Timeline's
 * bar-edge drag can move `startedAt` forward) still reaches back at least as far
 * as the record itself. A Work dragged forward past its own cards can still
 * under-reach — the alternative is `loadArchives()`, the full scan the wiki and
 * Telegram paths own, which must not be pulled into a per-dialog read.
 */
export function workCardScanFloor(
  work: Pick<Work, 'startedAt' | 'createdAt' | 'sessionLinks'>,
): string {
  const candidates = [work.startedAt, work.createdAt, ...work.sessionLinks.map((l) => l.linkedAt)]
    .filter((iso): iso is string => Boolean(iso) && !Number.isNaN(Date.parse(iso)));
  if (candidates.length === 0) return new Date(0).toISOString();
  return candidates.reduce((min, iso) => (iso < min ? iso : min));
}

/** Oldest-first, on the same "when did it run, else when was it made" key as `Work.startedAt`. */
function compareOldestCardFirst(a: KanbanCard, b: KanbanCard): number {
  const aAt = a.startedAt ?? a.createdAt ?? '';
  const bAt = b.startedAt ?? b.createdAt ?? '';
  if (aAt !== bAt) return aAt < bAt ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * Roll a Work's links up into per-session summaries plus the whole-Work totals
 * the 산출물 row shows.
 *
 * `archivedCardIds` is how a card is known to be off the board: the caller reads
 * the live board and the archive months separately and says which ids came from
 * the archive, because a `KanbanCard` carries no archived flag (`archivedAt`
 * lives on the monthly file, not the card). A card present in both — the sweep
 * raced the read — is counted once, from whichever list reached the caller
 * first. Sessions come back ordered by `linkedAt`, oldest link first, so the
 * dialog renders them without a second sort.
 *
 * Pure: the caller decides which months to feed it (`workCardScanFloor` +
 * `timelineArchiveMonths`).
 */
export function buildWorkSessionsResponse(
  work: Work,
  cards: KanbanCard[],
  options?: { archivedCardIds?: ReadonlySet<string>; scannedMonths?: string[] },
): WorkSessionsResponse {
  const archivedCardIds = options?.archivedCardIds;
  const bySession = new Map<string, KanbanCard[]>();
  const linkedSessionIds = new Set(work.sessionLinks.map((link) => link.sessionId));
  const seenCardIds = new Set<string>();

  for (const card of cards) {
    if (card.deletedAt) continue;
    if (!card.sessionId || !linkedSessionIds.has(card.sessionId)) continue;
    if (seenCardIds.has(card.id)) continue;
    seenCardIds.add(card.id);
    const bucket = bySession.get(card.sessionId);
    if (bucket) bucket.push(card);
    else bySession.set(card.sessionId, [card]);
  }

  const sessions: WorkSessionSummary[] = [...work.sessionLinks]
    .sort((a, b) => (a.linkedAt === b.linkedAt ? a.sessionId.localeCompare(b.sessionId) : a.linkedAt < b.linkedAt ? -1 : 1))
    .map((link) => {
      const owned = (bySession.get(link.sessionId) ?? []).sort(compareOldestCardFirst);
      const oldest = owned[0];
      const wikiDocPaths: string[] = [];
      let doneCount = 0;
      let inProgressCount = 0;
      let firstCardAt: string | undefined;
      let lastActivityAt: string | undefined;
      let wikiPending = false;
      let archivedCardCount = 0;

      for (const card of owned) {
        if (archivedCardIds?.has(card.id) === true) archivedCardCount++;
        if (card.status === 'done' || card.status === 'complete') doneCount++;
        else if (card.status === 'todo' || card.status === 'in_progress') inProgressCount++;
        const ranAt = card.startedAt ?? card.createdAt;
        if (ranAt && (!firstCardAt || ranAt < firstCardAt)) firstCardAt = ranAt;
        if (card.updatedAt && (!lastActivityAt || card.updatedAt > lastActivityAt)) {
          lastActivityAt = card.updatedAt;
        }
        if (card.wiki?.status === 'pending') wikiPending = true;
        // `docPath` is only meaningful for a kept card — the same rule the Wiki
        // view applies before it shows a document.
        const docPath = card.wiki?.decision === 'kept' ? card.wiki.docPath : undefined;
        if (docPath && !wikiDocPaths.includes(docPath)) wikiDocPaths.push(docPath);
      }

      return {
        sessionId: link.sessionId,
        role: link.role,
        linkedAt: link.linkedAt,
        projectDir: link.projectDir ?? oldest?.projectDir,
        title: oldest?.title?.trim() || oldest?.sessionTitle?.trim() || '',
        cardCount: owned.length,
        doneCount,
        inProgressCount,
        firstCardAt,
        lastActivityAt,
        // An empty session is not "archived" — it has nothing to have been swept.
        archived: owned.length > 0 && archivedCardCount === owned.length,
        // The count, not just the flag: reopening a Work restores exactly these
        // cards, and its confirmation has to name the number first.
        archivedCardCount,
        // Echoed rather than derived from `owned.length === 0`: this read is
        // month-bounded, so "no cards in the scanned window" and "no cards at
        // all" are different facts. The stamp is the second one, written by
        // `reconcileWorkSessionLinks`.
        cardsMissingAt: link.cardsMissingAt,
        cardIds: owned.map((card) => card.id),
        wikiDocPaths,
        wikiPending,
      };
    });

  const wikiDocPaths: string[] = [];
  for (const session of sessions) {
    for (const docPath of session.wikiDocPaths) {
      if (!wikiDocPaths.includes(docPath)) wikiDocPaths.push(docPath);
    }
  }
  const lastActivityAt = sessions.reduce<string | undefined>((latest, session) => {
    if (!session.lastActivityAt) return latest;
    return !latest || session.lastActivityAt > latest ? session.lastActivityAt : latest;
  }, undefined);

  return {
    activities: [...bySession.values()].flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(card => ({
      id: card.id, title: card.title, sessionId: card.sessionId, status: card.status,
      createdAt: card.createdAt, startedAt: card.startedAt, completedAt: card.completedAt,
      updatedAt: card.updatedAt, result: card.result, archived: archivedCardIds?.has(card.id) ?? false,
    })),
    workId: work.id,
    sessions,
    cardCount: sessions.reduce((sum, session) => sum + session.cardCount, 0),
    doneCount: sessions.reduce((sum, session) => sum + session.doneCount, 0),
    inProgressCount: sessions.reduce((sum, session) => sum + session.inProgressCount, 0),
    archivedCardCount: sessions.reduce((sum, session) => sum + session.archivedCardCount, 0),
    lastActivityAt: lastActivityAt ?? work.updatedAt,
    wikiDocPaths,
    wikiPending: sessions.some((session) => session.wikiPending),
    scannedMonths: options?.scannedMonths ?? [],
  };
}
