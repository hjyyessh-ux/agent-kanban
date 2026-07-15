import { describe, expect, test } from 'bun:test';
import type { DiscoveredSkill, McpInventoryItem, SkillVisibility } from '../../../../src/core/types';
import { inventoryRuntimeCounts, listRuntimeCounts, matchesRuntime, runtimeLabel } from './capability-filters';

const placement = (runtime: 'claude' | 'codex', identity: string) => ({
  identity, runtime, scope: 'user' as const, location: `/${runtime}`,
  alwaysLoad: false, hasPlaintextSecret: false, managed: false,
});

const mcp: McpInventoryItem[] = [
  { identity: 'claude:shared', runtime: 'claude', name: 'shared', def: {}, placements: [placement('claude', 'cp')], status: 'unknown' },
  { identity: 'codex:shared', runtime: 'codex', name: 'shared', def: {}, placements: [placement('codex', 'xp')], status: 'unknown' },
];

const skill = (runtime: 'claude' | 'codex' | 'opencode'): DiscoveredSkill & SkillVisibility => ({
  id: `${runtime}-skill`, runtime, kind: `${runtime}_skill`, skillName: `${runtime}-skill`,
  displayName: `${runtime}-skill`, description: '', source: `${runtime}-user`, directory: `/${runtime}`,
  scope: 'user', override: null, disableModelInvocation: false, effectivelyHidden: false,
});

describe('Capabilities runtime filters', () => {
  test('counts same-name MCP independently and includes every skill in All', () => {
    expect(inventoryRuntimeCounts(mcp, [skill('claude'), skill('codex'), skill('opencode')])).toEqual({
      all: 5, claude: 2, codex: 2, opencode: 1,
    });
  });

  test('uses the same runtime predicate and labels in both views', () => {
    expect(matchesRuntime('codex', 'codex')).toBe(true);
    expect(matchesRuntime(null, 'codex')).toBe(false);
    expect(matchesRuntime(null, 'all')).toBe(true);
    expect(runtimeLabel('opencode')).toBe('OpenCode');
    expect(listRuntimeCounts([
      { id: 'c', type: 'skill', name: 'c', agent: 'claude', directory: '/', scope: 'user', description: '' },
      { id: 'x', type: 'skill', name: 'x', agent: 'codex', directory: '/', scope: 'user', description: '' },
      { id: 's', type: 'script', name: 's', agent: null, directory: '/', scope: 'user', description: '' },
    ])).toEqual({ all: 3, claude: 1, codex: 1, opencode: 0 });
  });
});
