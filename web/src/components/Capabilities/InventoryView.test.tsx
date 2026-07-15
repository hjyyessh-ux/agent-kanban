import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiscoveredSkill, McpInventoryItem, SkillVisibility } from '../../../../src/core/types';
import { InventoryView } from './InventoryView';

const mcp = (runtime: 'claude' | 'codex'): McpInventoryItem => ({
  identity: `${runtime}:shared`, runtime, name: 'shared', def: { command: runtime }, status: 'unknown',
  placements: [{
    identity: `${runtime}-placement`, runtime, scope: runtime === 'claude' ? 'user' : 'project',
    location: runtime === 'claude' ? '/home/me/.claude.json' : '/repo/.codex/config.toml',
    dir: runtime === 'codex' ? '/repo' : undefined,
    appliesToDir: runtime === 'codex' ? '/repo/packages/app' : undefined,
    configLayer: runtime === 'codex' ? 'project' : undefined,
    effective: runtime === 'codex' ? true : undefined,
    projectTrust: runtime === 'codex' ? 'required-status-unknown' : undefined,
    alwaysLoad: runtime === 'claude', hasPlaintextSecret: false, managed: false,
  }],
});

const skill = (runtime: 'claude' | 'codex' | 'opencode'): DiscoveredSkill & SkillVisibility => ({
  id: `${runtime}-skill`, runtime, kind: `${runtime}_skill`, skillName: 'review',
  displayName: runtime === 'codex' ? '$review' : '/review', description: `${runtime} review`,
  source: `${runtime}-user`, directory: `/skills/${runtime}/review`, scope: 'user',
  override: null, disableModelInvocation: false, effectivelyHidden: false,
});

describe('InventoryView runtime accessibility', () => {
  test('renders complete runtime counts, badges, independent same-name MCP actions, and Codex chain details', () => {
    const html = renderToStaticMarkup(
      <InventoryView
        data={{
          mcp: [mcp('claude'), mcp('codex')],
          skills: [skill('claude'), skill('codex'), skill('opencode')],
          diagnostics: {
            enableToolSearch: 'auto', toolSearchEffective: true, runtimeSupportsToolSearch: true,
            userScopeMcpCount: 1, alwaysLoadCount: 1,
          },
        }}
        skillRoots={[]}
        placementTargets={[]}
        targetsLoading={false}
        onAddTarget={mock(async () => { throw new Error('not called'); })}
        onRemoveTarget={mock(async () => undefined)}
        onRefreshSkills={mock(async () => undefined)}
        runtimeFilter="all"
        onRuntimeFilterChange={mock(() => undefined)}
      />,
    );

    expect(html).toContain('All (5)');
    expect(html).toContain('Claude (2)');
    expect(html).toContain('Codex (2)');
    expect(html).toContain('OpenCode (1)');
    expect(html).toContain('aria-label="Open claude MCP details for shared"');
    expect(html).toContain('aria-label="Open codex MCP details for shared"');
    expect(html).toContain('/repo/.codex/config.toml');
    expect(html).toContain('project · effective · applies to /repo/packages/app');
    expect(html).toContain('trusted project');
    expect((html.match(/kv2-runtime-badge/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  test('applies the Codex runtime filter to MCP and Skill rows together', () => {
    const html = renderToStaticMarkup(
      <InventoryView
        data={{
          mcp: [mcp('claude'), mcp('codex')],
          skills: [skill('claude'), skill('codex'), skill('opencode')],
          diagnostics: {
            enableToolSearch: 'auto', toolSearchEffective: true, runtimeSupportsToolSearch: true,
            userScopeMcpCount: 1, alwaysLoadCount: 1,
          },
        }}
        skillRoots={[]}
        placementTargets={[]}
        targetsLoading={false}
        onAddTarget={mock(async () => { throw new Error('not called'); })}
        onRemoveTarget={mock(async () => undefined)}
        onRefreshSkills={mock(async () => undefined)}
        runtimeFilter="codex"
        onRuntimeFilterChange={mock(() => undefined)}
      />,
    );

    expect(html).toContain('aria-label="Open codex MCP details for shared"');
    expect(html).not.toContain('aria-label="Open claude MCP details for shared"');
    expect(html).toContain('$review');
    expect(html).not.toContain('claude review');
    expect(html).not.toContain('opencode review');
    expect(html).toContain('2 shown');
  });
});
