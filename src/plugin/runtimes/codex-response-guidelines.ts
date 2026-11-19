import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SettingsStore } from '../../core/settings-store';
import {
  buildCodexDeveloperInstructions,
  buildCodexGuidelinePrefix,
  loadResponseGuidelines,
  prependGuidelinePrefix,
} from '../../core/response-guidelines';

/** Current Settings are delivered on every dispatch, without history comparison. */
export interface CodexGuidelineDelivery {
  configArgs: string[];
  stdinPrompt: string;
}

type ReadResult = { ok: true; value?: string } | { ok: false };

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readDeveloperInstructions(path: string): ReadResult {
  if (!existsSync(path)) return { ok: true };
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const profileName = stringOrUndefined(parsed.profile);
    const profiles = parsed.profiles as Record<string, Record<string, unknown> | undefined> | undefined;
    const fromProfile = profileName ? stringOrUndefined(profiles?.[profileName]?.developer_instructions) : undefined;
    return { ok: true, value: fromProfile ?? stringOrUndefined(parsed.developer_instructions) };
  } catch {
    return { ok: false };
  }
}

/**
 * Effective `developer_instructions` Codex would use for `cwd`: the nearest
 * project `.codex/config.toml` that sets it, else `$CODEX_HOME/config.toml`.
 * `ok: false` when a file exists but cannot be parsed — the caller must not
 * override then, or it would silently drop the user's instructions.
 */
export function readCodexDeveloperInstructions(cwd: string, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): ReadResult {
  const userConfig = join(codexHome, 'config.toml');
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, '.codex', 'config.toml');
    if (candidate !== userConfig) {
      const project = readDeveloperInstructions(candidate);
      if (!project.ok) return project;
      if (project.value) return project;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return readDeveloperInstructions(userConfig);
}

export async function planCodexGuidelineDelivery(input: {
  settingsStore?: SettingsStore;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  codexHome?: string;
}): Promise<CodexGuidelineDelivery> {
  const current = await loadResponseGuidelines(input.settingsStore);

  if (!current) return { configArgs: [], stdinPrompt: input.prompt };

  if (input.resumeSessionId) {
    return {
      configArgs: [],
      stdinPrompt: prependGuidelinePrefix(buildCodexGuidelinePrefix(current), input.prompt),
    };
  }

  const base = readCodexDeveloperInstructions(input.cwd, input.codexHome);
  if (!base.ok) {
    return {
      configArgs: [],
      stdinPrompt: prependGuidelinePrefix(buildCodexGuidelinePrefix(current), input.prompt),
    };
  }
  const value = buildCodexDeveloperInstructions(base.value, current);
  // JSON string escapes are valid TOML basic-string escapes.
  return {
    configArgs: ['-c', `developer_instructions=${JSON.stringify(value)}`],
    stdinPrompt: input.prompt,
  };
}
