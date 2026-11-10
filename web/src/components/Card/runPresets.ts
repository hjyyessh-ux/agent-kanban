import type {
  ClaudeEffort,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
} from "../../../../src/core/types";
import {
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_EFFORT_VALUES,
  CODEX_SANDBOX_VALUES,
} from "../../../../src/core/runtime-config";

/**
 * NEW TASK `실행 프리셋`: one favorite = runtime · model · permission · effort.
 * Claude permission = `--permission-mode`, Codex permission = sandbox.
 * Claude effort `auto` = no `--effort` flag (the CLI default).
 * The danger checkboxes (`--dangerously-skip-permissions`, Codex bypass) are
 * deliberately NOT part of a preset — they stay an explicit per-task choice.
 */
export type PresetRuntime = "claude" | "codex";
export type ClaudePresetEffort = ClaudeEffort | "auto";

export type RunPreset =
  | { runtime: "claude"; model: string; permission: ClaudePermissionMode; effort: ClaudePresetEffort }
  | { runtime: "codex"; model: string; permission: CodexSandboxMode; effort: CodexReasoningEffort };

/** 3 columns × 2 rows: a 7th chip would push the grid to a third row. */
export const RUN_PRESET_LIMIT = 6;

export const PRESET_RUNTIMES: readonly PresetRuntime[] = ["claude", "codex"];

export interface PresetOption<T extends string> {
  value: T;
  short: string;
  danger?: boolean;
}

export const CLAUDE_PERMISSION_OPTIONS: readonly PresetOption<ClaudePermissionMode>[] = [
  { value: "plan", short: "plan" },
  { value: "acceptEdits", short: "edits" },
  { value: "bypassPermissions", short: "bypass", danger: true },
  { value: "dontAsk", short: "dontAsk" },
];

export const CODEX_SANDBOX_OPTIONS: readonly PresetOption<CodexSandboxMode>[] = [
  { value: "read-only", short: "RO" },
  { value: "workspace-write", short: "WS" },
  { value: "danger-full-access", short: "full", danger: true },
];

const EFFORT_SHORT: Record<string, string> = {
  auto: "auto",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export const CLAUDE_EFFORT_OPTIONS: readonly PresetOption<ClaudePresetEffort>[] = [
  { value: "auto", short: "auto" },
  ...CLAUDE_EFFORT_VALUES.map((value) => ({ value, short: EFFORT_SHORT[value] ?? value })),
];

export const CODEX_EFFORT_OPTIONS: readonly PresetOption<CodexReasoningEffort>[] =
  CODEX_REASONING_EFFORT_VALUES.map((value) => ({ value, short: EFFORT_SHORT[value] ?? value }));

export function permissionOptions(runtime: PresetRuntime): readonly PresetOption<string>[] {
  return runtime === "claude" ? CLAUDE_PERMISSION_OPTIONS : CODEX_SANDBOX_OPTIONS;
}

export function effortOptions(runtime: PresetRuntime): readonly PresetOption<string>[] {
  return runtime === "claude" ? CLAUDE_EFFORT_OPTIONS : CODEX_EFFORT_OPTIONS;
}

export function permissionShort(preset: RunPreset): string {
  return permissionOptions(preset.runtime).find((o) => o.value === preset.permission)?.short ?? preset.permission;
}

export function effortShort(preset: RunPreset): string {
  return EFFORT_SHORT[preset.effort] ?? preset.effort;
}

/** `plan · high` — the chip's second line. */
export function presetOptionLine(preset: RunPreset): string {
  return `${permissionShort(preset)} · ${effortShort(preset)}`;
}

export function isDangerPermission(preset: RunPreset): boolean {
  return permissionOptions(preset.runtime).some((o) => o.value === preset.permission && o.danger);
}

/** Catalog labels carry a ` (1M context)` suffix — the chip shows it as a tag instead. */
export function splitModelLabel(label: string): { name: string; tag?: string } {
  const match = /^(.*?)\s*\((1M) context\)\s*$/.exec(label);
  return match ? { name: match[1], tag: match[2] } : { name: label };
}

export function sameRunPreset(a: RunPreset | null | undefined, b: RunPreset | null | undefined): boolean {
  if (!a || !b) return false;
  return a.runtime === b.runtime && a.model === b.model && a.permission === b.permission && a.effort === b.effort;
}

export function findRunPreset(presets: readonly RunPreset[], target: RunPreset): number {
  return presets.findIndex((preset) => sameRunPreset(preset, target));
}

/** Runtime switch inside the picker: keep what still makes sense, reset the rest. */
export function presetForRuntime(
  runtime: PresetRuntime,
  model: string,
  defaults: { claudePermission: ClaudePermissionMode; claudeEffort: ClaudePresetEffort; codexSandbox: CodexSandboxMode; codexEffort: CodexReasoningEffort },
): RunPreset {
  return runtime === "claude"
    ? { runtime, model, permission: defaults.claudePermission, effort: defaults.claudeEffort }
    : { runtime, model, permission: defaults.codexSandbox, effort: defaults.codexEffort };
}

export type PresetAddResult =
  | { kind: "added"; presets: RunPreset[] }
  | { kind: "duplicate"; index: number }
  | { kind: "full" };

export function addRunPreset(presets: readonly RunPreset[], preset: RunPreset): PresetAddResult {
  const index = findRunPreset(presets, preset);
  if (index >= 0) return { kind: "duplicate", index };
  if (presets.length >= RUN_PRESET_LIMIT) return { kind: "full" };
  return { kind: "added", presets: [...presets, preset] };
}

/** Overwrites slot `index` in place — order (= the ⌥ number) is kept. Refuses to create a duplicate. */
export function replaceRunPreset(presets: readonly RunPreset[], index: number, preset: RunPreset): RunPreset[] | null {
  if (index < 0 || index >= presets.length) return null;
  const dup = findRunPreset(presets, preset);
  if (dup >= 0 && dup !== index) return null;
  return presets.map((existing, i) => (i === index ? preset : existing));
}

export function moveRunPreset(presets: readonly RunPreset[], index: number, delta: -1 | 1): RunPreset[] {
  const target = index + delta;
  if (index < 0 || index >= presets.length || target < 0 || target >= presets.length) return [...presets];
  const next = [...presets];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeRunPreset(presets: readonly RunPreset[], index: number): RunPreset[] {
  return presets.filter((_, i) => i !== index);
}

const CLAUDE_PERMISSIONS = new Set<string>(CLAUDE_PERMISSION_OPTIONS.map((o) => o.value));
const CLAUDE_EFFORTS = new Set<string>(CLAUDE_EFFORT_OPTIONS.map((o) => o.value));
const CODEX_SANDBOXES = new Set<string>(CODEX_SANDBOX_VALUES);
const CODEX_EFFORTS = new Set<string>(CODEX_REASONING_EFFORT_VALUES);

/** Parses one stored entry; anything malformed or from another runtime (opencode) is dropped. */
export function parseRunPreset(value: unknown): RunPreset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { runtime, model, permission, effort } = record;
  if (typeof model !== "string" || !model.trim()) return null;
  if (typeof permission !== "string" || typeof effort !== "string") return null;
  if (runtime === "claude" && CLAUDE_PERMISSIONS.has(permission) && CLAUDE_EFFORTS.has(effort)) {
    return { runtime, model, permission: permission as ClaudePermissionMode, effort: effort as ClaudePresetEffort };
  }
  if (runtime === "codex" && CODEX_SANDBOXES.has(permission) && CODEX_EFFORTS.has(effort)) {
    return { runtime, model, permission: permission as CodexSandboxMode, effort: effort as CodexReasoningEffort };
  }
  return null;
}

/** Dedupes and caps at the limit, so a hand-edited store can never break the grid. */
export function parseRunPresets(value: unknown): RunPreset[] {
  if (!Array.isArray(value)) return [];
  const out: RunPreset[] = [];
  for (const entry of value) {
    const preset = parseRunPreset(entry);
    if (!preset || findRunPreset(out, preset) >= 0) continue;
    out.push(preset);
    if (out.length >= RUN_PRESET_LIMIT) break;
  }
  return out;
}
