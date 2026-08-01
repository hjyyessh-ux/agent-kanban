import { describe, expect, test } from 'bun:test';
import type { ColdEntryView } from '../../../../src/core/types';
import { coldKindCounts, coldRuntimeCounts, filterColdEntries, matchesColdSearch } from './cold-filters';

const entries: ColdEntryView[] = [
  {
    kind: 'skill', ref: 'claude/review', runtime: 'claude', sourceScope: 'user',
    summary: 'Reviews pull requests',
    sourcePath: '/home/me/.claude/skills/review', hash: 'a', createdAt: '2026-01-01T00:00:00Z',
    restorePolicy: 'any',
  },
  {
    kind: 'skill', ref: 'codex/deploy', runtime: 'codex', sourceScope: 'project',
    sourcePath: '/repo/.codex/skills/deploy', projectRoot: '/repo', hash: 'b',
    createdAt: '2026-01-02T00:00:00Z', restorePolicy: 'any',
  },
  {
    kind: 'mcp', ref: 'linear', runtime: 'claude', sourceScope: 'user',
    sourcePath: '/home/me/.claude.json', originalConfigJson: '{"command":"npx","args":["linear-mcp"]}',
    hash: 'c', createdAt: '2026-01-03T00:00:00Z', restorePolicy: 'any',
  },
];

describe('cold storage filters', () => {
  test('searches ref, summary, scope, path, project root, and MCP definition', () => {
    expect(matchesColdSearch(entries[0], '')).toBe(true);
    expect(matchesColdSearch(entries[0], 'REVIEW')).toBe(true);
    expect(matchesColdSearch(entries[0], 'pull requests')).toBe(true);
    expect(matchesColdSearch(entries[1], '/repo')).toBe(true);
    expect(matchesColdSearch(entries[2], 'linear-mcp')).toBe(true);
    expect(matchesColdSearch(entries[2], 'review')).toBe(false);
  });

  test('combines search with kind and runtime filters', () => {
    expect(filterColdEntries(entries, { search: '', kind: 'all', runtime: 'all' })).toHaveLength(3);
    expect(filterColdEntries(entries, { search: '', kind: 'mcp', runtime: 'all' }).map((e) => e.ref))
      .toEqual(['linear']);
    expect(filterColdEntries(entries, { search: '', kind: 'all', runtime: 'codex' }).map((e) => e.ref))
      .toEqual(['codex/deploy']);
    expect(filterColdEntries(entries, { search: 'deploy', kind: 'skill', runtime: 'claude' }))
      .toEqual([]);
  });

  test('counts entries per kind and runtime', () => {
    expect(coldKindCounts(entries)).toEqual({ all: 3, skill: 2, mcp: 1 });
    expect(coldRuntimeCounts(entries)).toEqual({ all: 3, claude: 2, codex: 1, opencode: 0 });
  });
});
