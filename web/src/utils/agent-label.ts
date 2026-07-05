import { normalizeAgentType } from '../../../src/core/agent-type';

const AGENT_LABEL_OVERRIDES: Record<string, string> = {
  sisyphus: 'Sisyphus',
  hephaestus: 'Hephaestus',
  prometheus: 'Prometheus',
  atlas: 'Atlas',
  'sisyphus-junior': 'Sisyphus-Junior',
  'multimodal-looker': 'Multimodal-Looker',
};

export function formatAgentTypeLabel(agentType?: string): string | null {
  const normalized = normalizeAgentType(agentType);
  if (!normalized) return null;

  if (AGENT_LABEL_OVERRIDES[normalized]) {
    return AGENT_LABEL_OVERRIDES[normalized];
  }

  return normalized
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}
