import { describe, expect, test } from "bun:test";
import {
  RUN_PRESET_LIMIT,
  addRunPreset,
  isDangerPermission,
  moveRunPreset,
  parseRunPresets,
  presetForRuntime,
  presetOptionLine,
  removeRunPreset,
  replaceRunPreset,
  sameRunPreset,
  splitModelLabel,
  type RunPreset,
} from "./runPresets";

const opus: RunPreset = { runtime: "claude", model: "claude-opus-4-8", permission: "plan", effort: "high" };
const codex: RunPreset = { runtime: "codex", model: "gpt-5.5", permission: "workspace-write", effort: "high" };
const six: RunPreset[] = [
  opus,
  codex,
  { runtime: "claude", model: "claude-opus-5-5", permission: "acceptEdits", effort: "xhigh" },
  { runtime: "codex", model: "gpt-5.6-sol", permission: "workspace-write", effort: "xhigh" },
  { runtime: "claude", model: "claude-fable-5-2", permission: "plan", effort: "max" },
  { runtime: "codex", model: "gpt-6-astra", permission: "read-only", effort: "medium" },
];

describe("runPresets", () => {
  test("a preset is the 4-tuple: any differing field is a different preset", () => {
    expect(sameRunPreset(opus, { ...opus })).toBe(true);
    expect(sameRunPreset(opus, { ...opus, effort: "max" })).toBe(false);
    expect(sameRunPreset(opus, { ...opus, permission: "acceptEdits" })).toBe(false);
    expect(sameRunPreset(opus, null)).toBe(false);
  });

  test("chip second line uses short labels per runtime", () => {
    expect(presetOptionLine(opus)).toBe("plan · high");
    expect(presetOptionLine(codex)).toBe("WS · high");
    expect(presetOptionLine({ ...opus, permission: "acceptEdits", effort: "auto" })).toBe("edits · auto");
    expect(presetOptionLine({ ...codex, permission: "danger-full-access", effort: "medium" })).toBe("full · med");
  });

  test("bypass / full access are flagged as danger", () => {
    expect(isDangerPermission({ ...opus, permission: "bypassPermissions" })).toBe(true);
    expect(isDangerPermission({ ...codex, permission: "danger-full-access" })).toBe(true);
    expect(isDangerPermission(opus)).toBe(false);
  });

  test("add: appends, refuses duplicates, reports full at the limit", () => {
    expect(addRunPreset([opus], codex)).toEqual({ kind: "added", presets: [opus, codex] });
    expect(addRunPreset([opus, codex], { ...codex })).toEqual({ kind: "duplicate", index: 1 });
    expect(six).toHaveLength(RUN_PRESET_LIMIT);
    expect(addRunPreset(six, { ...opus, model: "claude-sonnet-5" })).toEqual({ kind: "full" });
  });

  test("replace keeps the slot (⌥ number) and never creates a duplicate", () => {
    const next = replaceRunPreset(six, 1, { ...codex, effort: "xhigh" });
    expect(next?.[1]).toEqual({ ...codex, effort: "xhigh" });
    expect(next).toHaveLength(6);
    expect(replaceRunPreset(six, 1, opus)).toBeNull();
    expect(replaceRunPreset(six, 0, opus)).toEqual(six);
    expect(replaceRunPreset(six, 9, opus)).toBeNull();
  });

  test("move swaps neighbours and ignores out-of-range moves", () => {
    expect(moveRunPreset([opus, codex], 0, 1)).toEqual([codex, opus]);
    expect(moveRunPreset([opus, codex], 0, -1)).toEqual([opus, codex]);
    expect(removeRunPreset([opus, codex], 0)).toEqual([codex]);
  });

  test("runtime switch resets permission/effort to that runtime's defaults", () => {
    const defaults = { claudePermission: "plan" as const, claudeEffort: "auto" as const, codexSandbox: "workspace-write" as const, codexEffort: "medium" as const };
    expect(presetForRuntime("codex", "gpt-5.5", defaults)).toEqual({ runtime: "codex", model: "gpt-5.5", permission: "workspace-write", effort: "medium" });
    expect(presetForRuntime("claude", "claude-sonnet-5", defaults)).toEqual({ runtime: "claude", model: "claude-sonnet-5", permission: "plan", effort: "auto" });
  });

  test("parse drops opencode/garbage, dedupes and caps at 6", () => {
    const stored = [
      ...six,
      opus,
      { runtime: "opencode", model: "x", permission: "plan", effort: "high" },
      { runtime: "claude", model: "claude-sonnet-5", permission: "nope", effort: "high" },
      { runtime: "codex", model: "gpt-5.4", permission: "read-only", effort: "max" },
      "junk",
    ];
    expect(parseRunPresets(stored)).toEqual(six);
    expect(parseRunPresets([{ runtime: "codex", model: "gpt-5.4", permission: "read-only", effort: "max" }])).toEqual([]);
    expect(parseRunPresets(null)).toEqual([]);
  });

  test("model label: the 1M context suffix becomes a tag", () => {
    expect(splitModelLabel("Opus 5.5 (1M context)")).toEqual({ name: "Opus 5.5", tag: "1M" });
    expect(splitModelLabel("GPT-5.5")).toEqual({ name: "GPT-5.5" });
  });
});
