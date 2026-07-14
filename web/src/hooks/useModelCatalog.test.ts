import { describe, expect, test } from "bun:test";
import type { RuntimeCatalogEntry } from "../../../src/core/runtime-config";
import type { ModelInfo } from "./useKanbanApi";
import { deriveSyncedCatalog, type SyncedCatalog } from "./useModelCatalog";

const emptyPrevious: SyncedCatalog = { claude: [], codex: [], syncedAt: null };

describe("deriveSyncedCatalog", () => {
  test("adds Codex models from the runtime catalog", () => {
    const runtimes: RuntimeCatalogEntry[] = [
      {
        runtime: "codex",
        label: "Codex",
        selection: "model",
        models: [
          { id: "gpt-5.9-codex", label: "GPT-5.9 Codex", tier: "codex" },
        ],
      },
    ];

    const { catalog, added } = deriveSyncedCatalog({
      models: [],
      runtimes,
      previous: emptyPrevious,
    });

    expect(added).toBe(1);
    expect(catalog.codex).toEqual([
      { id: "gpt-5.9-codex", label: "GPT-5.9 Codex", tier: "codex" },
    ]);
  });

  test("classifies codex provider models as Codex runtime models", () => {
    const models: ModelInfo[] = [
      {
        id: "codex/gpt-5.9-codex",
        name: "GPT-5.9 Codex",
        providerID: "codex",
        providerName: "Codex",
      },
    ];

    const { catalog, added } = deriveSyncedCatalog({
      models,
      runtimes: [],
      previous: emptyPrevious,
    });

    expect(added).toBe(1);
    expect(catalog.codex).toEqual([
      { id: "gpt-5.9-codex", label: "GPT-5.9 Codex", tier: "general" },
    ]);
  });

  test("does not add hardcoded Codex models to the synced catalog", () => {
    const runtimes: RuntimeCatalogEntry[] = [
      {
        runtime: "codex",
        label: "Codex",
        selection: "model",
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", tier: "frontier" },
        ],
      },
    ];

    const { catalog, added } = deriveSyncedCatalog({
      models: [],
      runtimes,
      previous: emptyPrevious,
    });

    expect(added).toBe(0);
    expect(catalog.codex).toEqual([]);
  });
});
