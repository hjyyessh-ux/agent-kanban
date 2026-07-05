import { describe, it, expect, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKanbanDataDir, __resetKanbanDataDirCache } from '../core/data-dir';

function makeFakeHome(): { home: string; canonical: string } {
  const home = mkdtempSync(join(tmpdir(), 'kanban-home-'));
  return {
    home,
    canonical: join(home, '.agent-kanban'),
  };
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

describe('resolveKanbanDataDir', () => {
  beforeEach(() => {
    __resetKanbanDataDirCache();
  });

  it('respects KANBAN_DATA_DIR env override and creates it if missing', () => {
    const { home } = makeFakeHome();
    try {
      const override = join(home, 'custom-data');
      const env = { KANBAN_DATA_DIR: override } as NodeJS.ProcessEnv;
      const resolved = resolveKanbanDataDir({ home, env });
      expect(resolved).toBe(override);
      expect(existsSync(override)).toBe(true);
    } finally { cleanup(home); }
  });

  it('returns canonical dir when it has initialized data', () => {
    const { home, canonical } = makeFakeHome();
    try {
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, 'active.json'), '{"version":1,"cards":[]}');
      const resolved = resolveKanbanDataDir({ home, env: {} });
      expect(resolved).toBe(canonical);
    } finally { cleanup(home); }
  });

  it('creates canonical fresh when no data exists', () => {
    const { home, canonical } = makeFakeHome();
    try {
      const resolved = resolveKanbanDataDir({ home, env: {} });
      expect(resolved).toBe(canonical);
      expect(existsSync(canonical)).toBe(true);
    } finally { cleanup(home); }
  });
});
