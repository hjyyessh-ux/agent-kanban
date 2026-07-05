const PRIMARY_AGENT_TYPE_ALIASES: Record<string, string> = {
  sisyphus: 'sisyphus',
  'sisyphus (ultraworker)': 'sisyphus',
  hephaestus: 'hephaestus',
  'hephaestus (deep agent)': 'hephaestus',
  prometheus: 'prometheus',
  'prometheus (plan builder)': 'prometheus',
  atlas: 'atlas',
  'atlas (plan executor)': 'atlas',
  'sisyphus-junior': 'sisyphus-junior',
  'multimodal-looker': 'multimodal-looker',
};

export function normalizeAgentType(agentType?: string): string | undefined {
  if (!agentType) return undefined;

  const normalized = agentType.trim().toLowerCase();
  if (!normalized) return undefined;

  if (PRIMARY_AGENT_TYPE_ALIASES[normalized]) {
    return PRIMARY_AGENT_TYPE_ALIASES[normalized];
  }

  if (normalized === 'sisyphus-junior' || normalized === 'multimodal-looker') {
    return normalized;
  }

  if (normalized.startsWith('sisyphus')) return 'sisyphus';
  if (normalized.startsWith('hephaestus')) return 'hephaestus';
  if (normalized.startsWith('prometheus')) return 'prometheus';
  if (normalized.startsWith('atlas')) return 'atlas';

  return normalized;
}
