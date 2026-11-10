import { useCallback, useState } from "react";
import {
  CLAUDE_EFFORT_OPTIONS,
  parseRunPresets,
  type ClaudePresetEffort,
  type RunPreset,
} from "../components/Card/runPresets";

/** Browser-local, like the Directory history: favorites are a per-person habit, not board data. */
export const RUN_PRESETS_STORAGE_KEY = "kanban-run-presets";

interface StoredRunPresets {
  presets: RunPreset[];
  /** Last Claude effort used — the picker's starting value. Codex keeps its server setting. */
  claudeEffort: ClaudePresetEffort;
}

const EMPTY: StoredRunPresets = { presets: [], claudeEffort: "auto" };

export function readRunPresets(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): StoredRunPresets {
  try {
    const raw = storage?.getItem(RUN_PRESETS_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const effort = parsed.claudeEffort;
    return {
      presets: parseRunPresets(parsed.presets),
      claudeEffort: CLAUDE_EFFORT_OPTIONS.some((o) => o.value === effort) ? (effort as ClaudePresetEffort) : "auto",
    };
  } catch {
    return EMPTY;
  }
}

function write(next: StoredRunPresets): void {
  try {
    localStorage.setItem(RUN_PRESETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
}

export function useRunPresets() {
  const [state, setState] = useState<StoredRunPresets>(() => readRunPresets());

  const setPresets = useCallback((presets: RunPreset[]) => {
    setState((current) => {
      const next = { ...current, presets: parseRunPresets(presets) };
      write(next);
      return next;
    });
  }, []);

  const setClaudeEffort = useCallback((claudeEffort: ClaudePresetEffort) => {
    setState((current) => {
      if (current.claudeEffort === claudeEffort) return current;
      const next = { ...current, claudeEffort };
      write(next);
      return next;
    });
  }, []);

  return { presets: state.presets, claudeEffort: state.claudeEffort, setPresets, setClaudeEffort };
}
