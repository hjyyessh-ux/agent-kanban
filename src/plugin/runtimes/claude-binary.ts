import type { SettingsStore } from '../../core/settings-store';
import { getSettingValueOrDefault } from '../../core/settings-store';

export interface ClaudeBinaryResolver {
  (): Promise<string[]>;
  resetCache: () => void;
}

export function createClaudeBinaryResolver(deps: {
  settingsStore: SettingsStore;
  commandOverride?: string[];
}): ClaudeBinaryResolver {
  let cached: string[] | null = null;

  const resolveClaudeBinary = async (): Promise<string[]> => {
    if (deps.commandOverride) return deps.commandOverride;
    if (cached) return cached;

    const pathBin = Bun.which('claude');
    if (pathBin) {
      cached = ['claude'];
      return cached;
    }

    const pinned = await getSettingValueOrDefault(
      deps.settingsStore,
      'agent.claude.npx_version',
      '2.1.119',
    );
    cached = ['npx', '-y', `@anthropic-ai/claude-code@${pinned}`];
    return cached;
  };

  resolveClaudeBinary.resetCache = () => {
    cached = null;
  };

  return resolveClaudeBinary;
}
