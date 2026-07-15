import { useEffect, useState } from "react";
import type { RuntimeCatalogEntry } from "../../../src/core/runtime-config";
import { RUNTIME_CATALOG } from "../../../src/core/runtime-config";
import { fetchRuntimes } from "./useKanbanApi";
import { mergeSyncedModels } from "./useModelCatalog";

function mergeModels(
  fallback: RuntimeCatalogEntry["models"],
  remote: RuntimeCatalogEntry["models"],
): RuntimeCatalogEntry["models"] {
  const merged = [...(fallback ?? [])];
  const seen = new Set(merged.map((model) => model.id));
  for (const model of remote ?? []) {
    if (seen.has(model.id)) continue;
    merged.push(model);
    seen.add(model.id);
  }
  return merged;
}

export function mergeRuntimeCatalog(remote: RuntimeCatalogEntry[] | undefined): RuntimeCatalogEntry[] {
  if (!remote || remote.length === 0) return [...RUNTIME_CATALOG];
  const remoteByRuntime = new Map(remote.map((entry) => [entry.runtime, entry]));

  return RUNTIME_CATALOG.map((fallback) => {
    const entry = remoteByRuntime.get(fallback.runtime);
    if (!entry) return { ...fallback };

    return {
      ...fallback,
      ...entry,
      presets: entry.presets && entry.presets.length > 0 ? entry.presets : fallback.presets,
      models: mergeModels(fallback.models, entry.models),
      disabled: entry.disabled || entry.available === false,
    };
  });
}

export function useRuntimes() {
  const [runtimes, setRuntimes] = useState<RuntimeCatalogEntry[]>(() =>
    mergeSyncedModels([...RUNTIME_CATALOG]),
  );

  useEffect(() => {
    fetchRuntimes()
      .then((entries) => setRuntimes(mergeSyncedModels(mergeRuntimeCatalog(entries))))
      .catch(() => setRuntimes(mergeSyncedModels([...RUNTIME_CATALOG])));
  }, []);

  return { runtimes };
}
