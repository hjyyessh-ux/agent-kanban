import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSkills } from '../core/skill-scanner';

function writeSkill(root: string, name: string, frontmatter: string, extra?: { openaiYaml?: string }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), frontmatter);
  if (extra?.openaiYaml) {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'openai.yaml'), extra.openaiYaml);
  }
}

describe('skill-scanner', () => {
  let claudeRoot: string;
  let codexRoot: string;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'skill-scan-'));
    claudeRoot = join(base, 'claude');
    codexRoot = join(base, 'codex');
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('parses claude SKILL.md frontmatter into a /name command', () => {
    writeSkill(claudeRoot, 'my-skill', '---\nname: my-skill\ndescription: Does a thing.\n---\n# body');
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'my-skill',
      runtime: 'claude',
      kind: 'claude_skill',
      skillName: 'my-skill',
      displayName: '/my-skill',
      description: 'Does a thing.',
      scope: 'user',
    });
    expect(skills[0].directory).toContain('my-skill');
    expect(skills[0].filePath).toContain('SKILL.md');
  });

  test('maps codex skills to skills:<name> with a $name display token', () => {
    writeSkill(codexRoot, 'codex-skill', '---\nname: codex-skill\ndescription: Codex thing.\n---');
    const skills = scanSkills([{ dir: codexRoot, runtime: 'codex', source: 'codex-user' }]);
    expect(skills[0]).toMatchObject({
      id: 'skills:codex-skill',
      runtime: 'codex',
      kind: 'codex_skill',
      skillName: 'codex-skill',
      displayName: '$codex-skill',
      scope: 'user',
    });
  });

  test('maps opencode skills to /<name> with opencode_skill kind', () => {
    const opencodeRoot = join(base, 'agents');
    mkdirSync(opencodeRoot, { recursive: true });
    writeSkill(opencodeRoot, 'ask-claude', '---\nname: ask-claude\ndescription: Ask Claude.\n---');
    const skills = scanSkills([{ dir: opencodeRoot, runtime: 'opencode', source: 'opencode-user' }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'ask-claude',
      runtime: 'opencode',
      kind: 'opencode_skill',
      skillName: 'ask-claude',
      displayName: '/ask-claude',
      scope: 'user',
    });
  });

  test('scope is "system" for codex-system source', () => {
    writeSkill(codexRoot, 'sys-skill', '---\nname: sys-skill\ndescription: System.\n---');
    const skills = scanSkills([{ dir: codexRoot, runtime: 'codex', source: 'codex-system' }]);
    expect(skills[0].scope).toBe('system');
  });

  test('falls back to openai.yaml short_description when frontmatter omits it', () => {
    writeSkill(codexRoot, 'yaml-skill', '---\nname: yaml-skill\n---', {
      openaiYaml: 'interface:\n  short_description: "From yaml"\n',
    });
    const skills = scanSkills([{ dir: codexRoot, runtime: 'codex', source: 'codex-user' }]);
    expect(skills[0].description).toBe('From yaml');
  });

  test('skips dotfiles, loose files, and directories without SKILL.md', () => {
    writeSkill(claudeRoot, 'real', '---\nname: real\ndescription: ok\n---');
    writeFileSync(join(claudeRoot, 'loose.md'), 'not a skill');
    mkdirSync(join(claudeRoot, '.hidden'), { recursive: true });
    mkdirSync(join(claudeRoot, 'empty-dir'), { recursive: true });
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills.map((s) => s.id)).toEqual(['real']);
  });

  test('de-dupes by id across roots, first occurrence wins', () => {
    writeSkill(claudeRoot, 'dup', '---\nname: dup\ndescription: user-level\n---');
    writeSkill(codexRoot, 'dup', '---\nname: dup\ndescription: system-level\n---');
    // Both roots point to the same directory (claudeRoot) — inode dedup keeps one.
    const skills = scanSkills([
      { dir: claudeRoot, runtime: 'claude', source: 'claude-user' },
      { dir: claudeRoot, runtime: 'claude', source: 'claude-dup' },
    ]);
    expect(skills.filter((s) => s.id === 'dup')).toHaveLength(1);
    expect(skills[0].description).toBe('user-level');
  });

  test('returns empty for a non-existent root', () => {
    expect(scanSkills([{ dir: join(claudeRoot, 'nope'), runtime: 'claude', source: 'x' }])).toEqual([]);
  });

  // ─── tools extraction ────────────────────────────────────────

  test('extracts inline tools array from frontmatter', () => {
    writeSkill(claudeRoot, 'tool-skill', '---\nname: tool-skill\ntools: [mcp__playwright, mcp__clickup]\n---\n# body');
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills[0].tools).toEqual(['mcp__playwright', 'mcp__clickup']);
  });

  test('extracts multiline allowed-tools list from frontmatter', () => {
    const md = '---\nname: multi-tool\nallowed-tools:\n  - Bash\n  - Read\n  - Write\n---\n# body';
    writeSkill(claudeRoot, 'multi-tool', md);
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills[0].tools).toEqual(['Bash', 'Read', 'Write']);
  });

  test('extracts mcp__ tokens from SKILL.md body', () => {
    const md =
      '---\nname: body-tool\ndescription: Uses mcp tools\n---\n' +
      'Call `mcp__playwright__browser_snapshot` or `mcp__clickup__create_task` here.';
    writeSkill(claudeRoot, 'body-tool', md);
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills[0].tools).toContain('mcp__playwright');
    expect(skills[0].tools).toContain('mcp__clickup');
  });

  test('merges and deduplicates tools from frontmatter and body', () => {
    const md =
      '---\nname: merged\ntools: [mcp__playwright]\n---\n' +
      'Also uses `mcp__playwright__click` and `mcp__clickup__task`.';
    writeSkill(claudeRoot, 'merged', md);
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    // mcp__playwright appears in both frontmatter and body — should appear once
    expect(skills[0].tools?.filter((t) => t === 'mcp__playwright')).toHaveLength(1);
    expect(skills[0].tools).toContain('mcp__clickup');
  });

  test('leaves tools undefined when none are found', () => {
    writeSkill(claudeRoot, 'no-tools', '---\nname: no-tools\ndescription: Clean.\n---\n# no tools here');
    const skills = scanSkills([{ dir: claudeRoot, runtime: 'claude', source: 'claude-user' }]);
    expect(skills[0].tools).toBeUndefined();
  });

  // ─── inode / symlink dedup ───────────────────────────────────

  test('deduplicates symlinked directories by inode', () => {
    writeSkill(claudeRoot, 'shared', '---\nname: shared\ndescription: from claude\n---');

    const agentsRoot = join(base, 'agents');
    mkdirSync(agentsRoot, { recursive: true });
    // Symlink agentsRoot/shared → claudeRoot/shared (same physical directory)
    symlinkSync(join(claudeRoot, 'shared'), join(agentsRoot, 'shared'));

    const skills = scanSkills([
      { dir: claudeRoot, runtime: 'claude', source: 'claude-user' },
      { dir: agentsRoot, runtime: 'opencode', source: 'opencode-user' },
    ]);
    // Should appear only once — first root (claude) wins
    expect(skills.filter((s) => s.skillName === 'shared')).toHaveLength(1);
    expect(skills[0].runtime).toBe('claude');
  });
});
