import type { KanbanCard } from '../../core/types';
import type { KanbanStore, SessionAssignedHook } from '../../core/store';
import type { WorkStore } from '../../core/work-store';
import { loadWorkStartedAtResolver } from './work-lifecycle';

/**
 * Wires `KanbanStore`'s session-assigned hook to Works: a TODO card reserved
 * for a Work before it had a `sessionId` (`card.plannedWorkId`, set by the
 * board's `Work 지정…` picker — see `docs/mockups/todo-work-assign.html`) is
 * linked the moment dispatch gives it a real session, turning the reservation
 * into an ordinary `WorkSessionLink`. The reservation field is cleared either
 * way, so a stale pointer never lingers on the card.
 *
 * Called by `KanbanStore` **after** the write that set the sessionId has
 * released its lock (see `SessionAssignedHook`), so taking `WorkStore`'s own
 * lock here is safe — this is not reentrant into the caller's lock.
 *
 * A reserved Work that closed or was deleted before dispatch is not an error:
 * the picker only ever offers active Works, so a closed one here is a race,
 * not a mistake worth surfacing. The reservation is simply dropped and the
 * card starts unassigned, same as if it had never been reserved.
 */
export function createPlannedWorkLinker(store: KanbanStore, workStore: WorkStore): SessionAssignedHook {
  return async function linkPlannedWork(card: KanbanCard): Promise<void> {
    const workId = card.plannedWorkId;
    if (!workId || !card.sessionId) return;

    try {
      const work = await workStore.getWork(workId);
      if (work && work.status === 'active') {
        const resolveStartedAt = await loadWorkStartedAtResolver(store);
        await workStore.addSession(
          workId,
          { sessionId: card.sessionId, projectDir: card.projectDir },
          resolveStartedAt,
        );
      }
    } catch {
      // Best-effort — e.g. the session somehow already belongs to another
      // Work by the time dispatch resolved. The card just stays unassigned;
      // nothing here is worth failing dispatch over.
    }

    // Consumed whether the link succeeded, the Work had closed, or it no
    // longer exists — a reservation is one-shot.
    await store.updateCard(card.id, { plannedWorkId: null });
  };
}
