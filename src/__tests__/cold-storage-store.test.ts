import { describe, test, expect, beforeEach } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import './setup'; // sets KANBAN_DATA_DIR before any store import

import {
  hashDef,
  hashDir,
  safeMoveDir,
  safeCopyDir,
  freezeSkill,
  restoreSkill,
  freezeMcp,
  restoreMcp,
  deleteColdEntry,
  getColdManifest,
  getColdManifestView,
  readColdSkillContent,
  resolveColdStorageDir,
} from '../core/cold-storage-store';
import type { DiscoveredSkill } from '../core/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cold-test-'));
}

function makeSkillDir(base: string, files: Record<string, string> = {}): string {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'SKILL.md'), '---\nname: test-skill\n---\nBody.');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(base, name), content);
  }
  return base;
}

function makeDiscoveredSkill(dir: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'test-skill',
    kind: 'claude_skill',
    skillName: 'test-skill',
    displayName: 'Test Skill',
    description: 'A test skill',
    runtime: 'claude' as const,
    scope: 'user',
    source: dir,
    directory: dir,
    ...overrides,
  };
}

/** Reset cold storage directory before each test to avoid state leakage. */
function resetColdStorage(): void {
  const coldDir = resolveColdStorageDir();
  rmSync(coldDir, { recursive: true, force: true });
  mkdirSync(coldDir, { recursive: true });
}

// ── hashDef ──────────────────────────────────────────────────────────────────

describe('hashDef', () => {
  test('produces a hex string for a def', () => {
    const hash = hashDef({ command: 'npx', args: ['-y', 'some-server'] });
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64); // sha256 hex
  });

  test('identical defs produce the same hash', () => {
    const def = { command: 'node', args: ['server.js'], env: { FOO: 'bar' } };
    expect(hashDef(def)).toBe(hashDef(def));
  });

  test('different defs produce different hashes', () => {
    const a = hashDef({ command: 'node', args: ['a.js'] });
    const b = hashDef({ command: 'node', args: ['b.js'] });
    expect(a).not.toBe(b);
  });
});

// ── hashDir ───────────────────────────────────────────────────────────────────

describe('hashDir', () => {
  test('returns a hex string for a directory', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello');
      const hash = hashDir(dir);
      expect(typeof hash).toBe('string');
      expect(hash).toHaveLength(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('identical directories produce the same hash', () => {
    const d1 = tmpDir();
    const d2 = tmpDir();
    try {
      writeFileSync(join(d1, 'a.txt'), 'hello');
      writeFileSync(join(d2, 'a.txt'), 'hello');
      expect(hashDir(d1)).toBe(hashDir(d2));
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  test('directories with different content produce different hashes', () => {
    const d1 = tmpDir();
    const d2 = tmpDir();
    try {
      writeFileSync(join(d1, 'a.txt'), 'hello');
      writeFileSync(join(d2, 'a.txt'), 'world');
      expect(hashDir(d1)).not.toBe(hashDir(d2));
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  test('returns empty-ish hash for non-existent dir', () => {
    // Should not throw, just returns hash of nothing
    expect(() => hashDir('/nonexistent/path/that/does/not/exist')).not.toThrow();
  });
});

// ── safeMoveDir ───────────────────────────────────────────────────────────────

describe('safeMoveDir', () => {
  test('moves directory and its contents', () => {
    const base = tmpDir();
    try {
      const src = join(base, 'src');
      const dst = join(base, 'dst');
      makeSkillDir(src, { 'extra.txt': 'extra content' });
      const srcHash = hashDir(src);

      safeMoveDir(src, dst);

      expect(existsSync(src)).toBe(false);
      expect(existsSync(dst)).toBe(true);
      expect(hashDir(dst)).toBe(srcHash);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws CONFLICT_409 when destination already exists', () => {
    const base = tmpDir();
    try {
      const src = join(base, 'src');
      const dst = join(base, 'dst');
      makeSkillDir(src);
      mkdirSync(dst);

      expect(() => safeMoveDir(src, dst)).toThrow();
      try {
        safeMoveDir(src, dst);
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('CONFLICT_409');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws SYMLINK_REJECTED when source is a symlink', () => {
    const base = tmpDir();
    try {
      const real = join(base, 'real');
      const link = join(base, 'link');
      mkdirSync(real);
      symlinkSync(real, link);

      try {
        safeMoveDir(link, join(base, 'dst'));
        throw new Error('Expected throw');
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('SYMLINK_REJECTED');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── safeCopyDir ───────────────────────────────────────────────────────────────

describe('safeCopyDir', () => {
  test('copies directory and verifies hash integrity', () => {
    const base = tmpDir();
    try {
      const src = join(base, 'src');
      const dst = join(base, 'dst');
      makeSkillDir(src, { 'data.txt': 'some data' });
      const srcHash = hashDir(src);

      safeCopyDir(src, dst);

      // src is preserved
      expect(existsSync(src)).toBe(true);
      expect(existsSync(dst)).toBe(true);
      expect(hashDir(dst)).toBe(srcHash);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws CONFLICT_409 when destination already exists', () => {
    const base = tmpDir();
    try {
      const src = join(base, 'src');
      const dst = join(base, 'dst');
      makeSkillDir(src);
      mkdirSync(dst);

      try {
        safeCopyDir(src, dst);
        throw new Error('Expected throw');
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('CONFLICT_409');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws SYMLINK_REJECTED when source is a symlink', () => {
    const base = tmpDir();
    try {
      const real = join(base, 'real');
      const link = join(base, 'link');
      mkdirSync(real);
      symlinkSync(real, link);

      try {
        safeCopyDir(link, join(base, 'dst'));
        throw new Error('Expected throw');
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('SYMLINK_REJECTED');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── freezeSkill / restoreSkill ────────────────────────────────────────────────

describe('freezeSkill', () => {
  beforeEach(resetColdStorage);

  test('moves skill directory to cold storage and creates manifest entry', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'my-skill');
      makeSkillDir(skillDir);
      const srcHash = hashDir(skillDir);
      const skill = makeDiscoveredSkill(skillDir, { skillName: 'freeze-a', id: 'freeze-a' });

      const entry = await freezeSkill(skill);

      expect(entry.kind).toBe('skill');
      expect(entry.ref).toBe('claude/freeze-a');
      expect(entry.runtime).toBe('claude');
      expect(entry.hash).toBe(srcHash);
      expect(entry.sourceScope).toBe('user');
      expect(typeof entry.createdAt).toBe('string');
      expect(existsSync(skillDir)).toBe(false);

      const manifest = getColdManifest();
      expect(manifest).toHaveLength(1);
      expect(manifest[0].ref).toBe('claude/freeze-a');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('frozen directory hash matches original', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'hash-check-skill');
      makeSkillDir(skillDir, { 'extra.ts': 'export const x = 1;' });
      const srcHash = hashDir(skillDir);
      const skill = makeDiscoveredSkill(skillDir, { skillName: 'hash-check', id: 'hash-check' });

      const entry = await freezeSkill(skill);
      const coldDir = join(resolveColdStorageDir(), 'skills', 'claude', 'hash-check');

      expect(existsSync(coldDir)).toBe(true);
      expect(hashDir(coldDir)).toBe(srcHash);
      expect(entry.hash).toBe(srcHash);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws CONFLICT_409 when skill already frozen', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'dup-skill');
      makeSkillDir(skillDir);
      const skill = makeDiscoveredSkill(skillDir, { skillName: 'dup-skill', id: 'dup-skill' });

      await freezeSkill(skill);

      // Recreate the skill dir for second attempt
      makeSkillDir(skillDir);
      const skill2 = makeDiscoveredSkill(skillDir, { skillName: 'dup-skill', id: 'dup-skill' });

      try {
        await freezeSkill(skill2);
        throw new Error('Expected throw');
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('CONFLICT_409');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws when skill has no directory', async () => {
    const skill = makeDiscoveredSkill('', { directory: undefined as unknown as string, skillName: 'no-dir', id: 'no-dir' });
    try {
      await freezeSkill(skill);
      throw new Error('Expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('no directory');
    }
  });

  test('rejects symlinked skill directory', async () => {
    const base = tmpDir();
    try {
      const real = join(base, 'real-skill');
      const link = join(base, 'link-skill');
      makeSkillDir(real);
      symlinkSync(real, link);
      const skill = makeDiscoveredSkill(link, { skillName: 'sym-skill', id: 'sym-skill' });

      try {
        await freezeSkill(skill);
        throw new Error('Expected throw');
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('SYMLINK_REJECTED');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('readColdSkillContent', () => {
  beforeEach(resetColdStorage);

  test('reads the frozen SKILL.md and rejects refs escaping cold storage', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'read-skill');
      makeSkillDir(skillDir);
      await freezeSkill(makeDiscoveredSkill(skillDir, { skillName: 'read-me', id: 'read-me' }));

      const file = readColdSkillContent('claude/read-me');
      expect(file?.content).toContain('name: test-skill');
      expect(file?.filePath).toBe(
        join(resolveColdStorageDir(), 'skills', 'claude', 'read-me', 'SKILL.md'),
      );

      expect(readColdSkillContent('claude/missing')).toBeNull();
      expect(readColdSkillContent('../../etc')).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('getColdManifestView', () => {
  beforeEach(resetColdStorage);

  test('summarizes skills from frontmatter and MCP servers from their invocation', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'summary-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: summary-skill\ndescription: Reviews pull requests\n---\nBody.',
      );
      await freezeSkill(makeDiscoveredSkill(skillDir, { skillName: 'summary', id: 'summary' }));
      await freezeMcp(
        'linear',
        { command: 'npx', args: ['linear-mcp'] },
        'user',
        undefined,
        { ts: 'summary-ts', claudeJsonPath: join(base, 'claude.json') },
      );

      const view = getColdManifestView();
      expect(view.find((e) => e.ref === 'claude/summary')?.summary).toBe('Reviews pull requests');
      expect(view.find((e) => e.ref === 'linear')?.summary).toBe('npx linear-mcp');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('restoreSkill', () => {
  beforeEach(resetColdStorage);

  test('copies frozen skill to target dir and removes from cold', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'restore-src');
      const targetDir = join(base, 'restore-target');
      makeSkillDir(skillDir, { 'impl.ts': 'export const impl = true;' });
      const originalHash = hashDir(skillDir);
      const skill = makeDiscoveredSkill(skillDir, { skillName: 'restore-me', id: 'restore-me' });

      await freezeSkill(skill);
      await restoreSkill('claude/restore-me', targetDir);

      expect(existsSync(targetDir)).toBe(true);
      expect(hashDir(targetDir)).toBe(originalHash);

      const manifest = getColdManifest();
      expect(manifest.find((e) => e.ref === 'claude/restore-me')).toBeUndefined();

      const coldPath = join(resolveColdStorageDir(), 'skills', 'claude', 'restore-me');
      expect(existsSync(coldPath)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws when skill not found in cold storage', async () => {
    try {
      await restoreSkill('claude/nonexistent', tmpDir());
      throw new Error('Expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not found');
    }
  });
});

// ── freezeMcp (project scope) ─────────────────────────────────────────────────

describe('freezeMcp (project scope)', () => {
  beforeEach(resetColdStorage);

  test('saves def to registry and creates manifest entry', async () => {
    const base = tmpDir();
    try {
      const mcpJson = join(base, '.mcp.json');
      const def = { command: 'npx', args: ['-y', 'test-server'] };
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { 'test-srv': def } }, null, 2));

      const ts = new Date().toISOString();
      const entry = await freezeMcp('test-srv', def, 'project', base, { ts });

      expect(entry.kind).toBe('mcp');
      expect(entry.ref).toBe('test-srv');
      expect(entry.sourceScope).toBe('project');
      expect(entry.originalConfigJson).toBe(JSON.stringify(def));
      expect(typeof entry.hash).toBe('string');

      const manifest = getColdManifest();
      expect(manifest).toHaveLength(1);
      expect(manifest[0].ref).toBe('test-srv');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('removes server from .mcp.json after freeze', async () => {
    const base = tmpDir();
    try {
      const mcpJson = join(base, '.mcp.json');
      const def = { command: 'npx', args: ['-y', 'removable-server'] };
      writeFileSync(
        mcpJson,
        JSON.stringify({ mcpServers: { 'removable-server': def, 'other-server': { command: 'node' } } }, null, 2),
      );

      const ts = new Date().toISOString();
      await freezeMcp('removable-server', def, 'project', base, { ts });

      const parsed = JSON.parse(readFileSync(mcpJson, 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers['removable-server']).toBeUndefined();
      expect(parsed.mcpServers['other-server']).toBeDefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('hash matches hashDef of original def', async () => {
    const base = tmpDir();
    try {
      const mcpJson = join(base, '.mcp.json');
      const def = { command: 'python', args: ['-m', 'my_server'] };
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { 'py-srv': def } }, null, 2));

      const ts = new Date().toISOString();
      const entry = await freezeMcp('py-srv', def, 'project', base, { ts });
      expect(entry.hash).toBe(hashDef(def));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('freezes Codex MCP without colliding with the legacy Claude ref format', async () => {
    const base = tmpDir();
    try {
      const codexDir = join(base, '.codex');
      const configPath = join(codexDir, 'config.toml');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        configPath,
        'model = "gpt-5.4"\n\n[mcp_servers.shared]\ncommand = "codex-server"\n',
      );
      const def = { command: 'codex-server', type: 'stdio' as const };

      const entry = await freezeMcp('shared', def, 'project', base, {
        ts: 'codex-freeze',
        runtime: 'codex',
      });

      expect(entry.ref).toBe('codex/shared');
      expect(entry.runtime).toBe('codex');
      expect(entry.sourcePlacement).toMatchObject({
        runtime: 'codex', scope: 'project', dir: base, location: configPath,
      });
      expect(readFileSync(configPath, 'utf8')).toBe('model = "gpt-5.4"\n\n');

      await restoreMcp(entry.ref, undefined, { ts: 'codex-restore' });
      const restored = readFileSync(configPath, 'utf8');
      expect(restored).toContain('model = "gpt-5.4"');
      expect(restored).toContain('[mcp_servers."shared"]');
      expect(getColdManifest().find((item) => item.ref === entry.ref)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── deleteColdEntry ───────────────────────────────────────────────────────────

describe('deleteColdEntry', () => {
  beforeEach(resetColdStorage);

  test('removes skill from cold storage and manifest', async () => {
    const base = tmpDir();
    try {
      const skillDir = join(base, 'del-skill');
      makeSkillDir(skillDir);
      const skill = makeDiscoveredSkill(skillDir, { skillName: 'del-skill', id: 'del-skill' });
      await freezeSkill(skill);

      expect(getColdManifest()).toHaveLength(1);

      await deleteColdEntry('skill', 'claude/del-skill');

      const coldPath = join(resolveColdStorageDir(), 'skills', 'claude', 'del-skill');
      expect(existsSync(coldPath)).toBe(false);
      expect(getColdManifest()).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('removes mcp from registry and manifest', async () => {
    const base = tmpDir();
    try {
      const mcpJson = join(base, '.mcp.json');
      const def = { command: 'node', args: ['srv.js'] };
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { 'del-mcp': def } }, null, 2));

      const ts = new Date().toISOString();
      await freezeMcp('del-mcp', def, 'project', base, { ts });
      expect(getColdManifest()).toHaveLength(1);

      await deleteColdEntry('mcp', 'del-mcp');
      expect(getColdManifest()).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('is idempotent for nonexistent skill', async () => {
    const result = await deleteColdEntry('skill', 'claude/ghost-skill');
    expect(result).toBeUndefined();
  });
});

// ── getColdManifest ───────────────────────────────────────────────────────────

describe('getColdManifest', () => {
  beforeEach(resetColdStorage);

  test('returns empty array when no entries', () => {
    expect(getColdManifest()).toEqual([]);
  });

  test('loads legacy MCP entries as Claude without dropping them', () => {
    const coldDir = resolveColdStorageDir();
    const legacy = [{
      kind: 'mcp',
      ref: 'legacy-server',
      sourceScope: 'user',
      sourcePath: '/tmp/.claude.json',
      hash: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      restorePolicy: 'any',
    }];
    writeFileSync(join(coldDir, 'manifest.json'), JSON.stringify(legacy));

    const entries = getColdManifest();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ref: 'legacy-server', runtime: 'claude' });
  });

  test('returns all entries after multiple freezes', async () => {
    const base = tmpDir();
    try {
      const skillDir1 = join(base, 'skill-a');
      const skillDir2 = join(base, 'skill-b');
      makeSkillDir(skillDir1);
      makeSkillDir(skillDir2);

      const s1 = makeDiscoveredSkill(skillDir1, { skillName: 'skill-a', id: 'skill-a' });
      const s2 = makeDiscoveredSkill(skillDir2, { skillName: 'skill-b', id: 'skill-b' });

      await freezeSkill(s1);
      await freezeSkill(s2);

      const manifest = getColdManifest();
      expect(manifest).toHaveLength(2);
      const refs = manifest.map((e) => e.ref);
      expect(refs).toContain('claude/skill-a');
      expect(refs).toContain('claude/skill-b');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
