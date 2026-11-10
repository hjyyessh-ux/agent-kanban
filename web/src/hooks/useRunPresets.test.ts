import { describe, expect, test } from "bun:test";
import { RUN_PRESETS_STORAGE_KEY, readRunPresets } from "./useRunPresets";

const storage = (value: string | null) => ({
  getItem: (key: string) => (key === RUN_PRESETS_STORAGE_KEY ? value : null),
});

describe("readRunPresets", () => {
  test("empty / broken storage → no presets, Claude effort auto", () => {
    expect(readRunPresets(storage(null))).toEqual({ presets: [], claudeEffort: "auto" });
    expect(readRunPresets(storage("{not json"))).toEqual({ presets: [], claudeEffort: "auto" });
  });

  test("reads valid presets and the last Claude effort", () => {
    const value = JSON.stringify({
      presets: [{ runtime: "claude", model: "claude-opus-4-8", permission: "plan", effort: "high" }],
      claudeEffort: "xhigh",
    });
    expect(readRunPresets(storage(value))).toEqual({
      presets: [{ runtime: "claude", model: "claude-opus-4-8", permission: "plan", effort: "high" }],
      claudeEffort: "xhigh",
    });
  });

  test("an unknown Claude effort falls back to auto", () => {
    expect(readRunPresets(storage(JSON.stringify({ presets: [], claudeEffort: "ultra" }))).claudeEffort).toBe("auto");
  });
});
