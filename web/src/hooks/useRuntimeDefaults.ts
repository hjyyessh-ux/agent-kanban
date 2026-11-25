import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRuntime,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
} from "../../../src/core/types";
import {
  CODEX_REASONING_EFFORT_SETTING_KEY,
  CODEX_REASONING_EFFORT_VALUES,
  CODEX_SANDBOX_SETTING_KEY,
  CODEX_SANDBOX_VALUES,
  RUNTIME_MODEL_PREFERENCE_KEY,
} from "../../../src/core/runtime-config";
import {
  CLAUDE_PERMISSION_MODE_SETTING_KEY,
  CLAUDE_SKIP_PERMISSIONS_SETTING_KEY,
  CODEX_BYPASS_SETTING_KEY,
  isClaudePermissionMode,
} from "../../../src/core/runtime-options";

const LEGACY_KEY = "kanban-agent-model-preference";
const RUNTIME_VALUES: AgentRuntime[] = ["opencode", "codex", "claude"];

type SettingsEntry = {
  key: string;
  value: string;
};

export type RuntimeModelPreference = {
  runtime?: AgentRuntime;
  opencode?: Record<string, string>;
  codex?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandbox?: CodexSandboxMode;
  codexBypassApprovalsAndSandbox?: boolean;
  claude?: string;
  claudePermissionMode?: ClaudePermissionMode;
  claudeDangerouslySkipPermissions?: boolean;
};

function loadPrefs(): RuntimeModelPreference {
  try {
    const raw = localStorage.getItem(RUNTIME_MODEL_PREFERENCE_KEY);
    if (raw) return JSON.parse(raw) as RuntimeModelPreference;

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = { opencode: JSON.parse(legacy) as Record<string, string> };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    return {};
  }
  return {};
}

function isAgentRuntime(value: string): value is AgentRuntime {
  return RUNTIME_VALUES.includes(value as AgentRuntime);
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORT_VALUES.includes(value as CodexReasoningEffort);
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return CODEX_SANDBOX_VALUES.includes(value as CodexSandboxMode);
}

function mergePrefs(serverPrefs: RuntimeModelPreference, current: RuntimeModelPreference): RuntimeModelPreference {
  return {
    runtime: current.runtime ?? serverPrefs.runtime,
    opencode: { ...(serverPrefs.opencode ?? {}), ...(current.opencode ?? {}) },
    codex: current.codex ?? serverPrefs.codex,
    codexReasoningEffort: current.codexReasoningEffort ?? serverPrefs.codexReasoningEffort,
    codexSandbox: current.codexSandbox ?? serverPrefs.codexSandbox,
    codexBypassApprovalsAndSandbox:
      current.codexBypassApprovalsAndSandbox ?? serverPrefs.codexBypassApprovalsAndSandbox,
    claude: current.claude ?? serverPrefs.claude,
    claudePermissionMode: current.claudePermissionMode ?? serverPrefs.claudePermissionMode,
    claudeDangerouslySkipPermissions:
      current.claudeDangerouslySkipPermissions ?? serverPrefs.claudeDangerouslySkipPermissions,
  };
}

async function loadServerPrefs(): Promise<RuntimeModelPreference> {
  const res = await fetch("/api/settings");
  if (!res.ok) return {};
  const entries = (await res.json()) as unknown;
  if (!Array.isArray(entries)) return {};

  const prefs: RuntimeModelPreference = {};
  for (const entry of entries as SettingsEntry[]) {
    if (!entry || typeof entry.key !== "string" || typeof entry.value !== "string") continue;
    if (entry.key === "agent.defaults.runtime" && isAgentRuntime(entry.value)) {
      prefs.runtime = entry.value;
    } else if (entry.key === "agent.defaults.codex" && entry.value.trim()) {
      prefs.codex = entry.value;
    } else if (entry.key === CODEX_REASONING_EFFORT_SETTING_KEY && isCodexReasoningEffort(entry.value)) {
      prefs.codexReasoningEffort = entry.value;
    } else if (entry.key === CODEX_SANDBOX_SETTING_KEY && isCodexSandboxMode(entry.value)) {
      prefs.codexSandbox = entry.value;
    } else if (entry.key === CODEX_BYPASS_SETTING_KEY) {
      prefs.codexBypassApprovalsAndSandbox = entry.value === "true";
    } else if (entry.key === "agent.defaults.claude" && entry.value.trim()) {
      prefs.claude = entry.value;
    } else if (entry.key.startsWith("agent.defaults.opencode.") && entry.value.trim()) {
      prefs.opencode = prefs.opencode ?? {};
      prefs.opencode[entry.key.slice("agent.defaults.opencode.".length)] = entry.value;
    } else if (entry.key === CLAUDE_PERMISSION_MODE_SETTING_KEY && isClaudePermissionMode(entry.value)) {
      prefs.claudePermissionMode = entry.value;
    } else if (entry.key === CLAUDE_SKIP_PERMISSIONS_SETTING_KEY) {
      prefs.claudeDangerouslySkipPermissions = entry.value === "true";
    }
  }
  return prefs;
}

async function saveServerDefault(path: string, value: string): Promise<void> {
  await fetch(`/api/settings/by-key/${encodeURIComponent(`agent.defaults.${path}`)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, description: `Default for ${path}`, category: "agent.defaults", masked: false }),
  });
}

/** Option fields the browser remembers on its own — never written to the server. */
type BrowserOptionKey =
  | "codexReasoningEffort"
  | "codexSandbox"
  | "codexBypassApprovalsAndSandbox"
  | "claudePermissionMode"
  | "claudeDangerouslySkipPermissions";

/**
 * Runtime/model defaults plus the permission/effort options the web dialogs
 * start from. `prefs` = this browser's own choices (localStorage) over the
 * server values. Option setters here are **browser-only**: the server-side
 * defaults that API-created cards use are edited only in Settings
 * (`RuntimeDefaultsPanel`), so a choice made in a dialog never leaks into
 * API/Telegram/scheduler runs.
 */
export function useRuntimeDefaults() {
  const [localPrefs, setLocalPrefs] = useState<RuntimeModelPreference>(() => loadPrefs());
  const [serverPrefs, setServerPrefs] = useState<RuntimeModelPreference>({});

  useEffect(() => {
    setLocalPrefs(loadPrefs());
    let cancelled = false;
    void loadServerPrefs()
      .then((next) => {
        if (!cancelled) setServerPrefs(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const prefs = useMemo(() => mergePrefs(serverPrefs, localPrefs), [serverPrefs, localPrefs]);

  const writeLocal = useCallback((update: (current: RuntimeModelPreference) => RuntimeModelPreference) => {
    setLocalPrefs((current) => {
      const next = update(current);
      try {
        localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      } catch {
        return next;
      }
      return next;
    });
  }, []);

  const setDefault = useCallback((path: "runtime" | "codex" | "claude" | `opencode.${string}`, value: string) => {
    writeLocal((current) => {
      const next: RuntimeModelPreference = { ...current, opencode: { ...(current.opencode ?? {}) } };
      if (path === "runtime") {
        next.runtime = value as AgentRuntime;
      } else if (path === "codex") {
        next.codex = value;
      } else if (path === "claude") {
        next.claude = value;
      } else if (path.startsWith("opencode.")) {
        next.opencode![path.slice("opencode.".length)] = value;
      }
      return next;
    });
    void saveServerDefault(path, value).catch(() => {});
  }, [writeLocal]);

  const setBrowserOption = useCallback(<K extends BrowserOptionKey>(key: K, value: RuntimeModelPreference[K]) => {
    writeLocal((current) => ({ ...current, [key]: value }));
  }, [writeLocal]);

  const setClaudePermissionMode = useCallback(
    (value: ClaudePermissionMode) => setBrowserOption("claudePermissionMode", value),
    [setBrowserOption],
  );
  const setClaudeDangerouslySkipPermissions = useCallback(
    (value: boolean) => setBrowserOption("claudeDangerouslySkipPermissions", value),
    [setBrowserOption],
  );
  const setCodexReasoningEffort = useCallback(
    (value: CodexReasoningEffort) => setBrowserOption("codexReasoningEffort", value),
    [setBrowserOption],
  );
  const setCodexSandbox = useCallback(
    (value: CodexSandboxMode) => setBrowserOption("codexSandbox", value),
    [setBrowserOption],
  );
  const setCodexBypassApprovalsAndSandbox = useCallback(
    (value: boolean) => setBrowserOption("codexBypassApprovalsAndSandbox", value),
    [setBrowserOption],
  );

  return {
    prefs,
    setDefault,
    setCodexReasoningEffort,
    setCodexSandbox,
    setCodexBypassApprovalsAndSandbox,
    setClaudePermissionMode,
    setClaudeDangerouslySkipPermissions,
  };
}
