import { normalizeAgentType } from './agent-type';

export interface PrimaryAgentConfig {
  key: 'sisyphus' | 'hephaestus' | 'prometheus' | 'atlas';
  label: string;
  subtitle: string;
  dispatchLabel: string;
  model: string;
}

export const DEFAULT_PRIMARY_MODEL = 'github-copilot/gpt-5.4';

export const PRIMARY_AGENT_CONFIGS: PrimaryAgentConfig[] = [
  {
    key: 'sisyphus',
    label: 'Sisyphus',
    subtitle: 'Ultraworker',
    dispatchLabel: 'Sisyphus (Ultraworker)',
    model: 'github-copilot/claude-opus-4.6',
  },
  {
    key: 'hephaestus',
    label: 'Hephaestus',
    subtitle: 'Deep Agent',
    dispatchLabel: 'Hephaestus (Deep Agent)',
    model: DEFAULT_PRIMARY_MODEL,
  },
  {
    key: 'prometheus',
    label: 'Prometheus',
    subtitle: 'Plan Builder',
    dispatchLabel: 'Prometheus (Plan Builder)',
    model: DEFAULT_PRIMARY_MODEL,
  },
  {
    key: 'atlas',
    label: 'Atlas',
    subtitle: 'Plan Executor',
    dispatchLabel: 'Atlas (Plan Executor)',
    model: DEFAULT_PRIMARY_MODEL,
  },
];

const PRIMARY_AGENT_CONFIG_MAP = new Map(PRIMARY_AGENT_CONFIGS.map(config => [config.key, config]));

export function getPrimaryAgentConfig(agentType?: string): PrimaryAgentConfig | undefined {
  const normalized = normalizeAgentType(agentType);
  if (!normalized) return undefined;
  return PRIMARY_AGENT_CONFIG_MAP.get(normalized as PrimaryAgentConfig['key']);
}

export function getDefaultModelForAgent(agentType?: string): string | undefined {
  return getPrimaryAgentConfig(agentType)?.model;
}

export function getPrimaryAgentDispatchLabel(agentType?: string): string | undefined {
  return getPrimaryAgentConfig(agentType)?.dispatchLabel;
}

export function getPrimaryAgentDisplayLabel(agentType?: string): string | undefined {
  return getPrimaryAgentConfig(agentType)?.label;
}
