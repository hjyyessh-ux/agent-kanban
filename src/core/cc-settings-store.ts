import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ContextDiagnostics, SkillVisibility } from './types';
import { FileLock } from './filelock';

export const USER_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

type SkillOverrideValue = 'on' | 'name-only' | 'user-invocable-only' | 'off';

interface CcSettings {
  skillOverrides?: Record<string, SkillOverrideValue>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
}

function readSettingsFile(path: string): CcSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CcSettings;
  } catch {
    return {};
  }
}

// Precedence: local > project > user (same as Claude Code's scope resolution).
function mergeSettings(
  user: CcSettings,
  project: CcSettings,
  local: CcSettings,
): CcSettings {
  return {
    skillOverrides: {
      ...(user.skillOverrides ?? {}),
      ...(project.skillOverrides ?? {}),
      ...(local.skillOverrides ?? {}),
    },
    enabledMcpjsonServers:
      local.enabledMcpjsonServers ?? project.enabledMcpjsonServers ?? user.enabledMcpjsonServers,
    disabledMcpjsonServers:
      local.disabledMcpjsonServers ?? project.disabledMcpjsonServers ?? user.disabledMcpjsonServers,
    enableAllProjectMcpServers:
      local.enableAllProjectMcpServers ?? project.enableAllProjectMcpServers ?? user.enableAllProjectMcpServers,
  };
}

/**
 * Returns true if ANTHROPIC_BASE_URL points to a non-Anthropic endpoint
 * (Vertex AI, a proxy, etc.). Returns false if unset.
 */
export function detectVertexOrProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return false;
  try {
    return !new URL(baseUrl).hostname.endsWith('anthropic.com');
  } catch {
    return false;
  }
}

/**
 * Returns true if the current model runtime is expected to support tool search.
 * Haiku models don't support it. Unknown model → assume supported (conservative).
 */
export function detectRuntimeSupportsToolSearch(env: NodeJS.ProcessEnv = process.env): boolean {
  const model = (env.ANTHROPIC_MODEL ?? env.CLAUDE_MODEL ?? '').toLowerCase();
  return !model.includes('haiku');
}

/**
 * Derive the effective ENABLE_TOOL_SEARCH state and compute toolSearchEffective.
 * Logic source: design doc §진단 로직 (verified facts, §0).
 */
export function computeToolSearchEffective(opts: {
  enableToolSearch: string;
  runtimeSupportsToolSearch: boolean;
  isVertexOrProxy: boolean;
}): boolean {
  const { enableToolSearch, runtimeSupportsToolSearch, isVertexOrProxy } = opts;
  if (enableToolSearch === 'false') return false;
  if (!runtimeSupportsToolSearch) return false;
  if (isVertexOrProxy && enableToolSearch !== 'true') return false;
  return true;
}

/**
 * Read CC settings from ~/.claude/settings.json, <project>/.claude/settings.json,
 * and <project>/.claude/settings.local.json, apply precedence, and compute diagnostics.
 *
 * @param projectDir - project directory for project/local settings files
 * @param env - process env override (for testing)
 * @param userSettingsPath - override for ~/.claude/settings.json (for testing)
 */
export async function readCcDiagnostics(
  projectDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  userSettingsPath: string = USER_SETTINGS_PATH,
): Promise<{
  diagnostics: ContextDiagnostics;
  skillOverrides: Record<string, SkillOverrideValue>;
}> {
  const userSettings = readSettingsFile(userSettingsPath);
  const projectSettings = projectDir
    ? readSettingsFile(join(projectDir, '.claude', 'settings.json'))
    : {};
  const localSettings = projectDir
    ? readSettingsFile(join(projectDir, '.claude', 'settings.local.json'))
    : {};

  const merged = mergeSettings(userSettings, projectSettings, localSettings);

  const rawEts = env.ENABLE_TOOL_SEARCH;
  const enableToolSearch = rawEts === undefined ? 'unset' : rawEts;

  const runtimeSupportsToolSearch = detectRuntimeSupportsToolSearch(env);
  const isVertexOrProxy = detectVertexOrProxy(env);

  const toolSearchEffective = computeToolSearchEffective({
    enableToolSearch,
    runtimeSupportsToolSearch,
    isVertexOrProxy,
  });

  // userScopeMcpCount / alwaysLoadCount are filled by the inventory route
  // after reading the MCP inventory.
  const diagnostics: ContextDiagnostics = {
    enableToolSearch,
    toolSearchEffective,
    runtimeSupportsToolSearch,
    userScopeMcpCount: 0,
    alwaysLoadCount: 0,
  };

  return {
    diagnostics,
    skillOverrides: merged.skillOverrides ?? {},
  };
}

// ─── Write helpers for skillOverrides ────────────────────────────────────────

const _settingsFileLocks = new Map<string, FileLock>();
const _settingsMutexChains = new Map<string, Promise<void>>();

function getSettingsFileLock(settingsPath: string): FileLock {
  if (!_settingsFileLocks.has(settingsPath)) {
    _settingsFileLocks.set(settingsPath, new FileLock(`${settingsPath}.lock`));
  }
  return _settingsFileLocks.get(settingsPath)!;
}

async function withSettingsLock<T>(settingsPath: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = _settingsMutexChains.get(settingsPath) ?? Promise.resolve();
  _settingsMutexChains.set(settingsPath, new Promise<void>((res) => { release = res; }));
  await prev;
  try {
    return await getSettingsFileLock(settingsPath).withLock(fn);
  } finally {
    release();
  }
}

function readSettingsRaw(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function computeOverrideResult(
  current: Record<string, unknown>,
  skillName: string,
  value: SkillOverrideValue | null,
): Record<string, unknown> {
  // Deep-clone to avoid mutation of caller's object
  const cloned = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
  const overrides = ((cloned.skillOverrides ?? {}) as Record<string, string>);

  if (value === null) {
    delete overrides[skillName];
  } else {
    overrides[skillName] = value;
  }

  if (Object.keys(overrides).length === 0) {
    delete cloned.skillOverrides;
  } else {
    cloned.skillOverrides = overrides;
  }
  return cloned;
}

/**
 * Preview (dry-run) a skillOverride change without writing.
 * Returns old/new JSON strings for diff display.
 */
export function previewSkillOverride(
  settingsPath: string,
  skillName: string,
  value: SkillOverrideValue | null,
): { oldContent: string; newContent: string } {
  const current = readSettingsRaw(settingsPath);
  const updated = computeOverrideResult(current, skillName, value);
  const oldContent = JSON.stringify(current, null, 2) + '\n';
  const newContent = JSON.stringify(updated, null, 2) + '\n';
  return { oldContent, newContent };
}

/**
 * Atomically set or remove a skillOverride in a settings.json file.
 * value=null removes the entry. All unknown top-level keys are preserved.
 * Uses in-process mutex + FileLock for dual-locking.
 */
export async function setSkillOverride(
  settingsPath: string,
  skillName: string,
  value: SkillOverrideValue | null,
): Promise<{ oldContent: string; newContent: string }> {
  return withSettingsLock(settingsPath, async () => {
    const current = readSettingsRaw(settingsPath);
    const updated = computeOverrideResult(current, skillName, value);

    const oldContent = JSON.stringify(current, null, 2) + '\n';
    const newContent = JSON.stringify(updated, null, 2) + '\n';

    if (oldContent !== newContent) {
      const dir = dirname(settingsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmpPath = `${settingsPath}.tmp`;
      writeFileSync(tmpPath, newContent, 'utf8');
      renameSync(tmpPath, settingsPath);
    }

    return { oldContent, newContent };
  });
}

/**
 * Compute SkillVisibility for one skill given skillOverrides and the
 * disable-model-invocation frontmatter flag.
 */
export function computeSkillVisibility(
  skillName: string,
  disableModelInvocation: boolean,
  skillOverrides: Record<string, SkillOverrideValue>,
): SkillVisibility {
  const override = skillOverrides[skillName] ?? null;
  const effectivelyHidden = override === 'off' || disableModelInvocation;
  return { override, disableModelInvocation, effectivelyHidden };
}
