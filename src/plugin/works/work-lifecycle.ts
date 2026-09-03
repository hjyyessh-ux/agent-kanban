import type { KanbanStore } from '../../core/store';
import type { WorkStore } from '../../core/work-store';
import type { KanbanCard, UpdateWorkInput, Work } from '../../core/types';

/** Why the bulk done→archive sweep did not run for a `PATCH` call. */
export type WorkArchiveSkipReason =
  | 'not-a-completion'      // status was not transitioning to `done`
  | 'already-archived'      // this Work's cards were archived by an earlier call
  | 'awaiting-confirmation' // works.done_confirm is on and the client has not confirmed
  | 'no-cards';             // nothing active left to sweep (already archived / no sessions)

export interface WorkTransitionResult {
  work: Work;
  /** Cards this call flipped to `done` (they were `todo`/`in_progress`/`complete`). */
  completedCardIds: string[];
  /** Cards handed to `store.archiveCards()` as archive seeds. */
  archiveSeedIds: string[];
  archivedCount: number;
  archiveMonth?: string;
  archiveSkipped?: WorkArchiveSkipReason;
}

/** Cards belonging to any session linked to `work`, in board order. */
export function selectWorkCards(cards: KanbanCard[], work: Work): KanbanCard[] {
  const sessionIds = new Set(work.sessionLinks.map(l => l.sessionId));
  if (sessionIds.size === 0) return [];
  return cards.filter(c => c.sessionId !== undefined && sessionIds.has(c.sessionId));
}

/**
 * Earliest `startedAt` among a session's cards — the Work's `startedAt` on its
 * first link. Falls back to `createdAt` for cards that never dispatched, and to
 * `undefined` when the session has no cards at all (caller then uses link time).
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
 * Apply a `PATCH /api/works/:id` update, layering the completion lifecycle on
 * top of the plain store write:
 *
 * - `status: 'done'` → every card of every linked session is flipped `done` and
 *   handed to `store.archiveCards()`, which stamps `wiki.status = 'pending'` on
 *   the wiki-eligible ones (top-level cards only) and cascades the archive to
 *   each card's subtree. The Work is then stamped `archivedAt`.
 * - `works.done_confirm` on → the destructive sweep only runs when the client
 *   re-sends the transition with `confirmArchive: true`; otherwise the status
 *   transition is recorded and the sweep is deferred (`awaiting-confirmation`).
 * - `status: 'discarded'` → status/`resolvedAt`/`resolution` only. Cards stay on
 *   the board and never enter the wiki pipeline (`WikiWorker` skips cards whose
 *   session belongs to a discarded Work).
 *
 * The card sweep runs *before* the Work is stamped so a failed sweep cannot
 * leave a Work advertising an archive that did not happen. Card flips go through
 * `store.updateCard` (a plain store write), so completing a Work never triggers
 * queue auto-dispatch — bulk-closing finished work must not start new agent runs.
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
}): Promise<WorkTransitionResult> {
  const { store, workStore, workId, updates } = deps;

  const current = await workStore.getWork(workId);
  if (!current) {
    throw new Error(`Work not found: ${workId}`);
  }

  const skipReason = resolveSkipReason(current, updates, deps);
  if (skipReason) {
    return {
      work: await workStore.updateWork(workId, updates),
      completedCardIds: [],
      archiveSeedIds: [],
      archivedCount: 0,
      archiveSkipped: skipReason,
    };
  }

  const active = await store.getCards();
  const seeds = selectWorkCards(active, current);
  if (seeds.length === 0) {
    return {
      work: await workStore.updateWork(workId, updates),
      completedCardIds: [],
      archiveSeedIds: [],
      archivedCount: 0,
      archiveSkipped: 'no-cards',
    };
  }

  const completedCardIds: string[] = [];
  for (const card of seeds) {
    if (card.status === 'done') continue;
    await store.updateCard(card.id, { status: 'done' });
    completedCardIds.push(card.id);
  }

  const archiveSeedIds = seeds.map(c => c.id);
  // Never call archiveCards([]) — an empty id list means "sweep every done card
  // on the board", which would archive cards that belong to no Work at all.
  const { archivedCount, archiveMonth } = await store.archiveCards(archiveSeedIds);

  const work = await workStore.updateWork(workId, {
    ...updates,
    archivedAt: new Date().toISOString(),
  });

  return { work, completedCardIds, archiveSeedIds, archivedCount, archiveMonth };
}

/** Decide whether the bulk sweep is in scope for this patch (undefined = run it). */
function resolveSkipReason(
  current: Work,
  updates: UpdateWorkInput,
  opts: { doneConfirm: boolean; confirmArchive?: boolean },
): WorkArchiveSkipReason | undefined {
  if (updates.status !== 'done') return 'not-a-completion';
  // Idempotent: a repeated `done` patch must not re-sweep. A Work left `done`
  // with the sweep deferred still has no `archivedAt`, so a later confirmation
  // can still run it.
  if (current.archivedAt) return 'already-archived';
  if (opts.doneConfirm && opts.confirmArchive !== true) return 'awaiting-confirmation';
  return undefined;
}
