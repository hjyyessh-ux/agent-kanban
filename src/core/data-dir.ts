import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANONICAL_DIRNAME = '.agent-kanban';

interface ResolveOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

let cached: string | undefined;

export function resolveKanbanDataDir(options?: ResolveOptions): string {
  if (cached && !options) return cached;
  const resolved = resolveUncached(options);
  if (!options) cached = resolved;
  return resolved;
}

export function __resetKanbanDataDirCache(): void {
  cached = undefined;
}

function resolveUncached(options?: ResolveOptions): string {
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();

  const override = env.KANBAN_DATA_DIR?.trim();
  if (override) {
    ensureDir(override);
    return override;
  }

  const canonical = join(home, CANONICAL_DIRNAME);
  ensureDir(canonical);
  return canonical;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Expand a leading `~` to the user's home directory. Shared by all stores. */
export function resolveDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(homedir(), dir.slice(1));
  }
  return dir;
}
