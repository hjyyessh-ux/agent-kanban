import { useEffect, useState } from "react";
import type { RuntimeCatalogEntry } from "../../../src/core/runtime-config";
import { RUNTIME_CATALOG } from "../../../src/core/runtime-config";
import { fetchRuntimes } from "./useKanbanApi";
import { mergeSyncedModels } from "./useModelCatalog";

function mergeRuntimeCatalog(remote: RuntimeCatalogEntry[] | undefined): RuntimeCatalogEntry[] {
  if (!remote || remote.length === 0) return [...RUNTIME_CATALOG];
  const remoteByRuntime = new Map(remote.map((entry) => [entry.runtime, entry]));

  return RUNTIME_CATALOG.map((fallback) => {
    const entry = remoteByRuntime.get(fallback.runtime);
    if (!entry) return { ...fallback };

    return {
      ...fallback,
      ...entry,
      presets: entry.presets && entry.presets.length > 0 ? entry.presets : fallback.presets,
      models: entry.models && entry.models.length > 0 ? entry.models : fallback.models,
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
