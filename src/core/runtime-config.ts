import type { AgentRuntime, CodexReasoningEffort, CodexSandboxMode, KanbanCard } from './types';
import { PRIMARY_AGENT_CONFIGS, type PrimaryAgentConfig } from './agent-config';

export const RUNTIME_MODEL_PREFERENCE_KEY = 'kanban-runtime-model-preference';

export const CLAUDE_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', tier: 'fable' },
  { id: 'claude-opus-5', label: 'Opus 5 (1M context)', tier: 'opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (1M context)', tier: 'opus' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', tier: 'opus' },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5', tier: 'opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 'sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', tier: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'haiku' },
] as const;

export type ClaudeModelId = typeof CLAUDE_MODELS[number]['id'];
export const DEFAULT_CLAUDE_MODEL: ClaudeModelId = 'claude-sonnet-5';

export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', tier: 'frontier' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', tier: 'frontier' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', tier: 'frontier' },
  { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'general' },
  { id: 'gpt-5.4', label: 'GPT-5.4', tier: 'general' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', tier: 'mini' },
] as const;

export type CodexModelId = typeof CODEX_MODELS[number]['id'];
export const DEFAULT_CODEX_MODEL: CodexModelId = 'gpt-5.6-sol';
export const CODEX_REASONING_EFFORT_VALUES: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
export const CODEX_SANDBOX_VALUES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium';
export const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = 'workspace-write';
export const CODEX_REASONING_EFFORT_SETTING_KEY = 'agent.defaults.codex.reasoning_effort';
export const CODEX_SANDBOX_SETTING_KEY = 'agent.defaults.codex.sandbox';

export function isCodexModelValid(model: string): model is CodexModelId {
  return CODEX_MODELS.some(entry => entry.id === model);
}

export function isClaudeModelValid(model: string): model is ClaudeModelId {
  return CLAUDE_MODELS.some(entry => entry.id === model);
}

export type RuntimeSelectionKind = 'preset' | 'model';
export type RuntimeHostKind = 'opencode-plugin' | 'standalone-daemon';

export interface RuntimeCatalogModel {
  id: string;
  label: string;
  tier?: string;
}

export interface RuntimeCatalogEntry {
  runtime: AgentRuntime;
  label: string;
  selection: RuntimeSelectionKind;
  presets?: PrimaryAgentConfig[];
  models?: readonly RuntimeCatalogModel[];
  disabled?: boolean;
  available?: boolean;
  unavailableReason?: string;
  hostKind?: RuntimeHostKind;
}

export const RUNTIME_CATALOG: RuntimeCatalogEntry[] = [
  {
    runtime: 'opencode',
    label: 'Opencode',
    selection: 'preset',
    presets: PRIMARY_AGENT_CONFIGS,
  },
  {
    runtime: 'codex',
    label: 'Codex',
    selection: 'model',
    models: CODEX_MODELS,
  },
  {
    runtime: 'claude',
    label: 'Claude',
    selection: 'model',
    models: CLAUDE_MODELS,
  },
];

export function resolveAgentRuntime(card: Pick<KanbanCard, 'agentRuntime'>): AgentRuntime {
  return card.agentRuntime ?? 'opencode';
}

export function getRuntimeCatalog(runtime: AgentRuntime): RuntimeCatalogEntry {
  const found = RUNTIME_CATALOG.find(entry => entry.runtime === runtime);
  if (!found) throw new Error(`Unknown runtime: ${runtime}`);
  return found;
}
