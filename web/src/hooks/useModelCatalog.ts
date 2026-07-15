import { useCallback, useState } from "react";
import type {
  RuntimeCatalogEntry,
  RuntimeCatalogModel,
} from "../../../src/core/runtime-config";
import { CLAUDE_MODELS, CODEX_MODELS } from "../../../src/core/runtime-config";
import { fetchModels, fetchRuntimes, type ModelInfo } from "./useKanbanApi";

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

function addCatalogModel(
  map: Map<string, RuntimeCatalogModel>,
  hardcoded: Set<string>,
  model: RuntimeCatalogModel,
): boolean {
  if (hardcoded.has(model.id) || map.has(model.id)) return false;
  map.set(model.id, model);
  return true;
}

export function deriveSyncedCatalog(input: {
  models: ModelInfo[];
  runtimes: RuntimeCatalogEntry[];
  previous: SyncedCatalog;
}): { catalog: SyncedCatalog; added: number } {
  const hardClaude = new Set<string>(CLAUDE_MODELS.map((m) => m.id));
  const hardCodex = new Set<string>(CODEX_MODELS.map((m) => m.id));
  const claudeMap = new Map(input.previous.claude.map((m) => [m.id, m]));
  const codexMap = new Map(input.previous.codex.map((m) => [m.id, m]));
  let added = 0;

  for (const entry of input.runtimes) {
    if (entry.runtime !== "claude" && entry.runtime !== "codex") continue;
    for (const model of entry.models ?? []) {
      const targetMap = entry.runtime === "claude" ? claudeMap : codexMap;
      const hardcoded = entry.runtime === "claude" ? hardClaude : hardCodex;
      if (addCatalogModel(targetMap, hardcoded, model)) added += 1;
    }
  }

  for (const info of input.models) {
    const bare = bareModelId(info.id);
    if (info.providerID === "anthropic" && bare.startsWith("claude-")) {
      if (addCatalogModel(claudeMap, hardClaude, {
        id: bare,
        label: info.name || bare,
        tier: claudeTier(bare),
      })) {
        added += 1;
      }
    } else if (
      (info.providerID === "openai" || info.providerID.includes("openai") || info.providerID === "codex") &&
      (bare.startsWith("gpt") || bare.startsWith("o"))
    ) {
      if (addCatalogModel(codexMap, hardCodex, {
        id: bare,
        label: info.name || bare,
        tier: "general",
      })) {
        added += 1;
      }
    }
  }

  return {
    added,
    catalog: {
      claude: [...claudeMap.values()],
      codex: [...codexMap.values()],
      syncedAt: new Date().toISOString(),
    },
  };
}

/**
 * Pull the live provider/model list from the backend (`/api/models`) and derive
 * any new Claude/Codex runtime models from it, then augment that with the runtime
 * catalog (`/api/runtimes`). Opencode-only providers keep their provider/model id
 * shape and are left to the Opencode runtime.
 */
export function useModelSync() {
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const sync = useCallback(async (): Promise<SyncOutcome> => {
    setSyncing(true);
    try {
      const [modelsResult, runtimesResult] = await Promise.allSettled([
        fetchModels(),
        fetchRuntimes(),
      ]);
      const models = modelsResult.status === "fulfilled" ? modelsResult.value : [];
      const runtimes = runtimesResult.status === "fulfilled" ? runtimesResult.value : [];
      if (modelsResult.status === "rejected" && runtimesResult.status === "rejected") {
        throw modelsResult.reason;
      }
      const prev = readSyncedCatalog();
      const { catalog: next, added } = deriveSyncedCatalog({ models, runtimes, previous: prev });
      writeSyncedCatalog(next);

      const result: SyncOutcome = { added, syncedAt: next.syncedAt ?? undefined };
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
