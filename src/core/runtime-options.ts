/**
 * Runtime permission/effort options for Claude and Codex cards.
 *
 * Resolution order when a card is dispatched (first valid value wins):
 *   1. the card's own `claudeOptions` / `codexOptions`
 *   2. the server-side defaults saved from the Settings "실행 기본값" panel
 *   3. the built-in defaults below
 *
 * Unknown or invalid values (e.g. `"permissionMode": "default"`) are treated as
 * "not specified", so they fall through to the Settings default instead of
 * reaching the CLI. Browser-side choices in the web dialogs never write these
 * settings — they live only in the browser (see `useRuntimeDefaults`).
 */
import type {
  ClaudeEffort,
  ClaudeOptions,
  ClaudePermissionMode,
  CodexOptions,
  CodexReasoningEffort,
  CodexSandboxMode,
} from './types';
import {
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_EFFORT_SETTING_KEY,
  CODEX_REASONING_EFFORT_VALUES,
  CODEX_SANDBOX_SETTING_KEY,
  CODEX_SANDBOX_VALUES,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from './runtime-config';

export { CODEX_REASONING_EFFORT_SETTING_KEY, CODEX_SANDBOX_SETTING_KEY };

/** Matches `claude --permission-mode` choices (Claude Code 2.1.x). */
export const CLAUDE_PERMISSION_MODE_VALUES: readonly ClaudePermissionMode[] = [
  'acceptEdits',
  'plan',
  'auto',
  'manual',
  'dontAsk',
  'bypassPermissions',
];

export const CLAUDE_PERMISSION_MODE_SETTING_KEY = 'agent.claude.permission_mode';
export const CLAUDE_SKIP_PERMISSIONS_SETTING_KEY = 'agent.claude.dangerously_skip_permissions';
/** `auto` (or absent) → `--effort` is not sent. */
export const CLAUDE_EFFORT_SETTING_KEY = 'agent.defaults.claude.effort';
export const CODEX_BYPASS_SETTING_KEY = 'agent.codex.bypass_approvals_and_sandbox';
export const CODEX_SKIP_GIT_REPO_CHECK_SETTING_KEY = 'agent.codex.skip_git_repo_check';
/** Legacy env fallback for the Codex bypass default when no setting is stored. */
export const CODEX_BYPASS_ENV_KEY = 'KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX';

export type ClaudeEffortDefault = ClaudeEffort | 'auto';

export interface RuntimeOptionDefaults {
  claude: {
    permissionMode: ClaudePermissionMode;
    dangerouslySkipPermissions: boolean;
    effort: ClaudeEffortDefault;
  };
  codex: {
    sandbox: CodexSandboxMode;
    bypassApprovalsAndSandbox: boolean;
    skipGitRepoCheck: boolean;
    reasoningEffort: CodexReasoningEffort;
  };
}

export const BUILTIN_RUNTIME_OPTION_DEFAULTS: RuntimeOptionDefaults = {
  claude: { permissionMode: 'acceptEdits', dangerouslySkipPermissions: false, effort: 'auto' },
  codex: {
    sandbox: DEFAULT_CODEX_SANDBOX,
    bypassApprovalsAndSandbox: false,
    skipGitRepoCheck: true,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  },
};

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && (CLAUDE_PERMISSION_MODE_VALUES as readonly string[]).includes(value);
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === 'string' && (CLAUDE_EFFORT_VALUES as readonly string[]).includes(value);
}

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && (CODEX_SANDBOX_VALUES as readonly string[]).includes(value);
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && (CODEX_REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

function parseBooleanSetting(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Builds the effective defaults from stored settings. Each stored value is
 * validated on its own; a broken value falls back to the built-in default.
 */
export function runtimeOptionDefaultsFromSettings(
  lookup: (key: string) => string | undefined,
  env: Record<string, string | undefined> = {},
): RuntimeOptionDefaults {
  const builtin = BUILTIN_RUNTIME_OPTION_DEFAULTS;
  const permissionMode = lookup(CLAUDE_PERMISSION_MODE_SETTING_KEY);
  const claudeEffort = lookup(CLAUDE_EFFORT_SETTING_KEY);
  const sandbox = lookup(CODEX_SANDBOX_SETTING_KEY);
  const reasoningEffort = lookup(CODEX_REASONING_EFFORT_SETTING_KEY);
  return {
    claude: {
      permissionMode: isClaudePermissionMode(permissionMode) ? permissionMode : builtin.claude.permissionMode,
      dangerouslySkipPermissions: parseBooleanSetting(lookup(CLAUDE_SKIP_PERMISSIONS_SETTING_KEY))
        ?? builtin.claude.dangerouslySkipPermissions,
      effort: isClaudeEffort(claudeEffort) ? claudeEffort : builtin.claude.effort,
    },
    codex: {
      sandbox: isCodexSandboxMode(sandbox) ? sandbox : builtin.codex.sandbox,
      bypassApprovalsAndSandbox: parseBooleanSetting(lookup(CODEX_BYPASS_SETTING_KEY))
        ?? parseBooleanSetting(env[CODEX_BYPASS_ENV_KEY])
        ?? builtin.codex.bypassApprovalsAndSandbox,
      skipGitRepoCheck: parseBooleanSetting(lookup(CODEX_SKIP_GIT_REPO_CHECK_SETTING_KEY))
        ?? builtin.codex.skipGitRepoCheck,
      reasoningEffort: isCodexReasoningEffort(reasoningEffort) ? reasoningEffort : builtin.codex.reasoningEffort,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Keeps only valid fields of an externally supplied `claudeOptions`. Invalid
 * fields are dropped (→ Settings default applies); returns `undefined` when
 * nothing valid remains.
 */
export function sanitizeClaudeOptions(value: unknown): ClaudeOptions | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const next: ClaudeOptions = {};
  if (isClaudePermissionMode(record.permissionMode)) next.permissionMode = record.permissionMode;
  if (typeof record.dangerouslySkipPermissions === 'boolean') {
    next.dangerouslySkipPermissions = record.dangerouslySkipPermissions;
  }
  if (isClaudeEffort(record.effort)) next.effort = record.effort;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** `codexOptions` counterpart of {@link sanitizeClaudeOptions}. */
export function sanitizeCodexOptions(value: unknown): CodexOptions | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const next: CodexOptions = {};
  if (isCodexSandboxMode(record.sandbox)) next.sandbox = record.sandbox;
  if (isCodexReasoningEffort(record.reasoningEffort)) next.reasoningEffort = record.reasoningEffort;
  if (typeof record.skipGitRepoCheck === 'boolean') next.skipGitRepoCheck = record.skipGitRepoCheck;
  if (typeof record.bypassApprovalsAndSandbox === 'boolean') {
    next.bypassApprovalsAndSandbox = record.bypassApprovalsAndSandbox;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export interface ResolvedClaudeOptions {
  permissionMode: ClaudePermissionMode;
  dangerouslySkipPermissions: boolean;
  effort?: ClaudeEffort;
}

export function resolveClaudeOptions(
  card: ClaudeOptions | undefined,
  defaults: RuntimeOptionDefaults['claude'],
): ResolvedClaudeOptions {
  const valid = sanitizeClaudeOptions(card) ?? {};
  const effort = valid.effort ?? (defaults.effort === 'auto' ? undefined : defaults.effort);
  return {
    permissionMode: valid.permissionMode ?? defaults.permissionMode,
    dangerouslySkipPermissions: valid.dangerouslySkipPermissions ?? defaults.dangerouslySkipPermissions,
    ...(effort ? { effort } : {}),
  };
}

export type ResolvedCodexOptions = Required<CodexOptions>;

export function resolveCodexOptions(
  card: CodexOptions | undefined,
  defaults: RuntimeOptionDefaults['codex'],
): ResolvedCodexOptions {
  const valid = sanitizeCodexOptions(card) ?? {};
  return {
    sandbox: valid.sandbox ?? defaults.sandbox,
    reasoningEffort: valid.reasoningEffort ?? defaults.reasoningEffort,
    skipGitRepoCheck: valid.skipGitRepoCheck ?? defaults.skipGitRepoCheck,
    bypassApprovalsAndSandbox: valid.bypassApprovalsAndSandbox ?? defaults.bypassApprovalsAndSandbox,
  };
}

/** Permission/effort argv for `claude -p`. Skip-permissions replaces `--permission-mode`. */
export function claudeOptionArgs(options: ResolvedClaudeOptions): string[] {
  const args = options.dangerouslySkipPermissions
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', options.permissionMode];
  if (options.effort) args.push('--effort', options.effort);
  return args;
}

/** Permission/effort argv for `codex exec` (also used by the Settings preview). */
export function codexOptionArgs(options: ResolvedCodexOptions): string[] {
  const args = ['-s', options.sandbox, '-c', `model_reasoning_effort="${options.reasoningEffort}"`];
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  return args;
}
