import { normalizeAgentType } from '../../../src/core/agent-type';
import { PRIMARY_AGENT_CONFIGS } from '../../../src/core/agent-config';

const PRIMARY_AGENT_VISUALS = {
  sisyphus: { emoji: '🪨', color: 'var(--kv2-agent-sisyphus)', textColor: 'var(--kv2-agent-text-on-fill)' },
  hephaestus: { emoji: '🔨', color: 'var(--kv2-agent-hephaestus)', textColor: 'var(--kv2-agent-text-on-fill)' },
  prometheus: { emoji: '🔥', color: 'var(--kv2-agent-prometheus)', textColor: 'var(--kv2-agent-text-on-fill)' },
  atlas: { emoji: '🌍', color: 'var(--kv2-agent-atlas)', textColor: 'var(--kv2-agent-text-on-fill)' },
} as const;

export const AGENT_CONFIGS = PRIMARY_AGENT_CONFIGS.map((agent) => ({
  key: agent.key,
  label: agent.label,
  subtitle: agent.subtitle,
  model: agent.model,
  ...PRIMARY_AGENT_VISUALS[agent.key],
}));

const AGENT_DISPLAY_OVERRIDES = {
  explore: { label: 'Explore', subtitle: 'Codebase Search', emoji: '🔎', color: 'var(--kv2-agent-explore)', textColor: 'var(--kv2-agent-text-on-fill)' },
  librarian: { label: 'Librarian', subtitle: 'Reference Search', emoji: '📚', color: 'var(--kv2-agent-librarian)', textColor: 'var(--kv2-agent-text-on-fill)' },
  oracle: { label: 'Oracle', subtitle: 'Deep Review', emoji: '🔮', color: 'var(--kv2-agent-oracle)', textColor: 'var(--kv2-agent-text-on-fill)' },
  plan: { label: 'Plan', subtitle: 'Planning Agent', emoji: '📝', color: 'var(--kv2-agent-plan)', textColor: 'var(--kv2-agent-text-on-fill)' },
  metis: { label: 'Metis', subtitle: 'Pre-Planning', emoji: '🧠', color: 'var(--kv2-agent-metis)', textColor: 'var(--kv2-agent-text-on-fill-dark)' },
  momus: { label: 'Momus', subtitle: 'Quality Review', emoji: '🧐', color: 'var(--kv2-agent-momus)', textColor: 'var(--kv2-agent-text-on-fill)' },
  'multimodal-looker': { label: 'Multimodal-Looker', subtitle: 'Vision Review', emoji: '👁️', color: 'var(--kv2-agent-multimodal-looker)', textColor: 'var(--kv2-agent-text-on-fill)' },
  'sisyphus-junior': { label: 'Sisyphus-Junior', subtitle: 'Subtask Worker', emoji: '🪨', color: 'var(--kv2-agent-sisyphus-junior)', textColor: 'var(--kv2-agent-text-on-fill)' },
} as const;

export type AgentKey = typeof AGENT_CONFIGS[number]['key'];

export function getAgentConfig(agentType?: string) {
  const normalized = normalizeAgentType(agentType);
  if (!normalized) return null;

  const directMatch = AGENT_CONFIGS.find(a => a.key === normalized);
  if (directMatch) return directMatch;

  const override = AGENT_DISPLAY_OVERRIDES[normalized as keyof typeof AGENT_DISPLAY_OVERRIDES];
  if (!override) return null;

  return {
    key: normalized,
    model: '',
    ...override,
  };
}
