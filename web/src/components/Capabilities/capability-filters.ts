import type {
  CapabilityItem,
  DiscoveredSkill,
  McpInventoryItem,
  SkillRuntime,
  SkillVisibility,
} from '../../../../src/core/types';

export type CapabilityRuntimeFilter = 'all' | SkillRuntime;

export const CAPABILITY_RUNTIME_FILTERS: CapabilityRuntimeFilter[] = [
  'all', 'claude', 'codex', 'opencode',
];

export function runtimeLabel(runtime: CapabilityRuntimeFilter): string {
  if (runtime === 'all') return 'All';
  if (runtime === 'opencode') return 'OpenCode';
  return runtime[0].toUpperCase() + runtime.slice(1);
}

export function inventoryRuntimeCounts(
  mcp: McpInventoryItem[],
  skills: Array<DiscoveredSkill & SkillVisibility>,
): Record<CapabilityRuntimeFilter, number> {
  return {
    all: mcp.length + skills.length,
    claude: mcp.filter((item) => item.runtime === 'claude').length +
      skills.filter((item) => item.runtime === 'claude').length,
    codex: mcp.filter((item) => item.runtime === 'codex').length +
      skills.filter((item) => item.runtime === 'codex').length,
    opencode: skills.filter((item) => item.runtime === 'opencode').length,
  };
}

export function matchesRuntime(
  runtime: SkillRuntime | null,
  filter: CapabilityRuntimeFilter,
): boolean {
  return filter === 'all' || runtime === filter;
}

export function filterNameFirst<T>(
  items: T[],
  query: string,
  nameOf: (item: T) => string,
  secondaryTextOf: (item: T) => string[],
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;

  const nameMatches = items.filter((item) => nameOf(item).toLowerCase().includes(normalized));
  if (nameMatches.length > 0) return nameMatches;

  return items.filter((item) =>
    secondaryTextOf(item).some((value) => value.toLowerCase().includes(normalized)),
  );
}

export function listRuntimeCounts(
  items: CapabilityItem[],
): Record<CapabilityRuntimeFilter, number> {
  return {
    all: items.length,
    claude: items.filter((item) => item.agent === 'claude').length,
    codex: items.filter((item) => item.agent === 'codex').length,
    opencode: items.filter((item) => item.agent === 'opencode').length,
  };
}
