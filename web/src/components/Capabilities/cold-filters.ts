import type { ColdEntryView } from '../../../../src/core/types';
import { matchesRuntime, type CapabilityRuntimeFilter } from './capability-filters';

export type ColdKindFilter = 'all' | 'skill' | 'mcp';

export function matchesColdSearch(entry: ColdEntryView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    entry.ref,
    entry.summary,
    entry.runtime,
    entry.sourceScope,
    entry.sourcePath,
    entry.projectRoot,
    entry.originalConfigJson,
  ].some((field) => field?.toLowerCase().includes(q));
}

export function filterColdEntries(
  entries: ColdEntryView[],
  filters: { search: string; kind: ColdKindFilter; runtime: CapabilityRuntimeFilter },
): ColdEntryView[] {
  return entries.filter((entry) => {
    if (filters.kind !== 'all' && entry.kind !== filters.kind) return false;
    if (!matchesRuntime(entry.runtime ?? null, filters.runtime)) return false;
    return matchesColdSearch(entry, filters.search);
  });
}

export function coldKindCounts(entries: ColdEntryView[]): Record<ColdKindFilter, number> {
  return {
    all: entries.length,
    skill: entries.filter((e) => e.kind === 'skill').length,
    mcp: entries.filter((e) => e.kind === 'mcp').length,
  };
}

export function coldRuntimeCounts(
  entries: ColdEntryView[],
): Record<CapabilityRuntimeFilter, number> {
  return {
    all: entries.length,
    claude: entries.filter((e) => e.runtime === 'claude').length,
    codex: entries.filter((e) => e.runtime === 'codex').length,
    opencode: entries.filter((e) => e.runtime === 'opencode').length,
  };
}
