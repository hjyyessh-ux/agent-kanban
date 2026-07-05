import { useCallback, useState } from "react";
import type {
  RuntimeCatalogEntry,
  RuntimeCatalogModel,
} from "../../../src/core/runtime-config";
import { CLAUDE_MODELS, CODEX_MODELS } from "../../../src/core/runtime-config";
import { fetchModels } from "./useKanbanApi";

// localStorage keys. Everything here is browser-local by design.
export const ENABLED_MODELS_KEY = "kanban-enabled-models";
export const SYNCED_MODELS_KEY = "kanban-synced-models";
const MIGRATION_KEY = "kanban-enabled-models-migrated-v2";

export interface SyncedCatalog {
  claude: RuntimeCatalogModel[];
  codex: RuntimeCatalogModel[];
  syncedAt: string | null;
}

const EMPTY_CATALOG: SyncedCatalog = { claude: [], codex: [], syncedAt: null };

export function readSyncedCatalog(): SyncedCatalog {
  try {
    const raw = localStorage.getItem(SYNCED_MODELS_KEY);
    if (!raw) return EMPTY_CATALOG;
    const parsed = JSON.parse(raw) as Partial<SyncedCatalog>;
    return {
      claude: Array.isArray(parsed.claude) ? parsed.claude : [],
      codex: Array.isArray(parsed.codex) ? parsed.codex : [],
      syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : null,
    };
  } catch {
    return EMPTY_CATALOG;
  }
}

function writeSyncedCatalog(catalog: SyncedCatalog): void {
  try {
    localStorage.setItem(SYNCED_MODELS_KEY, JSON.stringify(catalog));
  } catch {
    // ignore quota / disabled storage
  }
}

/**
 * Merge synced Claude/Codex models into the runtime catalog (hardcoded entries
 * first, synced extras appended, dedup by id). Used at the single point every
 * dialog reads the catalog from (useRuntimes).
 */
export function mergeSyncedModels(
  runtimes: RuntimeCatalogEntry[],
): RuntimeCatalogEntry[] {
  const synced = readSyncedCatalog();
  if (synced.claude.length === 0 && synced.codex.length === 0) return runtimes;
  return runtimes.map((entry) => {
    const extra =
      entry.runtime === "claude"
        ? synced.claude
        : entry.runtime === "codex"
          ? synced.codex
          : [];
    if (extra.length === 0) return entry;
    const seen = new Set((entry.models ?? []).map((m) => m.id));
    const merged: RuntimeCatalogModel[] = [...(entry.models ?? [])];
    for (const m of extra) {
      if (!seen.has(m.id)) {
        merged.push(m);
        seen.add(m.id);
      }
    }
    return { ...entry, models: merged };
  });
}

/** null = no stored preference => every model is visible. */
export function readEnabledSet(): Set<string> | null {
  try {
    const raw = localStorage.getItem(ENABLED_MODELS_KEY);
    if (!raw) return null;
    return new Set<string>(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function isModelVisible(id: string, enabled: Set<string> | null): boolean {
  if (!enabled) return true;
  return enabled.has(id);
}

/**
 * One-time backward-compat seed. Before this feature the visibility filter only
 * covered Opencode models, so an existing `kanban-enabled-models` set contains
 * no Claude/Codex ids. Extending the filter to those runtimes would otherwise
 * hide them all — seed the currently-known ids once so they stay visible.
 */
export function migrateEnabledSet(): void {
  try {
    if (localStorage.getItem(MIGRATION_KEY)) return;
    const raw = localStorage.getItem(ENABLED_MODELS_KEY);
    if (raw) {
      const set = new Set<string>(JSON.parse(raw));
      for (const m of CLAUDE_MODELS) set.add(m.id);
      for (const m of CODEX_MODELS) set.add(m.id);
      localStorage.setItem(ENABLED_MODELS_KEY, JSON.stringify([...set]));
    }
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch {
    // ignore
  }
}

// Run the migration at import time so it is applied before any component reads
// the enabled-set into initial state.
migrateEnabledSet();

function claudeTier(id: string): string | undefined {
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "fable";
  return undefined;
}

function bareModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

export interface SyncOutcome {
  added: number;
  syncedAt?: string;
  error?: string;
}

/**
 * Pull the live provider/model list from the backend (`/api/models`) and derive
 * any new Claude/Codex runtime models from it. Only the `anthropic` provider maps
 * to the Claude runtime and `openai`-family providers to Codex, because their bare
 * model ids match the CLI runtime id format; other providers (e.g. github-copilot)
 * use a different id shape and are left to the Opencode runtime.
 */
export function useModelSync() {
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const sync = useCallback(async (): Promise<SyncOutcome> => {
    setSyncing(true);
    try {
      const models = await fetchModels();
      const hardClaude = new Set<string>(CLAUDE_MODELS.map((m) => m.id));
      const hardCodex = new Set<string>(CODEX_MODELS.map((m) => m.id));
      const prev = readSyncedCatalog();
      const claudeMap = new Map(prev.claude.map((m) => [m.id, m]));
      const codexMap = new Map(prev.codex.map((m) => [m.id, m]));
      let added = 0;

      for (const info of models) {
        const bare = bareModelId(info.id);
        if (info.providerID === "anthropic" && bare.startsWith("claude-")) {
          if (!hardClaude.has(bare) && !claudeMap.has(bare)) {
            claudeMap.set(bare, {
              id: bare,
              label: info.name || bare,
              tier: claudeTier(bare),
            });
            added += 1;
          }
        } else if (
          (info.providerID === "openai" || info.providerID.includes("openai")) &&
          (bare.startsWith("gpt") || bare.startsWith("o"))
        ) {
          if (!hardCodex.has(bare) && !codexMap.has(bare)) {
            codexMap.set(bare, { id: bare, label: info.name || bare, tier: "general" });
            added += 1;
          }
        }
      }

      const syncedAt = new Date().toISOString();
      const next: SyncedCatalog = {
        claude: [...claudeMap.values()],
        codex: [...codexMap.values()],
        syncedAt,
      };
      writeSyncedCatalog(next);

      // Keep newly-synced models visible by default when a preference exists.
      try {
        const rawEnabled = localStorage.getItem(ENABLED_MODELS_KEY);
        if (rawEnabled) {
          const set = new Set<string>(JSON.parse(rawEnabled));
          for (const m of next.claude) set.add(m.id);
          for (const m of next.codex) set.add(m.id);
          localStorage.setItem(ENABLED_MODELS_KEY, JSON.stringify([...set]));
        }
      } catch {
        // ignore
      }

      const result: SyncOutcome = { added, syncedAt };
      setOutcome(result);
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : "Sync failed";
      const result: SyncOutcome = { added: 0, error };
      setOutcome(result);
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  return { sync, syncing, outcome };
}
