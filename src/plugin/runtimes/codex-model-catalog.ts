import type { RuntimeCatalogEntry, RuntimeCatalogModel } from '../../core/runtime-config';
import { CODEX_MODELS } from '../../core/runtime-config';

const CODEX_MODEL_CACHE_MS = 5 * 60 * 1000;
const CODEX_MODEL_TIMEOUT_MS = 5_000;

interface CodexDebugModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

let cachedAt = 0;
let cachedModels: RuntimeCatalogModel[] | null = null;
let cachedCommandKey = '';

function tierForCodexModel(id: string): string {
  if (id.includes('mini')) return 'mini';
  if (id.includes('sol') || id.includes('terra') || id.includes('luna')) return 'frontier';
  if (id.includes('codex')) return 'codex';
  return 'general';
}

function parseCodexDebugModels(stdout: string): RuntimeCatalogModel[] {
  const parsed = JSON.parse(stdout) as { models?: CodexDebugModel[] };
  const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
  return rawModels
    .filter((model) => model.visibility === 'list')
    .sort((a, b) => {
      const aPriority = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
      const bPriority = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority;
    })
    .flatMap((model) => {
      if (typeof model.slug !== 'string' || !model.slug.trim()) return [];
      return [{
        id: model.slug,
        label: typeof model.display_name === 'string' && model.display_name.trim()
          ? model.display_name
          : model.slug,
        tier: tierForCodexModel(model.slug),
      }];
    });
}

async function runCodexDebugModels(command: string[]): Promise<RuntimeCatalogModel[]> {
  const proc = Bun.spawn([...command, 'debug', 'models'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, CODEX_MODEL_TIMEOUT_MS);
  if (typeof timeout === 'object' && 'unref' in timeout) {
    (timeout as NodeJS.Timeout).unref();
  }

  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) return [];
    return parseCodexDebugModels(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCodexCliModels(options: {
  commandOverride?: string[];
  forceRefresh?: boolean;
} = {}): Promise<RuntimeCatalogModel[]> {
  const now = Date.now();
  const command = options.commandOverride ?? ['codex'];
  const commandKey = JSON.stringify(command);
  if (
    !options.forceRefresh &&
    cachedModels &&
    cachedCommandKey === commandKey &&
    now - cachedAt < CODEX_MODEL_CACHE_MS
  ) {
    return cachedModels;
  }

  try {
    const models = await runCodexDebugModels(command);
    if (models.length > 0) {
      cachedAt = now;
      cachedCommandKey = commandKey;
      cachedModels = models;
      return models;
    }
  } catch {
    // Fall back to the checked-in catalog when Codex is unavailable or old.
  }
  return CODEX_MODELS.map((model) => ({ id: model.id, label: model.label, tier: model.tier }));
}

export async function mergeCodexCliModelsIntoCatalog(
  catalog: readonly RuntimeCatalogEntry[],
  options: { commandOverride?: string[] } = {},
): Promise<RuntimeCatalogEntry[]> {
  const codexModels = await getCodexCliModels({ commandOverride: options.commandOverride });
  return catalog.map((entry) => entry.runtime === 'codex'
    ? { ...entry, models: codexModels }
    : { ...entry });
}
