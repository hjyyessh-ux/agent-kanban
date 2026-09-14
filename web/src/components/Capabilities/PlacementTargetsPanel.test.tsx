import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlacementTarget } from '../../../../src/core/types';
import { PlacementTargetsPanel } from './PlacementTargetsPanel';

const target = (overrides: Partial<PlacementTarget>): PlacementTarget => ({
  id: 'target', label: 'Target', dir: '/repo', kind: 'project', runtime: 'claude',
  teamShared: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('PlacementTargetsPanel runtime paths', () => {
  test('starts collapsed with only the target summary visible', () => {
    const html = renderToStaticMarkup(
      <PlacementTargetsPanel
        targets={[
          target({ id: 'claude-user', label: 'Claude user', kind: 'user', dir: '~/.claude', builtin: true }),
          target({ id: 'codex-user', label: 'Codex user', kind: 'user', runtime: 'codex', dir: '~/.codex/skills', builtin: true }),
          target({ id: 'codex-a', label: 'Codex A', runtime: 'codex', dir: '/repo/a' }),
          target({ id: 'codex-b', label: 'Codex B', runtime: 'codex', dir: '/repo/b' }),
        ]}
        loading={false}
        onAdd={mock(async () => target({}))}
        onRemove={mock(async () => undefined)}
      />,
    );

    expect(html).toContain('4 configured · Claude 1 · Codex 3');
    expect(html).toContain('Show targets');
    expect(html).not.toContain('~/.codex/config.toml');
    expect(html).not.toContain('~/.codex/skills');
    expect(html).not.toContain('kv2-runtime-badge--codex');
    expect(html).toContain('aria-expanded="false"');
  });
});
