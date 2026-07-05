import { useCallback, useEffect, useState } from "react";
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

const LEGACY_KEY = "kanban-agent-model-preference";
const RUNTIME_VALUES: AgentRuntime[] = ["opencode", "codex", "claude"];
const CLAUDE_PERMISSION_VALUES: ClaudePermissionMode[] = ["acceptEdits", "bypassPermissions", "plan", "dontAsk"];

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

function isClaudePermissionMode(value: string): value is ClaudePermissionMode {
  return CLAUDE_PERMISSION_VALUES.includes(value as ClaudePermissionMode);
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
    } else if (entry.key === "agent.codex.bypass_approvals_and_sandbox") {
      prefs.codexBypassApprovalsAndSandbox = entry.value === "true";
    } else if (entry.key === "agent.defaults.claude" && entry.value.trim()) {
      prefs.claude = entry.value;
    } else if (entry.key.startsWith("agent.defaults.opencode.") && entry.value.trim()) {
      prefs.opencode = prefs.opencode ?? {};
      prefs.opencode[entry.key.slice("agent.defaults.opencode.".length)] = entry.value;
    } else if (entry.key === "agent.claude.permission_mode" && isClaudePermissionMode(entry.value)) {
      prefs.claudePermissionMode = entry.value;
    } else if (entry.key === "agent.claude.dangerously_skip_permissions") {
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

async function saveSettingKey(key: string, value: string): Promise<void> {
  const category = key.startsWith("agent.codex.") ? "agent.codex" : "agent.claude";
  await fetch(`/api/settings/by-key/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, description: key, category, masked: false }),
  });
}

export function useRuntimeDefaults() {
  const [prefs, setPrefs] = useState<RuntimeModelPreference>(() => loadPrefs());

  useEffect(() => {
    setPrefs(loadPrefs());
    let cancelled = false;
    void loadServerPrefs()
      .then((serverPrefs) => {
        if (cancelled) return;
        setPrefs((current) => {
          const next = mergePrefs(serverPrefs, current);
          try {
            localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
          } catch {
            return next;
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefault = useCallback((path: "runtime" | "codex" | "claude" | `opencode.${string}`, value: string) => {
    setPrefs((current) => {
      const next: RuntimeModelPreference = {
        ...current,
        opencode: { ...(current.opencode ?? {}) },
      };
      if (path === "runtime") {
        next.runtime = value as AgentRuntime;
      } else if (path === "codex") {
        next.codex = value;
      } else if (path === "claude") {
        next.claude = value;
      } else if (path.startsWith("opencode.")) {
        next.opencode![path.slice("opencode.".length)] = value;
      }
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveServerDefault(path, value).catch(() => {});
      return next;
    });
  }, []);

  const setClaudePermissionMode = useCallback((value: ClaudePermissionMode) => {
    setPrefs((current) => {
      const next = { ...current, claudePermissionMode: value };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveSettingKey("agent.claude.permission_mode", value).catch(() => {});
      return next;
    });
  }, []);

  const setCodexBypassApprovalsAndSandbox = useCallback((value: boolean) => {
    setPrefs((current) => {
      const next = { ...current, codexBypassApprovalsAndSandbox: value };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveSettingKey("agent.codex.bypass_approvals_and_sandbox", String(value)).catch(() => {});
      return next;
    });
  }, []);

  const setCodexReasoningEffort = useCallback((value: CodexReasoningEffort) => {
    setPrefs((current) => {
      const next = { ...current, codexReasoningEffort: value };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveServerDefault("codex.reasoning_effort", value).catch(() => {});
      return next;
    });
  }, []);

  const setCodexSandbox = useCallback((value: CodexSandboxMode) => {
    setPrefs((current) => {
      const next = { ...current, codexSandbox: value };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveServerDefault("codex.sandbox", value).catch(() => {});
      return next;
    });
  }, []);

  const setClaudeDangerouslySkipPermissions = useCallback((value: boolean) => {
    setPrefs((current) => {
      const next = { ...current, claudeDangerouslySkipPermissions: value };
      localStorage.setItem(RUNTIME_MODEL_PREFERENCE_KEY, JSON.stringify(next));
      void saveSettingKey("agent.claude.dangerously_skip_permissions", String(value)).catch(() => {});
      return next;
    });
  }, []);

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
