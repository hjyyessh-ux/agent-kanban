import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_RUNTIME_OPTION_DEFAULTS,
  claudeOptionArgs,
  codexOptionArgs,
  resolveClaudeOptions,
  resolveCodexOptions,
  runtimeOptionDefaultsFromSettings,
  sanitizeClaudeOptions,
  sanitizeCodexOptions,
} from '../core/runtime-options';

const settings = (values: Record<string, string>) => (key: string) => values[key];

describe('runtime option defaults', () => {
  test('stored settings win over built-ins; broken values fall back per field', () => {
    const defaults = runtimeOptionDefaultsFromSettings(settings({
      'agent.claude.permission_mode': 'plan',
      'agent.claude.dangerously_skip_permissions': 'yes-please',
      'agent.defaults.claude.effort': 'high',
      'agent.defaults.codex.sandbox': 'read-only',
      'agent.codex.skip_git_repo_check': 'false',
      'agent.defaults.codex.reasoning_effort': 'ultra',
    }));
    expect(defaults.claude).toEqual({ permissionMode: 'plan', dangerouslySkipPermissions: false, effort: 'high' });
    expect(defaults.codex).toEqual({
      sandbox: 'read-only',
      bypassApprovalsAndSandbox: false,
      skipGitRepoCheck: false,
      reasoningEffort: 'medium',
    });
  });

  test('Codex bypass falls back to the legacy env only when no setting is stored', () => {
    const env = { KANBAN_CODEX_BYPASS_APPROVALS_AND_SANDBOX: 'true' };
    expect(runtimeOptionDefaultsFromSettings(settings({}), env).codex.bypassApprovalsAndSandbox).toBe(true);
    expect(runtimeOptionDefaultsFromSettings(
      settings({ 'agent.codex.bypass_approvals_and_sandbox': 'false' }),
      env,
    ).codex.bypassApprovalsAndSandbox).toBe(false);
  });
});

describe('sanitize card options', () => {
  test('"default" and other unknown values are dropped, valid fields kept', () => {
    expect(sanitizeClaudeOptions({ permissionMode: 'default', dangerouslySkipPermissions: false }))
      .toEqual({ dangerouslySkipPermissions: false });
    expect(sanitizeClaudeOptions({ permissionMode: 'default' })).toBeUndefined();
    expect(sanitizeClaudeOptions({ permissionMode: 'manual', effort: 'max' }))
      .toEqual({ permissionMode: 'manual', effort: 'max' });
    expect(sanitizeCodexOptions({ sandbox: 'default', bypassApprovalsAndSandbox: 'true', reasoningEffort: 'high' }))
      .toEqual({ reasoningEffort: 'high' });
    expect(sanitizeCodexOptions('nope')).toBeUndefined();
  });
});

describe('resolve + argv', () => {
  test('card value beats Settings; invalid card value uses Settings', () => {
    const settingsDefaults = { ...BUILTIN_RUNTIME_OPTION_DEFAULTS.claude, permissionMode: 'plan' as const };
    expect(claudeOptionArgs(resolveClaudeOptions({ permissionMode: 'acceptEdits' }, settingsDefaults)))
      .toEqual(['--permission-mode', 'acceptEdits']);
    expect(claudeOptionArgs(resolveClaudeOptions(
      { permissionMode: 'default' } as unknown as Parameters<typeof resolveClaudeOptions>[0],
      settingsDefaults,
    ))).toEqual(['--permission-mode', 'plan']);
  });

  test('skip permissions replaces --permission-mode; auto effort sends no flag', () => {
    expect(claudeOptionArgs(resolveClaudeOptions(undefined, {
      permissionMode: 'plan', dangerouslySkipPermissions: true, effort: 'xhigh',
    }))).toEqual(['--dangerously-skip-permissions', '--effort', 'xhigh']);
    expect(claudeOptionArgs(resolveClaudeOptions(undefined, BUILTIN_RUNTIME_OPTION_DEFAULTS.claude)))
      .toEqual(['--permission-mode', 'acceptEdits']);
  });

  test('codex argv follows the resolved options', () => {
    expect(codexOptionArgs(resolveCodexOptions({ bypassApprovalsAndSandbox: true }, {
      ...BUILTIN_RUNTIME_OPTION_DEFAULTS.codex, skipGitRepoCheck: false,
    }))).toEqual([
      '-s', 'workspace-write', '-c', 'model_reasoning_effort="medium"',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });
});
