import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../core/skill-scanner';
import type {
  MentionSkillEntry,
  SkillInvocation,
  SkillMentionScope,
  SkillPoolEntry,
  SkillRuntime,
} from '../core/mention-skills';
import type { AgentRuntime } from '../core/types';

/**
 * `@skill:` 멘션 디스커버리 — runtime × projectDir 별로 "그 세션이 실제로 보는"
 * 스킬 목록을 만든다.
 *
 * 기존 `skill-scanner`(Capabilities 탭)는 user scope 디렉토리만 본다. 멘션은
 * 카드가 실행될 디렉토리 기준이어야 하므로 project·plugin 스킬까지 여기서 본다.
 * 탐색 위치는 실측(`docs/mockups/mention-skills-capabilities.html` ⑥)으로 정했다:
 *
 * | runtime | project                                  | user/system                                              | plugin |
 * |---------|------------------------------------------|----------------------------------------------------------|--------|
 * | claude  | `.claude/skills`                         | `~/.claude/skills`                                       | `installed_plugins.json` × `enabledPlugins` + `plugins/synced/*` |
 * | codex   | `.codex/skills`, `.agents/skills`        | `~/.codex/skills`, `~/.agents/skills`, `~/.codex/skills/.system` | `config.toml [plugins."x@m"] enabled = true` → `plugins/cache/m/x/<ver>/skills` |
 *
 * codex는 `.claude/skills`를 읽지 않고(C0), claude는 `.agents/skills`를 읽지 않는다(E1).
 *
 * CLI(`claude plugin list`, `codex debug prompt-input`)를 띄우지 않는 이유: 이 함수는
 * 멘션 검색(150ms 디바운스, 키 입력마다)에서 불린다. 파일 스캔은 수 ms이고 결정적이라
 * 테스트할 수 있다. 대신 builtin plugin(경로 없음)은 보이지 않는다 — 스킬이 없어 무해하다.
 */

const CACHE_TTL_MS = 30_000;
/** 다른 프로젝트 스킬(회색 행)을 모을 때 훑는 디렉토리 상한. */
const MAX_OTHER_PROJECT_DIRS = 20;

interface SkillDirSpec {
  dir: string;
  runtime: SkillRuntime;
  scope: SkillMentionScope;
  plugin?: string;
  projectDir?: string;
}

export interface MentionSkillDiscoveryOptions {
  /** 테스트 주입용. 기본은 `os.homedir()`. */
  homeDir?: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * codex `agents/openai.yaml`의 `policy.allow_implicit_invocation: false`.
 * YAML 파서를 들이지 않는다 — 필요한 건 이 한 키다.
 */
function codexImplicitDisabled(skillDir: string): boolean {
  try {
    const raw = readFileSync(join(skillDir, 'agents', 'openai.yaml'), 'utf8');
    return /^\s*allow_implicit_invocation:\s*false\s*$/m.test(raw);
  } catch {
    return false;
  }
}

function invocationFor(runtime: SkillRuntime, skillDir: string, disableModelInvocation: boolean): SkillInvocation {
  // 서로의 플래그는 무시된다(C0b): codex는 `disable-model-invocation`을 읽지 않는다.
  if (runtime === 'claude') return disableModelInvocation ? 'launch' : 'model';
  return codexImplicitDisabled(skillDir) ? 'explicit' : 'model';
}

function scanSkillDir(spec: SkillDirSpec): MentionSkillEntry[] {
  if (!isDir(spec.dir)) return [];
  let names: string[];
  try {
    names = readdirSync(spec.dir);
  } catch {
    return [];
  }

  const entries: MentionSkillEntry[] = [];
  for (const name of names) {
    // `.system`은 별도 root로 본다. 숨김 폴더·느슨한 파일은 스킬이 아니다.
    if (name.startsWith('.')) continue;
    const skillDir = join(spec.dir, name);
    const skillPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let raw = '';
    let mtime: string | undefined;
    try {
      raw = readFileSync(skillPath, 'utf8');
      mtime = statSync(skillPath).mtime.toISOString();
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    const bareName = frontmatter.name?.trim() || name;
    entries.push({
      runtime: spec.runtime,
      name: spec.plugin ? `${spec.plugin}:${bareName}` : bareName,
      description: frontmatter.description?.trim() || `${bareName} skill`,
      scope: spec.scope,
      ...(spec.plugin ? { plugin: spec.plugin } : {}),
      invocation: invocationFor(spec.runtime, skillDir, frontmatter.disableModelInvocation ?? false),
      skillPath,
      ...(spec.projectDir ? { projectDir: spec.projectDir } : {}),
      ...(mtime ? { updatedAt: mtime } : {}),
    });
  }
  return entries;
}

// ─── claude plugins ─────────────────────────────────────────────

/** user → project → local 순으로 덮어쓴 `enabledPlugins`. */
function claudeEnabledPlugins(homeDir: string, projectDir: string | undefined): Map<string, boolean> {
  const layers = [join(homeDir, '.claude', 'settings.json')];
  if (projectDir) {
    layers.push(join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json'));
  }
  const enabled = new Map<string, boolean>();
  for (const path of layers) {
    const map = asRecord(asRecord(readJson(path))?.enabledPlugins);
    if (!map) continue;
    for (const [id, value] of Object.entries(map)) {
      if (typeof value === 'boolean') enabled.set(id, value);
    }
  }
  return enabled;
}

function claudePluginSkillDirs(homeDir: string, projectDir: string | undefined): SkillDirSpec[] {
  const pluginsRoot = join(homeDir, '.claude', 'plugins');
  const enabled = claudeEnabledPlugins(homeDir, projectDir);
  const specs: SkillDirSpec[] = [];
  const seen = new Set<string>();

  const installed = asRecord(asRecord(readJson(join(pluginsRoot, 'installed_plugins.json')))?.plugins);
  for (const [id, value] of Object.entries(installed ?? {})) {
    if (enabled.get(id) !== true || !Array.isArray(value)) continue;
    // 같은 plugin이 user와 project scope에 함께 설치될 수 있다(egm 실측). user scope
    // 이거나 이 projectDir 소속인 설치만 이 세션에 로드된다.
    const install = value
      .map(asRecord)
      .find((entry) => entry && typeof entry.installPath === 'string' && (
        entry.scope === 'user'
        || (projectDir !== undefined && typeof entry.projectPath === 'string' && resolve(entry.projectPath) === resolve(projectDir))
      ));
    if (!install) continue;
    const plugin = id.split('@')[0];
    if (seen.has(plugin)) continue;
    seen.add(plugin);
    specs.push({ dir: join(String(install.installPath), 'skills'), runtime: 'claude', scope: 'plugin', plugin });
  }

  // 조직 동기화 plugin — `installed_plugins.json`에 없다(E6). 명시적으로 끄지 않는 한 켜져 있다.
  const syncedRoot = join(pluginsRoot, 'synced');
  for (const bucket of safeReaddir(syncedRoot)) {
    for (const plugin of safeReaddir(join(syncedRoot, bucket))) {
      if (seen.has(plugin) || enabled.get(`${plugin}@synced`) === false) continue;
      const dir = join(syncedRoot, bucket, plugin, 'skills');
      if (!isDir(dir)) continue;
      seen.add(plugin);
      specs.push({ dir, runtime: 'claude', scope: 'plugin', plugin });
    }
  }
  return specs;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

// ─── codex plugins ──────────────────────────────────────────────

/** `config.toml`에서 `[plugins."name@market"]` 아래 `enabled = true`인 id들. */
export function parseCodexEnabledPlugins(toml: string): string[] {
  const enabled: string[] = [];
  let current: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      const plugin = /^plugins\."([^"]+)"$/.exec(section[1].trim());
      current = plugin ? plugin[1] : null;
      continue;
    }
    if (current && /^\s*enabled\s*=\s*true\s*$/.test(line)) {
      enabled.push(current);
      current = null;
    }
  }
  return enabled;
}

/** `plugins/cache/<market>/<name>/<version>` 중 가장 최근 것. */
function latestVersionDir(pluginDir: string): string | undefined {
  const versions = safeReaddir(pluginDir)
    .map((name) => join(pluginDir, name))
    .filter(isDir)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return versions[0]?.path;
}

function codexPluginSkillDirs(homeDir: string): SkillDirSpec[] {
  const codexHome = join(homeDir, '.codex');
  let toml = '';
  try {
    toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const specs: SkillDirSpec[] = [];
  for (const id of parseCodexEnabledPlugins(toml)) {
    const at = id.lastIndexOf('@');
    if (at <= 0) continue;
    const plugin = id.slice(0, at);
    const market = id.slice(at + 1);
    const version = latestVersionDir(join(codexHome, 'plugins', 'cache', market, plugin));
    if (!version) continue;
    specs.push({ dir: join(version, 'skills'), runtime: 'codex', scope: 'plugin', plugin });
  }
  return specs;
}

// ─── roots ──────────────────────────────────────────────────────

function projectSkillDirs(runtime: SkillRuntime, projectDir: string): SkillDirSpec[] {
  if (runtime === 'claude') {
    return [{ dir: join(projectDir, '.claude', 'skills'), runtime, scope: 'project', projectDir }];
  }
  return [
    { dir: join(projectDir, '.codex', 'skills'), runtime, scope: 'project', projectDir },
    { dir: join(projectDir, '.agents', 'skills'), runtime, scope: 'project', projectDir },
  ];
}

function userSkillDirs(runtime: SkillRuntime, homeDir: string): SkillDirSpec[] {
  if (runtime === 'claude') {
    return [{ dir: join(homeDir, '.claude', 'skills'), runtime, scope: 'user' }];
  }
  return [
    { dir: join(homeDir, '.codex', 'skills'), runtime, scope: 'user' },
    { dir: join(homeDir, '.agents', 'skills'), runtime, scope: 'user' },
    { dir: join(homeDir, '.codex', 'skills', '.system'), runtime, scope: 'system' },
  ];
}

/** 같은 이름은 먼저 나온 것이 이긴다 — 순서가 곧 우선순위다. */
function dedupeByName(entries: MentionSkillEntry[]): MentionSkillEntry[] {
  const byName = new Map<string, MentionSkillEntry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

function uncachedDiscover(runtime: SkillRuntime, projectDir: string | undefined, homeDir: string): MentionSkillEntry[] {
  const project = projectDir ? projectSkillDirs(runtime, projectDir) : [];
  const user = userSkillDirs(runtime, homeDir);
  const plugins = runtime === 'claude'
    ? claudePluginSkillDirs(homeDir, projectDir)
    : codexPluginSkillDirs(homeDir);
  // claude: user가 project를 가린다(personal > project). codex: 실측 root 순서(C0)대로 project가 먼저.
  const order = runtime === 'claude' ? [...user, ...project, ...plugins] : [...project, ...user, ...plugins];
  return dedupeByName(order.flatMap(scanSkillDir));
}

const cache = new Map<string, { at: number; entries: MentionSkillEntry[] }>();

/** 테스트용 — 캐시를 비운다. */
export function clearMentionSkillCache(): void {
  cache.clear();
}

/** runtime × projectDir 세션이 보는 스킬 목록 (30초 캐시). */
export function discoverMentionSkills(
  runtime: SkillRuntime,
  projectDir: string | undefined,
  options: MentionSkillDiscoveryOptions = {},
): MentionSkillEntry[] {
  // `process.env.HOME`을 먼저 본다 — Bun의 `os.homedir()`는 시작 시점 값을 고정해,
  // 런타임에 HOME을 바꾸는 테스트 격리가 먹지 않는다.
  const homeDir = options.homeDir ?? (process.env.HOME || homedir());
  const key = `${homeDir}\u0000${runtime}\u0000${projectDir ?? ''}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.entries;
  const entries = uncachedDiscover(runtime, projectDir, homeDir);
  cache.set(key, { at: now, entries });
  return entries;
}

function projectOnlyEntries(runtime: SkillRuntime, projectDir: string): MentionSkillEntry[] {
  return projectSkillDirs(runtime, projectDir).flatMap(scanSkillDir);
}

export interface SkillPoolInput {
  runtime: AgentRuntime;
  projectDir?: string;
  /** 보드에 등장하는 projectDir들 — 다른 프로젝트 전용 스킬(회색 행)의 출처. */
  knownProjectDirs?: string[];
}

/**
 * 멘션 검색 풀. 지금 카드에서 고를 수 있는 스킬 + 고를 수 없는 이유가 붙은 스킬.
 *
 * - opencode 카드: 스킬 멘션을 지원하지 않는다 — claude 목록을 회색으로만 보여준다.
 * - 같은 디렉토리, 다른 런타임에서만 보이는 스킬: `runtime_mismatch`
 * - 다른 프로젝트의 project 스킬: `other_project`
 */
export function buildSkillMentionPool(
  input: SkillPoolInput,
  options: MentionSkillDiscoveryOptions = {},
): SkillPoolEntry[] {
  const projectDir = input.projectDir?.trim() || undefined;
  if (input.runtime === 'opencode') {
    return discoverMentionSkills('claude', projectDir, options)
      .map((entry) => ({ ...entry, unavailable: 'runtime_unsupported' as const }));
  }

  const runtime: SkillRuntime = input.runtime;
  const available = discoverMentionSkills(runtime, projectDir, options);
  const taken = new Set(available.map((entry) => entry.name));
  const pool: SkillPoolEntry[] = [...available];

  const otherRuntime: SkillRuntime = runtime === 'claude' ? 'codex' : 'claude';
  for (const entry of discoverMentionSkills(otherRuntime, projectDir, options)) {
    if (taken.has(entry.name)) continue;
    taken.add(entry.name);
    pool.push({ ...entry, unavailable: 'runtime_mismatch' });
  }

  const others = [...new Set((input.knownProjectDirs ?? []).map((dir) => dir.trim()).filter(Boolean))]
    .filter((dir) => !projectDir || resolve(dir) !== resolve(projectDir))
    .slice(0, MAX_OTHER_PROJECT_DIRS);
  for (const dir of others) {
    for (const entry of projectOnlyEntries(runtime, dir)) {
      if (taken.has(entry.name)) continue;
      taken.add(entry.name);
      pool.push({ ...entry, unavailable: 'other_project' });
    }
  }
  return pool;
}

/** 이 세션에서 그 이름의 스킬 — 없으면 고를 수 없는 이유를 담은 풀 항목. */
export function findSkillForMention(
  name: string,
  input: SkillPoolInput,
  options: MentionSkillDiscoveryOptions = {},
): SkillPoolEntry | undefined {
  return buildSkillMentionPool(input, options).find((entry) => entry.name === name);
}
