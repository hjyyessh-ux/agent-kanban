import type { SettingsStore } from './settings-store';
import type { QuickActionParameterValue } from './types';

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_EXACT_KEYS = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'SHLVL',
  'IFS',
  'CDPATH',
  'ENV',
  'BASH_ENV',
  'BASHOPTS',
  'SHELLOPTS',
  'GLOBIGNORE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'RUBYLIB',
  'BUN_INSTALL',
  'KANBAN_DATA_DIR',
  'KANBAN_PORT',
]);
const RESERVED_PREFIXES = ['AK_PARAM_', 'AGENT_KANBAN_', 'LD_', 'DYLD_'];
export const EXECUTION_OUTPUT_BYTE_CAP = 8192;
const TRUNCATED_SUFFIX = '\n... (truncated)';

export interface BuildExecutionEnvironmentInput {
  settingsStore?: SettingsStore;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  parameterValues?: Readonly<Record<string, QuickActionParameterValue>>;
  secretParameterKeys?: ReadonlySet<string>;
}

export interface ExecutionEnvironment {
  env: Record<string, string>;
  secretValues: string[];
  ignoredSettingKeys: string[];
}

function isReservedSettingKey(key: string): boolean {
  return RESERVED_EXACT_KEYS.has(key)
    || RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function parameterEnvironmentKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid script parameter key: ${key}`);
  }
  const upperSnake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .toUpperCase();
  return `AK_PARAM_${upperSnake}`;
}

export async function buildExecutionEnvironment(
  input: BuildExecutionEnvironmentInput = {},
): Promise<ExecutionEnvironment> {
  const env = Object.fromEntries(
    Object.entries(input.baseEnv ?? process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  for (const key of Object.keys(env)) {
    if (key.startsWith('AK_PARAM_')) delete env[key];
  }
  const ignoredSettingKeys: string[] = [];
  const secretValues: string[] = [];

  if (input.settingsStore) {
    const entries = await input.settingsStore.getEntries();
    for (const entry of entries) {
      if (entry.masked !== false && entry.value.length > 0) {
        secretValues.push(entry.value);
      }
      if (!ENVIRONMENT_KEY_PATTERN.test(entry.key) || isReservedSettingKey(entry.key)) {
        ignoredSettingKeys.push(entry.key);
        continue;
      }
      env[entry.key] = entry.value;
    }
  }

  const parameterEnvKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(input.parameterValues ?? {})) {
    const envKey = parameterEnvironmentKey(key);
    const existingKey = parameterEnvKeys.get(envKey);
    if (existingKey) {
      throw new Error(`Script parameter environment collision: ${existingKey}, ${key}`);
    }
    parameterEnvKeys.set(envKey, key);
    const normalizedValue = String(value);
    if (normalizedValue.includes('\0')) {
      throw new Error(`Script parameter contains a null byte: ${key}`);
    }
    env[envKey] = normalizedValue;
    if (input.secretParameterKeys?.has(key) && normalizedValue.length > 0) {
      secretValues.push(normalizedValue);
    }
  }

  return {
    env,
    ignoredSettingKeys,
    secretValues: Array.from(new Set(secretValues)).sort((left, right) => right.length - left.length),
  };
}

export function redactSecrets(text: string | undefined, secretValues: readonly string[]): string | undefined {
  if (text === undefined) return undefined;
  let redacted = text;
  for (const secret of secretValues) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

export function capExecutionOutput(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= EXECUTION_OUTPUT_BYTE_CAP) return text;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = EXECUTION_OUTPUT_BYTE_CAP;
  while (end > 0) {
    try {
      return `${decoder.decode(bytes.subarray(0, end))}${TRUNCATED_SUFFIX}`;
    } catch {
      end -= 1;
    }
  }
  return TRUNCATED_SUFFIX.trimStart();
}
