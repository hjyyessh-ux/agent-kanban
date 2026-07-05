import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSkillPath } from '../core/validate-skill-path';

describe('validateSkillPath', () => {
  let base: string;
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'vsp-'));
    rootA = join(base, 'rootA');
    rootB = join(base, 'rootB');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function touch(p: string): string {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '');
    return p;
  }

  test('returns true for a file directly inside an enabled root', () => {
    const file = touch(join(rootA, 'skill', 'SKILL.md'));
    expect(validateSkillPath(file, [rootA])).toBe(true);
  });

  test('returns true for a deeply nested file under an enabled root', () => {
    const file = touch(join(rootA, 'a', 'b', 'c', 'SKILL.md'));
    expect(validateSkillPath(file, [rootA])).toBe(true);
  });

  test('returns false for a file outside all enabled roots', () => {
    const file = touch(join(base, 'outside', 'SKILL.md'));
    expect(validateSkillPath(file, [rootA, rootB])).toBe(false);
  });

  test('blocks path traversal via .. components', () => {
    // A constructed path that "looks" inside rootA but resolves outside
    touch(join(base, 'outside', 'SKILL.md'));
    const traversal = join(rootA, '..', 'outside', 'SKILL.md');
    // traversal resolves to the same physical file (outside rootA)
    expect(validateSkillPath(traversal, [rootA])).toBe(false);
  });

  test('blocks symlink that escapes the root', () => {
    const outsideDir = join(base, 'secrets');
    mkdirSync(outsideDir, { recursive: true });
    const secretFile = join(outsideDir, 'secret.md');
    writeFileSync(secretFile, 'sensitive');

    // Create a symlink inside rootA pointing to the outside directory
    const symlinkDir = join(rootA, 'escaped');
    symlinkSync(outsideDir, symlinkDir);
    const pathViaSymlink = join(symlinkDir, 'secret.md');

    expect(validateSkillPath(pathViaSymlink, [rootA])).toBe(false);
  });

  test('returns true for a symlink that resolves inside the root', () => {
    const realSkillDir = join(rootA, 'real-skill');
    mkdirSync(realSkillDir, { recursive: true });
    const realFile = join(realSkillDir, 'SKILL.md');
    writeFileSync(realFile, '---\nname: real\n---');

    // Symlink inside same root pointing to another dir inside root — allowed
    const linkPath = join(rootA, 'link-skill');
    symlinkSync(realSkillDir, linkPath);
    const fileViaLink = join(linkPath, 'SKILL.md');

    expect(validateSkillPath(fileViaLink, [rootA])).toBe(true);
  });

  test('returns false for a non-existent path', () => {
    expect(validateSkillPath(join(rootA, 'nope', 'SKILL.md'), [rootA])).toBe(false);
  });

  test('returns false when enabledRootDirs is empty', () => {
    const file = touch(join(rootA, 'skill', 'SKILL.md'));
    expect(validateSkillPath(file, [])).toBe(false);
  });

  test('accepts file if it matches the second root', () => {
    const file = touch(join(rootB, 'skill', 'SKILL.md'));
    expect(validateSkillPath(file, [rootA, rootB])).toBe(true);
  });

  test('does not match a root that is a prefix of another root name', () => {
    // rootA path is '/base/rootA'; '/base/rootABC' must NOT be matched by rootA
    const rootABC = join(base, 'rootABC');
    mkdirSync(rootABC, { recursive: true });
    const file = touch(join(rootABC, 'skill', 'SKILL.md'));
    expect(validateSkillPath(file, [rootA])).toBe(false);
  });
});
