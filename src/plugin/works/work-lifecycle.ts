import { selectArchiveCards } from '../../core/archive-selection';
import type { KanbanStore } from '../../core/store';
import type { WorkStartedAtResolver, WorkStore } from '../../core/work-store';
import type {
  KanbanCard,
  KanbanStatus,
  UpdateWorkInput,
  Work,
  WorkArchiveSkipReason,
  WorkCompletionPreview,
  WorkReopenResponse,
  WorkSweepFailure,
} from '../../core/types';
import { timelineArchiveMonths, workCardScanFloor } from '../../core/timeline-aggregate';
import {
  WorkAlreadyActiveError,
  WorkCardsRunningError,
  WorkCardsConflictError,
  WorkNotFoundError,
} from '../../core/work-errors';

export type { WorkArchiveSkipReason };

export interface WorkTransitionResult {
  work: Work;
  /** Cards this call flipped to `done` (they were `todo`/`in_progress`/`complete`). */
  completedCardIds: string[];
  /** Cards handed to `store.archiveCards()` as archive seeds. */
  archiveSeedIds: string[];
  archivedCount: number;
  archiveMonth?: string;
  archiveSkipped?: WorkArchiveSkipReason;
  /**
   * Seeds this sweep could not flip or archive — a card deleted between the read
   * and the write, say. The sweep is N independent store writes, so partial
   * success is a real outcome and is reported rather than escaping as a failure
   * of the whole patch.
   */
  failedCards: WorkSweepFailure[];
  /**
   * Favorited top-level cards pruned from the sweep — pinned to the board by
   * the user, so completion leaves them there and says so.
   */
  keptFavoriteCardIds: string[];
}

/**
 * "Which of these cards has a live agent run?" Injected so the lifecycle stays
 * unit-testable without a `RuntimeRunStore` (and so the route can answer it with
 * a single `listRuns()` read instead of one lookup per card). Returns the subset
 * of `cardIds` that are running.
 */
export type ActiveRunProbe = (cardIds: string[]) => Promise<string[]>;

/** Cards belonging to any session linked to `work`, in board order. */
export function selectWorkCards(cards: KanbanCard[], work: Work): KanbanCard[] {
  const sessionIds = new Set(work.sessionLinks.map(l => l.sessionId));
  if (sessionIds.size === 0) return [];
  return cards.filter(c => c.sessionId !== undefined && sessionIds.has(c.sessionId));
}

/** Includes late subagents even when they were created after session assignment. */
export function selectWorkSweepCards(cards: KanbanCard[], work: Work): KanbanCard[] {
  const ids = selectWorkCards(cards, work).filter(c => !c.favorite).map(c => c.id);
  return ids.length ? selectArchiveCards(cards, ids, false) : [];
}

async function assertSweepSafe(cards: KanbanCard[], work: Work, workStore: WorkStore, probe?: ActiveRunProbe) {
  const otherSessions = new Set((await workStore.getWorks())
    .filter(w => w.id !== work.id).flatMap(w => w.sessionLinks.map(l => l.sessionId)));
  const conflicts = cards.filter(c => c.sessionId && otherSessions.has(c.sessionId));
  if (conflicts.length) throw new WorkCardsConflictError(conflicts.map(c => c.id));
  if (probe && cards.length) {
    const running = await probe(cards.map(c => c.id));
    if (running.length) throw new WorkCardsRunningError(running);
  }
}

/**
 * Earliest `startedAt` among a session's cards. Falls back to `createdAt` for
 * cards that never dispatched, and to `undefined` when the session has no cards
 * at all (callers then use the link time).
 */
export function resolveSessionStartedAt(cards: KanbanCard[], sessionId: string): string | undefined {
  let earliest: string | undefined;
  for (const card of cards) {
    if (card.sessionId !== sessionId) continue;
    const candidate = card.startedAt ?? card.createdAt;
    if (!candidate) continue;
    if (!earliest || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

/**
 * `Work.startedAt` — the Timeline bar's left edge — is `min()` over the earliest
 * card time of every linked session, so it always means "when this work actually
 * began". Linking an older session pulls the bar left; unlinking the oldest one
 * pushes it right to whatever remains. Archived cards count (a session is often
 * already closed out when it gets triaged); a link whose session has no cards at
 * all falls back to its `linkedAt`, and a Work with no links keeps its current
 * value. `resolvedAt` is never derived from sessions and is left alone.
 */
export function resolveWorkStartedAt(cards: KanbanCard[], work: Work): string {
  let earliest: string | undefined;
  for (const link of work.sessionLinks) {
    const candidate = resolveSessionStartedAt(cards, link.sessionId) ?? link.linkedAt;
    if (!candidate) continue;
    if (!earliest || candidate < earliest) earliest = candidate;
  }
  return earliest ?? work.startedAt;
}

/**
 * The single entry point behind every path that changes a Work's link set —
 * link, unlink, move, prune — so the four can never drift apart.
 *
 * It is a **resolver over a card snapshot**, not a pre-computed date, and the
 * store runs it inside its own lock against the link set the write just
 * produced. Two things follow, and both were bugs before:
 *
 * - No TOCTOU. The route used to project the pending change onto the links it
 *   had read and resolve `min()` there; two links racing each other therefore
 *   each computed a start that had never seen the other session, and the second
 *   write won. Now both resolve against the persisted link set.
 * - No projected `linkedAt`. The old projection invented `linkedAt: now` for the
 *   incoming link; the resolver sees the real one the store wrote.
 *
 * The snapshot is read **once per request** (`getCards({ includeArchived: true })`
 * is a full-archive scan) and shared by every link in a batch — a 20-session
 * assignment used to run 20+ of those scans.
 */
export function createWorkStartedAtResolver(cards: KanbanCard[]): WorkStartedAtResolver {
  return (work: Work) => resolveWorkStartedAt(cards, work);
}

/**
 * Reads the archive-inclusive card snapshot every link-set change needs and
 * wraps it in `createWorkStartedAtResolver`. Callers that already hold a
 * snapshot must reuse it instead of calling this again.
 */
export async function loadWorkStartedAtResolver(
  store: KanbanStore,
): Promise<WorkStartedAtResolver> {
  return createWorkStartedAtResolver(await store.getCards({ includeArchived: true }));
}

const ZERO_BY_STATUS: Record<KanbanStatus, number> = {
  todo: 0,
  in_progress: 0,
  complete: 0,
  done: 0,
};

/**
 * What completing this Work would destroy, for the confirmation dialog.
 *
 * Pure: the caller supplies the archive-inclusive card set (the same monthly
 * reads `GET /api/works/:id/sessions` uses) and the running-card verdict, so the
 * copy the user reads is computed by one testable function rather than by the
 * dialog.
 */
export function buildWorkCompletionPreview(
  work: Work,
  cards: KanbanCard[],
  opts: { conflictingCardIds?: string[]; archivedCardIds: Set<string>; runningCardIds: string[]; scannedMonths: string[] },
): WorkCompletionPreview {
  // A card can show up in both the live board and an archive month when the
  // sweep raced the read; count it once, the way `buildWorkSessionsResponse`
  // does. The live copy comes first in `cards`, so first-wins keeps its status.
  const owned = new Map<string, KanbanCard>();
  for (const card of [...selectWorkCards(cards, work), ...selectWorkSweepCards(cards, work)]) {
    if (!owned.has(card.id)) owned.set(card.id, card);
  }
  const byStatus = { ...ZERO_BY_STATUS };
  const favoriteCardIds: string[] = [];
  let sweepCardCount = 0;
  for (const card of owned.values()) {
    byStatus[card.status] += 1;
    if (opts.archivedCardIds.has(card.id)) continue;
    // Favorites are counted out of the sweep here for the same reason
    // `applyWorkPatch` skips them: the dialog must promise exactly what the
    // sweep will do, and a starred card stays on the board.
    if (card.favorite) favoriteCardIds.push(card.id);
    else sweepCardCount += 1;
  }
  const titleById = new Map([...owned.values()].map(card => [card.id, card.title]));
  return {
    workId: work.id,
    conflictingCardIds: opts.conflictingCardIds ?? [],
    cardCount: owned.size,
    byStatus,
    sweepCardCount,
    favoriteCardIds,
    runningCardIds: opts.runningCardIds,
    runningCardTitles: opts.runningCardIds.map(id => titleById.get(id) ?? id),
    sessionCount: work.sessionLinks.length,
    alreadyArchived: work.archivedAt !== undefined,
    scannedMonths: opts.scannedMonths,
  };
}

/**
 * Apply a `PATCH /api/works/:id` update, layering the completion lifecycle on
 * top of the plain store write:
 *
 * - `status: 'done'` → every card of every linked session is flipped `done` and
 *   handed to `store.archiveCards()`, which stamps `wiki.status = 'pending'` on
 *   the wiki-eligible ones (top-level cards only) and cascades the archive to
 *   each card's subtree.
 * - **A card with a live agent run blocks the whole transition** (`409` via
 *   `WorkCardsRunningError`). Archiving a card out from under a running runtime
 *   makes its completion hook fail with `Card not found` and hands the wiki an
 *   unfinished transcript, so bulk-closing a Work must not be able to do it.
 * - `works.done_confirm` on → the destructive sweep only runs when the client
 *   re-sends the transition with `confirmArchive: true`; otherwise the status
 *   transition is recorded and the sweep is deferred (`awaiting-confirmation`).
 *   A Work already parked in that state finishes on a **confirmation-only**
 *   patch (`{ confirmArchive: true }` with no `status`), which used to be
 *   classified `not-a-completion` and could therefore never be swept at all.
 * - **Favorited top-level cards are left on the board** and reported as
 *   `keptFavoriteCardIds`. `favorite` is an explicit "keep this visible"; the
 *   cascade in `store.archiveCards` already respects it for descendants, and the
 *   Work sweep is the only caller that supplied its own seeds and so skipped the
 *   check. A Work whose board cards are *all* favorited ends
 *   `archiveSkipped='favorites-only'`, un-stamped and completable again later.
 * - `status: 'discarded'` → status/`resolvedAt`/`resolution` only. Cards stay on
 *   the board and keep their ordinary wiki flow: `WikiWorker` drops the Work
 *   from its grouping index, so those sessions fall back to per-session
 *   grouping. Discarding is a Work state, never a card's wiki state.
 *
 * The sweep is claimed atomically (`WorkStore.claimArchiveSweep`) so two
 * concurrent `done` patches archive exactly once, and each card write is settled
 * independently so one vanished card reports itself instead of collapsing the
 * whole patch into an error. A sweep that archives nothing rolls its own stamp
 * back, leaving the Work retryable rather than advertising an archive that did
 * not happen. Card flips go through `store.updateCard` (a plain store write), so
 * completing a Work never triggers queue auto-dispatch — bulk-closing finished
 * work must not start new agent runs.
 */
export async function applyWorkPatch(deps: {
  store: KanbanStore;
  workStore: WorkStore;
  workId: string;
  updates: UpdateWorkInput;
  /** `works.done_confirm` — require an explicit confirmation before archiving. */
  doneConfirm: boolean;
  /** Route-only flag from the client's confirmation dialog. */
  confirmArchive?: boolean;
  /**
   * Live-run lookup. Omitted means "cannot tell" and the guard is skipped — the
   * server always wires it; only pure unit tests leave it out.
   */
  activeRunProbe?: ActiveRunProbe;
}): Promise<WorkTransitionResult> {
  const { store, workStore, workId, updates } = deps;

  const current = await workStore.getWork(workId);
  if (!current) {
    throw new WorkNotFoundError(workId);
  }

  const skipped = async (
    reason: WorkArchiveSkipReason,
    keptFavoriteCardIds: string[] = [],
  ): Promise<WorkTransitionResult> => ({
    work: await workStore.updateWork(workId, updates),
    completedCardIds: [],
    archiveSeedIds: [],
    archivedCount: 0,
    failedCards: [],
    keptFavoriteCardIds,
    archiveSkipped: reason,
  });

  if (!isCompletionPatch(current, updates, deps)) return skipped('not-a-completion');
  // Cheap pre-check; `claimArchiveSweep` below is what actually makes this
  // decision atomic against a concurrent patch.
  if (current.archivedAt) return skipped('already-archived');

  const active = await store.getCards();
  const owned = selectWorkCards(active, current);
  // `favorite` means "pin this card to the board". `store.archiveCards` already
  // honours it for every descendant it cascades to, but the Work sweep hands in
  // its top-level cards as explicit seeds — the one path that walked straight
  // past the pin and archived a starred card out from under the user. Pruned
  // here rather than in the store so `POST /api/archive` keeps its behaviour.
  const seeds = selectWorkSweepCards(active, current);
  const keptFavoriteCardIds = owned.filter(card => card.favorite).map(card => card.id);

  // Refuse before touching anything: this is a rejection of the transition, not
  // a partial completion, so the Work must not even record `done`.
  await assertSweepSafe(seeds, current, workStore, deps.activeRunProbe);

  if (deps.doneConfirm && deps.confirmArchive !== true) return skipped('awaiting-confirmation');

  if (seeds.length === 0) {
    // Never call archiveCards([]) — an empty id list means "sweep every done
    // card on the board", which would archive cards that belong to no Work at
    // all. Left un-stamped on purpose: a Work whose sessions have not produced
    // cards yet stays completable later — and so does one whose only board
    // cards are pinned, which is a different fact and gets its own reason.
    return keptFavoriteCardIds.length > 0
      ? skipped('favorites-only', keptFavoriteCardIds)
      : skipped('no-cards');
  }

  // Persist late child sessions before queuing the document, so reopening and
  // reviewing the completed Work can still find every card in the sweep.
  const linked = new Set(current.sessionLinks.map(link => link.sessionId));
  const resolver = createWorkStartedAtResolver(active);
  for (const card of seeds) {
    if (card.sessionId && !linked.has(card.sessionId)) {
      await workStore.addSession(workId, { sessionId: card.sessionId, projectDir: card.projectDir }, resolver);
      linked.add(card.sessionId);
    }
  }

  // Atomic claim: the loser of a concurrent `done` race stops here instead of
  // sweeping a board the winner has already emptied.
  const claimed = await workStore.claimArchiveSweep(workId, updates);
  if (!claimed) return skipped('already-archived', keptFavoriteCardIds);

  const completedCardIds: string[] = [];
  const failedCards: WorkSweepFailure[] = [];
  const flips = await Promise.allSettled(
    seeds.map(async (card) => {
      if (card.status === 'done') return card.id;
      await store.updateCard(card.id, { status: 'done' });
      completedCardIds.push(card.id);
      return card.id;
    }),
  );

  const archiveSeedIds: string[] = [];
  flips.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      archiveSeedIds.push(outcome.value);
      return;
    }
    const reason = outcome.reason;
    failedCards.push({
      cardId: seeds[index].id,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  let archivedCount = 0;
  let archiveMonth: string | undefined;
  if (archiveSeedIds.length > 0) {
    try {
      const result = await store.archiveCards(archiveSeedIds, {
        beforeArchive: async cards => {
          // A newly-created descendant was not in the confirmed sweep. Leave
          // the board intact and report a retryable batch failure.
          const known = new Set(archiveSeedIds);
          if (cards.some(card => !known.has(card.id) || card.favorite)) {
            throw new Error('보관 대상이 변경되었습니다. 완료 범위를 다시 확인해 주세요.');
          }
          await assertSweepSafe(cards, current, workStore, deps.activeRunProbe);
        },
      });
      archivedCount = result.archivedCount;
      archiveMonth = result.archiveMonth;
    } catch (e: unknown) {
      // One failure for the batch: the archive write is a single store call.
      const message = e instanceof Error ? e.message : String(e);
      for (const cardId of archiveSeedIds) failedCards.push({ cardId, message });
    }
  }

  // Nothing landed → do not advertise an archive that did not happen. Rolling
  // the claim back restores exactly the retryable Work the pre-claim ordering
  // used to leave behind.
  const work = archivedCount === 0 && failedCards.length > 0
    ? await workStore.updateWork(workId, { archivedAt: null })
    : claimed;

  return {
    work,
    completedCardIds,
    archiveSeedIds,
    archivedCount,
    archiveMonth,
    failedCards,
    keptFavoriteCardIds,
  };
}

/**
 * Is this patch the completion transition (i.e. does the bulk sweep apply)?
 *
 * Two shapes count. The obvious one is `status: 'done'`. The second is a
 * **confirmation-only** patch against a Work that is already `done` with its
 * sweep deferred: `works.done_confirm` records the transition first and waits
 * for `confirmArchive`, and a client that then sends only the flag has to be
 * able to finish the job. Without this the deferred state was a dead end — the
 * Work was `done` forever with its cards never archived.
 */
function isCompletionPatch(
  current: Work,
  updates: UpdateWorkInput,
  opts: { confirmArchive?: boolean },
): boolean {
  if (updates.status === 'done') return true;
  if (updates.status !== undefined) return false;
  return current.status === 'done' && !current.archivedAt && opts.confirmArchive === true;
}

/**
 * Put a terminal Work back to `active`, restoring the cards its completion
 * swept into the archive.
 *
 * Completion used to be a one-way door. `PATCH /api/works/:id` already accepted
 * `status: 'active'` (and cleared `resolvedAt`/`resolution`), but no UI sent it,
 * and on its own it would not have been enough: the bulk-archived cards stayed
 * in the monthly files and `archivedAt` stayed stamped, so the Work could never
 * be swept again either. The only escape was `DELETE`, which threw the record,
 * its Summary and its Timeline history away with it.
 *
 * So a reopen is three things in one verb:
 *
 * 1. `status: 'active'` with `resolvedAt` / `resolution` cleared (the store's
 *    existing re-open rule) **and `archivedAt: null`** — a Work back in progress
 *    has no archive to be idempotent about, and leaving the stamp would also
 *    keep the session-move gate (`assertMovable`) closed forever.
 * 2. The archived cards under its sessions lifted back onto the board
 *    (`store.unarchiveCards`), read through the same month-bounded heuristic as
 *    every other Works read — never `store.loadArchives()`.
 * 3. Nothing else. The card restore is a plain store write, so **reopening never
 *    triggers queue auto-dispatch**: re-opening finished work must not start new
 *    agent runs, for the same reason completing it must not.
 *
 * `409` (`WorkAlreadyActiveError`) for a Work that is already `active`: there is
 * nothing to reopen, and answering `200` would let a stale dialog report a
 * restore that never happened.
 */
export async function reopenWork(deps: {
  store: KanbanStore;
  workStore: WorkStore;
  workId: string;
}): Promise<WorkReopenResponse> {
  const { store, workStore, workId } = deps;

  const current = await workStore.getWork(workId);
  if (!current) throw new WorkNotFoundError(workId);
  if (current.status === 'active') throw new WorkAlreadyActiveError(current.title);

  // Which archived cards belong to this Work, over the months it can reach.
  const scannedMonths = timelineArchiveMonths(
    store.listArchiveMonths(),
    workCardScanFloor(current),
  );
  const archivedIds: string[] = [];
  for (const month of scannedMonths) {
    const archive = await store.loadArchiveMonth(month);
    if (!archive) continue;
    for (const card of selectWorkCards(archive.cards, current)) {
      archivedIds.push(card.id);
    }
  }

  // Cards first, status second: a failed restore must not leave an `active` Work
  // whose cards are still in the archive, because the next completion would then
  // report `no-cards` and the board would never get them back.
  const restored = archivedIds.length > 0
    ? await store.unarchiveCards(archivedIds, { months: scannedMonths })
    : { restoredCardIds: [], scannedMonths };

  const work = await workStore.updateWork(workId, {
    status: 'active',
    archivedAt: null,
    // `supersededByWorkId` is the record of a merge, and reopening the source of
    // one is how that merge is undone at the Work level — the pointer would
    // otherwise claim an active Work had been replaced.
    supersededByWorkId: null,
  });

  return { work, restoredCardIds: restored.restoredCardIds, scannedMonths };
}
