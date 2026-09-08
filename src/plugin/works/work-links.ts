import type { KanbanStore } from '../../core/store';
import type { WorkStore } from '../../core/work-store';
import type { KanbanCard, Work, WorkLinkReconcileReport } from '../../core/types';
import { timelineArchiveMonths, workCardScanFloor } from '../../core/timeline-aggregate';

/**
 * Dangling `WorkSessionLink` detection — the counterpart to card deletion.
 *
 * Deleting a card never touched Works, so a session whose every card was
 * deleted stayed linked forever. That is not cosmetic: `resolveWorkStartedAt`
 * falls back to a link's `linkedAt` when its session has no cards, so the
 * Timeline bar silently starts at *triage time* instead of when the work began,
 * and the Work detail dialog offers a 대화 link into a session that is gone.
 *
 * The link is **stamped, not removed**. Card deletion is a soft delete that
 * `store.restoreCard` reverses, so dropping the link would turn an undo-able
 * action into an unrecoverable one (the session would fall out of the Inbox
 * too — the Inbox filters out sessions with no cards). Removal is a separate,
 * explicit step: `WorkStore.pruneMissingSessions`.
 */

/** Which sessions of `work` still have at least one live or archived card. */
export function partitionLinksByCardPresence(
  work: Work,
  cards: KanbanCard[],
): { present: string[]; missing: string[] } {
  const linked = new Set(work.sessionLinks.map(link => link.sessionId));
  const withCards = new Set<string>();
  for (const card of cards) {
    if (card.deletedAt) continue;
    if (!card.sessionId || !linked.has(card.sessionId)) continue;
    withCards.add(card.sessionId);
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const sessionId of linked) {
    if (withCards.has(sessionId)) present.push(sessionId);
    else missing.push(sessionId);
  }
  return { present, missing };
}

/**
 * Every card a Work can reach: the live board plus the archive months
 * `workCardScanFloor` says it could have been filed under.
 *
 * Deliberately the same bounded read `GET /api/works/:id/sessions` and
 * `/api/timeline` use, **not** `store.loadArchives()` — the full scan belongs to
 * the wiki and Telegram paths and must not be pulled into a per-Work check that
 * can run once per card deletion.
 */
async function readWorkReachableCards(store: KanbanStore, work: Work): Promise<KanbanCard[]> {
  const months = timelineArchiveMonths(store.listArchiveMonths(), workCardScanFloor(work));
  const cards: KanbanCard[] = [...await store.getCards({})];
  for (const month of months) {
    const archive = await store.loadArchiveMonth(month);
    if (!archive) continue;
    cards.push(...archive.cards);
  }
  return cards;
}

/**
 * Stamp / clear `cardsMissingAt` across Works.
 *
 * Idempotent: the verdict is derived from the cards every time, so a second run
 * over unchanged data reports zero marked and zero cleared. Runs in three
 * places — once at boot (historical data that predates the stamp), after a card
 * delete or restore (`workIds` narrowed to the affected Work), and on demand via
 * `POST /api/works/reconcile-links`.
 *
 * `discarded` and already-archived Works are inspected too: a dangling link
 * distorts their Timeline bar exactly as much as an active one's.
 */
export async function reconcileWorkSessionLinks(deps: {
  store: KanbanStore;
  workStore: WorkStore;
  /** Restrict the pass to these Works. Omitted means every Work. */
  workIds?: readonly string[];
}): Promise<WorkLinkReconcileReport> {
  const { store, workStore } = deps;
  const only = deps.workIds ? new Set(deps.workIds) : undefined;
  const { works } = await workStore.load();
  const report: WorkLinkReconcileReport = { scanned: 0, marked: [], cleared: [] };

  for (const work of works) {
    if (only && !only.has(work.id)) continue;
    if (work.sessionLinks.length === 0) {
      report.scanned += 1;
      continue;
    }
    report.scanned += 1;
    const cards = await readWorkReachableCards(store, work);
    const { present, missing } = partitionLinksByCardPresence(work, cards);
    const changed = await workStore.applyLinkCardPresence(work.id, { present, missing });
    if (changed.marked.length > 0) {
      report.marked.push({ workId: work.id, sessionIds: changed.marked });
    }
    if (changed.cleared.length > 0) {
      report.cleared.push({ workId: work.id, sessionIds: changed.cleared });
    }
  }

  return report;
}

/**
 * The Work that owns `sessionId`, or `null`. Used by the card delete/restore
 * routes to narrow the reconcile pass to the one Work that can have changed.
 */
export async function findWorkOwningSession(
  workStore: WorkStore,
  sessionId: string,
): Promise<Work | null> {
  const { works } = await workStore.load();
  return works.find(w => w.sessionLinks.some(l => l.sessionId === sessionId)) ?? null;
}
