import { describe, expect, test } from "bun:test";
import type { RuntimeCatalogEntry } from "../../../src/core/runtime-config";
import { mergeRuntimeCatalog } from "./useRuntimes";

describe("mergeRuntimeCatalog", () => {
  test("preserves current Codex defaults when the server returns an older catalog", () => {
    const remote: RuntimeCatalogEntry[] = [
      {
        runtime: "codex",
        label: "Codex",
        selection: "model",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", tier: "general" },
          { id: "gpt-5.7-preview", label: "GPT-5.7 Preview", tier: "preview" },
        ],
      },
    ];

    const codex = mergeRuntimeCatalog(remote).find((entry) => entry.runtime === "codex");
    const ids = codex?.models?.map((model) => model.id) ?? [];

    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids.filter((id) => id === "gpt-5.4")).toHaveLength(1);
    expect(ids).toContain("gpt-5.7-preview");
  });
});
