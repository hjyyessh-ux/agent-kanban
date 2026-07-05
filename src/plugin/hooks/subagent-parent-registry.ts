interface SubagentParentEntry {
  parentCardId: string;
  rootCardId: string;
  parentSessionId: string;
  agentType?: string;
  timestamp: number;
}

const registry = new Map<string, SubagentParentEntry>();
const TTL_MS = 30 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [sessionId, entry] of registry.entries()) {
    if (now - entry.timestamp > TTL_MS) {
      registry.delete(sessionId);
    }
  }
}

export function registerSubagentParent(
  childSessionId: string,
  entry: Omit<SubagentParentEntry, 'timestamp'>,
): void {
  cleanup();
  registry.set(childSessionId, {
    ...entry,
    timestamp: Date.now(),
  });
}

export function getSubagentParent(sessionId: string): SubagentParentEntry | undefined {
  cleanup();
  return registry.get(sessionId);
}

export function clearSubagentParent(sessionId: string): void {
  registry.delete(sessionId);
}

export const _testing = { registry, TTL_MS };
