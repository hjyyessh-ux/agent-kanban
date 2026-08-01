import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DiscoveredSkill, SkillRuntime } from './types';

/**
 * Discovers user-authored skills from disk so they surface in the board without
 * a code change. We scan the personal skill directories where `claude`, `codex`,
 * and `opencode` drop SKILL.md folders — this is exactly where a user lands a
 * skill they just created.
 */

interface SkillRoot {
  dir: string;
  runtime: SkillRuntime;
  source: string;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Default skill roots, overridable for tests via the `roots` argument. */
export function defaultSkillRoots(): SkillRoot[] {
  return [
    { dir: expandHome('~/.claude/skills'), runtime: 'claude', source: 'claude-user' },
    { dir: expandHome('~/.codex/skills'), runtime: 'codex', source: 'codex-user' },
    { dir: expandHome('~/.codex/skills/.system'), runtime: 'codex', source: 'codex-system' },
    { dir: expandHome('~/.agents/skills'), runtime: 'opencode', source: 'opencode-user' },
  ];
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  disableModelInvocation?: boolean;
}

/**
 * Parse the leading `---` YAML block of a SKILL.md. Extracts `name`,
 * `description`, and tool/MCP keys (`allowed-tools`, `tools`, `mcp`).
 * Handles both scalar values and multiline YAML lists.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const body = match[1];
  const result: ParsedFrontmatter = {};
  const lines = body.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Scalar keys: name, description
    const scalar = line.match(/^(name|description):\s*(.*)$/);
    if (scalar) {
      let value = scalar[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (scalar[1] === 'name') result.name = value;
      else result.description = value;
      i++;
      continue;
    }

    // Boolean key: disable-model-invocation
    const boolKey = line.match(/^disable-model-invocation:\s*(.*)$/);
    if (boolKey) {
      result.disableModelInvocation = boolKey[1].trim() === 'true';
      i++;
      continue;
    }

    // Tool keys: allowed-tools, tools, mcp
    const toolKey = line.match(/^(allowed-tools|tools|mcp):\s*(.*)$/);
    if (toolKey) {
      const inline = toolKey[2].trim();
      if (inline) {
        // Inline scalar or array: `tools: [foo, bar]` or `tools: foo`
        result.tools = [...(result.tools ?? []), ...parseInlineToolList(inline)];
        i++;
      } else {
        // Multiline YAML list: following lines starting with optional spaces + `- `
        i++;
        while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s+-\s+/, '').trim();
          if (item) {
            if (!result.tools) result.tools = [];
            result.tools.push(item);
          }
          i++;
        }
      }
      continue;
    }

    i++;
  }

  return result;
}

/** Parse `[foo, bar]` or bare `foo` into an array of tool names. */
function parseInlineToolList(inline: string): string[] {
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return [inline.replace(/^['"]|['"]$/g, '')].filter(Boolean);
}

/**
 * Extract unique MCP server prefixes from the SKILL.md body (after frontmatter).
 * Matches `mcp__server__tool` tokens and normalises to the server-level prefix
 * `mcp__server`, so `mcp__playwright__browser_click` → `mcp__playwright`.
 */
function extractBodyMcpTools(content: string): string[] {
  const afterFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const seen = new Set<string>();
  for (const m of afterFrontmatter.matchAll(/\bmcp__[a-zA-Z0-9_-]+(?:__[a-zA-Z0-9_-]+)*/g)) {
    // Normalise mcp__server__tool → mcp__server
    const parts = m[0].split('__');
    seen.add(`${parts[0]}__${parts[1]}`);
  }
  return [...seen];
}

/** Fallback description from Codex `agents/openai.yaml` (short_description). */
function readCodexShortDescription(skillDir: string): string | undefined {
  const yamlPath = join(skillDir, 'agents', 'openai.yaml');
  if (!existsSync(yamlPath)) return undefined;
  try {
    const content = readFileSync(yamlPath, 'utf8');
    const match = content.match(/short_description:\s*["']?(.*?)["']?\s*$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Returns a `dev:ino` string for inode-based deduplication. Follows symlinks. */
function inodeKey(p: string): string {
  try {
    const st = statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return p;
  }
}

/** Derive a human-readable scope label from the origin source string. */
function deriveScope(source: string): string {
  if (source.endsWith('-system')) return 'system';
  if (source.endsWith('-user')) return 'user';
  return source;
}

function scanRoot(root: SkillRoot): DiscoveredSkill[] {
  if (!existsSync(root.dir) || !isDir(root.dir)) return [];

  const skills: DiscoveredSkill[] = [];
  let names: string[];
  try {
    names = readdirSync(root.dir);
  } catch {
    return [];
  }

  for (const name of names) {
    // Skip dotfiles/loose files (e.g. `obsidian-doc.md`) and the `.system`
    // bucket itself (scanned as its own root).
    if (name.startsWith('.')) continue;
    const skillDir = join(root.dir, name);
    if (!isDir(skillDir)) continue;

    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    let frontmatter: ParsedFrontmatter = {};
    let bodyMcpTools: string[] = [];
    try {
      const raw = readFileSync(skillMd, 'utf8');
      frontmatter = parseFrontmatter(raw);
      bodyMcpTools = extractBodyMcpTools(raw);
    } catch {
      // Unreadable SKILL.md — fall back to directory name below.
    }

    const skillName = frontmatter.name?.trim() || name;
    const description =
      frontmatter.description?.trim() ||
      (root.runtime === 'codex' ? readCodexShortDescription(skillDir) : undefined) ||
      `${skillName} skill`;

    const allTools = [...new Set([...(frontmatter.tools ?? []), ...bodyMcpTools])];

    const shared = {
      skillName,
      description,
      source: root.source,
      directory: skillDir,
      filePath: skillMd,
      tools: allTools.length > 0 ? allTools : undefined,
      scope: deriveScope(root.source),
      disableModelInvocation: frontmatter.disableModelInvocation ?? false,
    };

    if (root.runtime === 'claude') {
      skills.push({
        ...shared,
        id: skillName,
        runtime: 'claude',
        kind: 'claude_skill',
        displayName: `/${skillName}`,
      });
    } else if (root.runtime === 'codex') {
      // Codex skills invoke as `$name`; the command id mirrors the static
      // convention `skills:<name>` used elsewhere in the registry.
      skills.push({
        ...shared,
        id: `skills:${skillName}`,
        runtime: 'codex',
        kind: 'codex_skill',
        displayName: `$${skillName}`,
      });
    } else {
      skills.push({
        ...shared,
        id: skillName,
        runtime: 'opencode',
        kind: 'opencode_skill',
        displayName: `/${skillName}`,
      });
    }
  }

  return skills;
}

/**
 * Scan all skill roots and return discovered skills, de-duplicated in two passes:
 *
 * 1. **Inode dedup** — symlinked or hardlinked directories that resolve to the
 *    same filesystem entry are counted once (first root wins). This prevents
 *    `~/.claude/skills/foo` and `~/.agents/skills/foo` from appearing twice when
 *    they share an inode.
 *
 * 2. **Id dedup** — different physical directories that produce the same logical
 *    command id also deduplicate (first occurrence wins), so a user-level skill
 *    shadows a system one.
 */
export function scanSkills(roots: SkillRoot[] = defaultSkillRoots()): DiscoveredSkill[] {
  const byId = new Map<string, DiscoveredSkill>();
  const seenInodes = new Set<string>();

  for (const root of roots) {
    for (const skill of scanRoot(root)) {
      const inode = inodeKey(skill.directory);
      if (seenInodes.has(inode)) continue;
      seenInodes.add(inode);

      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    }
  }
  return [...byId.values()];
}
