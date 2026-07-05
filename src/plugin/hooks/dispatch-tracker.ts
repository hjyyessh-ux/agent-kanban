/**
 * In-memory tracker for dispatched sessions.
 *
 * When dispatchCard() creates a new opencode session and sends promptAsync(),
 * the chat.message hook fires for that session. Without this tracker, the hook
 * would create a duplicate card because:
 *   1. The store.updateCard(sessionId) may not be visible to store.getCards() yet
 *   2. The first hook invocation arrives with agent=undefined (session setup)
 *
 * This module provides a synchronous, race-free check:
 *   - dispatchCard() calls trackDispatch(sessionId, cardId) BEFORE promptAsync()
 *   - chat.message hook calls consumeDispatch(sessionId) — if truthy, skip creation
 *
 * Entries auto-expire after TTL_MS to prevent memory leaks from abandoned dispatches.
 */

interface DispatchEntry {
  cardId: string;
  promptText: string;
  timestamp: number;
}

const dispatchMap = new Map<string, DispatchEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record that a session was created via dispatch for an existing card.
 * Must be called BEFORE promptAsync() to ensure the hook sees it.
 */
export function trackDispatch(sessionId: string, cardId: string, promptText: string): void {
  cleanup();
  dispatchMap.set(sessionId, { cardId, promptText, timestamp: Date.now() });
}

/**
 * Check if a session was dispatched. Returns the cardId if found.
 * Does NOT consume — dispatched sessions may receive multiple hook
 * invocations (agent=undefined, then actual agent), all should be skipped.
 */
export function isDispatched(sessionId: string): string | undefined {
  cleanup();
  const entry = dispatchMap.get(sessionId);
  if (!entry) return undefined;
  return entry.cardId;
}

export function matchesDispatchedPrompt(sessionId: string, promptText: string): string | undefined {
  cleanup();
  const entry = dispatchMap.get(sessionId);
  if (!entry) return undefined;
  return entry.promptText === promptText ? entry.cardId : undefined;
}

/**
 * Remove a dispatch entry. Call after the session is fully established
 * and the store-based dedup is reliable (card has sessionId persisted).
 */
export function clearDispatch(sessionId: string): void {
  dispatchMap.delete(sessionId);
}

/**
 * Remove entries older than TTL_MS to prevent memory leaks.
 */
function cleanup(): void {
  const now = Date.now();
  for (const [key, val] of dispatchMap) {
    if (now - val.timestamp > TTL_MS) {
      dispatchMap.delete(key);
    }
  }
}

// Exported for testing only
export const _testing = { dispatchMap, TTL_MS };
