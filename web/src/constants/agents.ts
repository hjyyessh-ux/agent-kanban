import { normalizeAgentType } from '../../../src/core/agent-type';
import { PRIMARY_AGENT_CONFIGS } from '../../../src/core/agent-config';

const PRIMARY_AGENT_VISUALS = {
  sisyphus: { emoji: '🪨', color: '#0066FF', textColor: '#FFFFFF' },
  hephaestus: { emoji: '🔨', color: '#FF6B35', textColor: '#FFFFFF' },
  prometheus: { emoji: '🔥', color: '#FF3366', textColor: '#FFFFFF' },
  atlas: { emoji: '🌍', color: '#00CC66', textColor: '#FFFFFF' },
} as const;

export const AGENT_CONFIGS = PRIMARY_AGENT_CONFIGS.map((agent) => ({
  key: agent.key,
  label: agent.label,
  subtitle: agent.subtitle,
  model: agent.model,
  ...PRIMARY_AGENT_VISUALS[agent.key],
}));

const AGENT_DISPLAY_OVERRIDES = {
  explore: { label: 'Explore', subtitle: 'Codebase Search', emoji: '🔎', color: '#6366F1', textColor: '#FFFFFF' },
  librarian: { label: 'Librarian', subtitle: 'Reference Search', emoji: '📚', color: '#9B59B6', textColor: '#FFFFFF' },
  oracle: { label: 'Oracle', subtitle: 'Deep Review', emoji: '🔮', color: '#1A1A2E', textColor: '#FFFFFF' },
  plan: { label: 'Plan', subtitle: 'Planning Agent', emoji: '📝', color: '#14B8A6', textColor: '#FFFFFF' },
  metis: { label: 'Metis', subtitle: 'Pre-Planning', emoji: '🧠', color: '#F59E0B', textColor: '#1A1A2E' },
  momus: { label: 'Momus', subtitle: 'Quality Review', emoji: '🧐', color: '#CC2244', textColor: '#FFFFFF' },
  'multimodal-looker': { label: 'Multimodal-Looker', subtitle: 'Vision Review', emoji: '👁️', color: '#0F766E', textColor: '#FFFFFF' },
  'sisyphus-junior': { label: 'Sisyphus-Junior', subtitle: 'Subtask Worker', emoji: '🪨', color: '#2563EB', textColor: '#FFFFFF' },
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
