import { useEffect, useMemo, useState } from "react";
import type { RuntimeCatalogEntry } from "../../../src/core/runtime-config";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
} from "../../../src/core/runtime-config";
import type { AgentRuntime } from "../../../src/core/types";
import { AGENT_CONFIGS } from "../constants/agents";
import { fetchModels, type ModelInfo } from "./useKanbanApi";
import { readEnabledSet, isModelVisible } from "./useModelCatalog";
import { useRuntimeDefaults } from "./useRuntimeDefaults";
import { useRuntimes } from "./useRuntimes";

const LEGACY_AGENT_MODEL_PREFERENCE_KEY = "kanban-agent-model-preference";
const RUNTIME_ORDER: AgentRuntime[] = ["codex", "claude", "opencode"];
const DEFAULT_OPENCODE_AGENT = "sisyphus";

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export interface RuntimeModelSelectionState {
  orderedRuntimes: RuntimeCatalogEntry[];
  displayedModels: RuntimeModelOption[];
  getDefaultModelForRuntime: (runtime: AgentRuntime, agentType?: string) => string;
  isModelAvailableForRuntime: (modelId: string, runtime: AgentRuntime, agentType?: string) => boolean;
  persistRuntimeSelection: (runtime: AgentRuntime) => void;
  persistModelSelection: (runtime: AgentRuntime, modelId: string, agentType?: string) => void;
}

function readAgentModelPreference(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LEGACY_AGENT_MODEL_PREFERENCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === "string" && value.trim()) {
        acc[key] = value;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function writeAgentModelPreference(agentKey: string, modelId: string): void {
  if (!agentKey || !modelId) return;
  const current = readAgentModelPreference();
  current[agentKey] = modelId;
  try {
    localStorage.setItem(LEGACY_AGENT_MODEL_PREFERENCE_KEY, JSON.stringify(current));
  } catch {
    return;
  }
}

function getFallbackModelForAgent(agentKey: string, availableModels: ModelInfo[]): string {
  if (availableModels.length === 0) return "";

  const configuredDefault = AGENT_CONFIGS.find((agent) => agent.key === agentKey)?.model;
  if (configuredDefault && availableModels.some((model) => model.id === configuredDefault)) {
    return configuredDefault;
  }

  if (agentKey === "atlas") {
    const atlasLike = availableModels.find((model) =>
      /sonnet|executor/i.test(`${model.id} ${model.name}`),
    );
    if (atlasLike) return atlasLike.id;
  }

  const generalDefault = availableModels.find((model) =>
    /gpt-5\.4|opus|claude/i.test(`${model.id} ${model.name}`),
  );
  if (generalDefault) return generalDefault.id;

  return availableModels[0]?.id ?? "";
}

export function useRuntimeModelSelection(
  runtime: AgentRuntime,
  agentType = DEFAULT_OPENCODE_AGENT,
): RuntimeModelSelectionState {
  const { runtimes } = useRuntimes();
  const { prefs, setDefault } = useRuntimeDefaults();
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const filteredOpencodeModels = useMemo(() => {
    const enabled = readEnabledSet();
    return models.filter((model) => isModelVisible(model.id, enabled));
  }, [models]);

  const orderedRuntimes = useMemo(
    () => [...runtimes].sort((a, b) => {
      const aIndex = RUNTIME_ORDER.indexOf(a.runtime);
      const bIndex = RUNTIME_ORDER.indexOf(b.runtime);
      return (aIndex === -1 ? RUNTIME_ORDER.length : aIndex)
        - (bIndex === -1 ? RUNTIME_ORDER.length : bIndex);
    }),
    [runtimes],
  );

  const claudeModels = useMemo(
    () => runtimes.find((entry) => entry.runtime === "claude")?.models ?? [],
    [runtimes],
  );
  const codexModels = useMemo(
    () => runtimes.find((entry) => entry.runtime === "codex")?.models ?? [],
    [runtimes],
  );

  const displayedModels = useMemo<RuntimeModelOption[]>(() => {
    const enabled = readEnabledSet();
    if (runtime === "codex") {
      return codexModels
        .filter((model) => isModelVisible(model.id, enabled))
        .map((model) => ({
          id: model.id,
          label: `${model.label}${model.tier ? ` (${model.tier})` : ""}`,
        }));
    }
    if (runtime === "claude") {
      return claudeModels
        .filter((model) => isModelVisible(model.id, enabled))
        .map((model) => ({
          id: model.id,
          label: `${model.label}${model.tier ? ` (${model.tier})` : ""}`,
        }));
    }
    return filteredOpencodeModels.map((model) => ({
      id: model.id,
      label: `${model.name} (${model.providerName})`,
    }));
  }, [claudeModels, codexModels, filteredOpencodeModels, runtime]);

  const getDefaultModelForRuntime = (targetRuntime: AgentRuntime, targetAgentType = agentType): string => {
    if (targetRuntime === "codex") {
      return prefs.codex && codexModels.some((model) => model.id === prefs.codex)
        ? prefs.codex
        : codexModels[0]?.id ?? DEFAULT_CODEX_MODEL;
    }

    if (targetRuntime === "claude") {
      return prefs.claude && claudeModels.some((model) => model.id === prefs.claude)
        ? prefs.claude
        : claudeModels[0]?.id ?? DEFAULT_CLAUDE_MODEL;
    }

    const preferred = readAgentModelPreference()[targetAgentType];
    return preferred && filteredOpencodeModels.some((model) => model.id === preferred)
      ? preferred
      : getFallbackModelForAgent(targetAgentType, filteredOpencodeModels);
  };

  const isModelAvailableForRuntime = (modelId: string, targetRuntime: AgentRuntime): boolean => {
    if (!modelId) return false;
    if (targetRuntime === "codex") {
      return codexModels.some((model) => model.id === modelId);
    }
    if (targetRuntime === "claude") {
      return claudeModels.some((model) => model.id === modelId);
    }
    return filteredOpencodeModels.some((model) => model.id === modelId);
  };

  const persistRuntimeSelection = (targetRuntime: AgentRuntime) => {
    setDefault("runtime", targetRuntime);
  };

  const persistModelSelection = (targetRuntime: AgentRuntime, modelId: string, targetAgentType = agentType) => {
    if (!modelId) return;
    if (targetRuntime === "opencode") {
      writeAgentModelPreference(targetAgentType, modelId);
      return;
    }
    if (targetRuntime === "codex") {
      setDefault("codex", modelId);
      return;
    }
    setDefault("claude", modelId);
  };

  return {
    orderedRuntimes,
    displayedModels,
    getDefaultModelForRuntime,
    isModelAvailableForRuntime,
    persistRuntimeSelection,
    persistModelSelection,
  };
}
