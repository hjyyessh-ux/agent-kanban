import type { KanbanCard } from './types';

/**
 * Which sessions *continue* one another, keyed by `sessionId`.
 *
 * Works triage needs more than "same directory" to recommend a target: the
 * strongest evidence that two sessions belong to one Work is that one of them
 * was spawned from the other. Three card fields carry that lineage, and all
 * three are recorded here:
 *
 * - `parentCardId` — a subagent card running under a parent card's session
 * - `queuedAfterCardId` — a queue chain (only a real cross-session link when the
 *   queued card opened a `new_session`; continuing the previous session leaves
 *   both cards on one `sessionId`, which self-links and is dropped)
 * - `resumeSessionId` — the session a card was told to resume, when the card
 *   nonetheless ended up on a different one
 *
 * The map is **symmetric** — both endpoints list each other — because triage
 * asks the question from whichever side happens to be unassigned. Self-links
 * and links to cards with no session are dropped, so a session that continues
 * nothing simply has no entry.
 *
 * Pure over the card list, and it must be fed **archived cards too**: the
 * sessions waiting in the Inbox have usually already finished.
 */
export function buildSessionChainMap(cards: KanbanCard[]): Map<string, string[]> {
  const sessionOfCard = new Map<string, string>();
  for (const card of cards) {
    if (card.sessionId) sessionOfCard.set(card.id, card.sessionId);
  }

  const related = new Map<string, Set<string>>();
  const link = (a: string | undefined, b: string | undefined): void => {
    if (!a || !b || a === b) return;
    const forward = related.get(a) ?? new Set<string>();
    forward.add(b);
    related.set(a, forward);
    const backward = related.get(b) ?? new Set<string>();
    backward.add(a);
    related.set(b, backward);
  };

  for (const card of cards) {
    if (!card.sessionId) continue;
    if (card.parentCardId) link(card.sessionId, sessionOfCard.get(card.parentCardId));
    if (card.queuedAfterCardId) link(card.sessionId, sessionOfCard.get(card.queuedAfterCardId));
    if (card.resumeSessionId) link(card.sessionId, card.resumeSessionId);
  }

  return new Map(
    Array.from(related, ([sessionId, peers]) => [sessionId, Array.from(peers).sort()]),
  );
}

/**
 * Which sessions ran *under* which, following `parentCardId` alone.
 *
 * This is the subset of `buildSessionChainMap` that has a direction. A subagent
 * card carries `parentCardId`; if that parent card lives on a different session,
 * the subagent's session is a **child** of the parent's. Queue chains and
 * `resumeSessionId` are deliberately excluded — a queued follow-up is a sibling
 * decision the user still gets to make, whereas a subagent session is not a
 * separate piece of work at all: it exists only because the parent spawned it.
 *
 * That asymmetry is what lets Works inherit: linking a parent session to a Work
 * links its subagent sessions too, and an unlinked subagent session whose parent
 * is already assigned is hidden from the Inbox instead of asking the user a
 * question they already answered.
 *
 * A child session with several candidate parents (its cards were spawned from
 * two different sessions) takes the lexicographically smallest, so the tree is
 * the same no matter what order the cards arrive in. Must be fed **archived
 * cards too**, for the same reason `buildSessionChainMap` must.
 */
export interface SubagentSessionTree {
  /** Child session → the session it ran as a subagent of. */
  parentOf: ReadonlyMap<string, string>;
  /** Parent session → its subagent sessions, sorted. */
  childrenOf: ReadonlyMap<string, string[]>;
}

export function buildSubagentSessionTree(cards: KanbanCard[]): SubagentSessionTree {
  const sessionOfCard = new Map<string, string>();
  for (const card of cards) {
    if (card.sessionId) sessionOfCard.set(card.id, card.sessionId);
  }

  const candidateParents = new Map<string, Set<string>>();
  for (const card of cards) {
    if (!card.sessionId || !card.parentCardId) continue;
    const parentSession = sessionOfCard.get(card.parentCardId);
    if (!parentSession || parentSession === card.sessionId) continue;
    const bucket = candidateParents.get(card.sessionId) ?? new Set<string>();
    bucket.add(parentSession);
    candidateParents.set(card.sessionId, bucket);
  }

  const parentOf = new Map<string, string>();
  for (const [child, parents] of candidateParents) {
    const chosen = Array.from(parents).sort()[0];
    if (chosen) parentOf.set(child, chosen);
  }

  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(child);
    else childrenOf.set(parent, [child]);
  }
  for (const bucket of childrenOf.values()) bucket.sort();

  return { parentOf, childrenOf };
}

/**
 * The sessions `sessionId` ran under, nearest parent first.
 *
 * Used to decide whether an Inbox row is redundant: if *any* ancestor is already
 * linked to a Work, the subagent belongs to that Work's story even when the
 * nearest parent happens to be unassigned. Cycles (which a corrupted
 * `parentCardId` could produce) terminate on the visited set.
 */
export function subagentAncestorSessions(
  tree: SubagentSessionTree,
  sessionId: string,
): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([sessionId]);
  let current = tree.parentOf.get(sessionId);
  while (current && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = tree.parentOf.get(current);
  }
  return ancestors;
}

/**
 * Every session that ran under `sessionId`, transitively — what linking a parent
 * session to a Work must carry with it. Excludes the root, sorted, cycle-safe.
 */
export function subagentDescendantSessions(
  tree: SubagentSessionTree,
  sessionId: string,
): string[] {
  const found = new Set<string>();
  const queue = [sessionId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of tree.childrenOf.get(current) ?? []) {
      if (child === sessionId || found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return Array.from(found).sort();
}
