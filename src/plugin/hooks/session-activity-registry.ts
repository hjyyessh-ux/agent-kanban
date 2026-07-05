const activeSessionsSeen = new Set<string>();

export function markSessionActive(sessionID: string): void {
  activeSessionsSeen.add(sessionID);
}

export function hasSeenSessionActivity(sessionID: string): boolean {
  return activeSessionsSeen.has(sessionID);
}

export function clearSeenSessionActivity(sessionID: string): void {
  activeSessionsSeen.delete(sessionID);
}

export function resetObservedActiveSessions(): void {
  activeSessionsSeen.clear();
}
