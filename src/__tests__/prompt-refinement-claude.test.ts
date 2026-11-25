import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRefinerIssue, configuredClaudeRefiner, createClaudeRefiner, findClaudeBinary, parseClaudeRefinementResult, CLAUDE_REFINEMENT, type ClaudeRefiner } from '../server/prompt-refinement-claude';
import { configuredCodexRefiner } from '../server/prompt-refinement-codex';
import { buildPromptCatalog } from '../server/prompt-refinement-catalog';
import { createPromptRefinementRoute } from '../server/prompt-refinement-route';
import { CLAUDE_MODELS, CODEX_MODELS, DEFAULT_CLAUDE_MODEL } from '../core/runtime-config';
import { PROMPT_PROPOSAL_PATH, type PromptReadinessCheck } from '../core/prompt-proposal';

const result = { sections: [{ kind: 'suggestion', title: '목적', body: '검증한다.' }] };
const sha = 'a'.repeat(64);
const dir = mkdtempSync(join(tmpdir(), 'claude-bin-'));
const bin = join(dir, 'claude');
writeFileSync(bin, '', { mode: 0o755 });

test('Claude CLI uses the installed claude + normal login; only an explicit false turns it off', () => {
  expect(configuredClaudeRefiner({ KANBAN_PROMPT_CLAUDE_ENABLED: 'false', KANBAN_PROMPT_CLAUDE_BINARY: bin })).toBeUndefined();
  expect(configuredClaudeRefiner({ KANBAN_PROMPT_CLAUDE_BINARY: join(dir, 'missing'), HOME: dir })).toBeUndefined();
  expect(configuredClaudeRefiner({ PATH: '', HOME: dir })).toBeUndefined();
  expect(findClaudeBinary({ PATH: dir, HOME: '/nonexistent' })).toBe(bin);
  const claude = configuredClaudeRefiner({ KANBAN_PROMPT_CLAUDE_BINARY: bin })!;
  expect(claude.model).toBe(DEFAULT_CLAUDE_MODEL);
  expect(claude.models).toEqual([DEFAULT_CLAUDE_MODEL, ...CLAUDE_MODELS.map(m => m.id).filter(id => id !== DEFAULT_CLAUDE_MODEL)]);
  const explicit = configuredClaudeRefiner({ KANBAN_PROMPT_CLAUDE_BINARY: bin, KANBAN_PROMPT_CLAUDE_MODEL: 'claude-opus-5-5', KANBAN_PROMPT_CLAUDE_MODELS: 'claude-sonnet-5' })!;
  expect(explicit.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
  expect(claudeRefinerIssue({ KANBAN_PROMPT_CLAUDE_ENABLED: 'false' })).toContain('꺼져');
  expect(claudeRefinerIssue({})).toContain('찾지 못함');
});

test.skipIf(process.platform !== 'darwin')('without _MODELS the Codex allow-list is default + card catalog', () => {
  const codex = configuredCodexRefiner({ KANBAN_PROMPT_CODEX_ENABLED: 'true', KANBAN_PROMPT_CODEX_BINARY: '/opt/codex',
    KANBAN_PROMPT_CODEX_BINARY_SHA256: sha, KANBAN_PROMPT_CODEX_MODEL: 'gpt-6.1-sol', HOME: '/Users/x' })!;
  expect(codex.models).toEqual(['gpt-6.1-sol', ...CODEX_MODELS.map(m => m.id).filter(id => id !== 'gpt-6.1-sol')]);
});

function fakeSpawn(replies: { out: string; exit: number }[], calls: { cmd: string[]; cwd: string; env: Record<string, string | undefined>; stdin: string }[]) {
  return (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; stdin: Blob }) => {
    const reply = replies.shift()!;
    const entry = { cmd, cwd: opts.cwd, env: opts.env, stdin: '' };
    calls.push(entry);
    void opts.stdin.text().then(t => { entry.stdin = t; });
    return { stdout: new Response(reply.out).body!, stderr: new Response('').body!, exited: Promise.resolve(reply.exit), kill() {} };
  };
}

test('propose runs text-only claude -p (no tools/MCP/hooks/session) in an empty temp dir; probe never calls a model', async () => {
  const calls: { cmd: string[]; cwd: string; env: Record<string, string | undefined>; stdin: string }[] = [];
  process.env.CLAUDECODE = '1';
  const refiner = createClaudeRefiner({ executable: bin, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], spawn: fakeSpawn([
    { out: JSON.stringify({ loggedIn: true, email: 'secret@example.com' }), exit: 0 },
    { out: JSON.stringify({ loggedIn: false }), exit: 1 },
    { out: JSON.stringify({ type: 'result', subtype: 'success', structured_output: result }), exit: 0 },
  ], calls) });
  const ready = await refiner.probe();
  expect(ready.every(c => c.ok)).toBe(true);
  expect(JSON.stringify(ready)).not.toContain('secret@example.com');
  expect((await refiner.probe()).find(c => c.key === 'auth')?.ok).toBe(false);
  expect(calls.map(c => c.cmd.slice(1).join(' '))).toEqual(['auth status --json', 'auth status --json']);

  expect(await refiner.propose('claude-sonnet-5', 'INSTR', '요청', new AbortController().signal)).toEqual(result);
  const run = calls[2];
  const flag = (name: string) => run.cmd[run.cmd.indexOf(name) + 1];
  expect(run.cmd[0]).toBe(bin);
  expect(run.cmd).toContain('-p');
  expect(flag('--model')).toBe('claude-sonnet-5');
  expect(flag('--tools')).toBe('');
  expect(run.cmd).toContain('--strict-mcp-config');
  expect(JSON.parse(flag('--mcp-config'))).toEqual({ mcpServers: {} });
  expect(JSON.parse(flag('--settings'))).toEqual({ disableAllHooks: true });
  expect(run.cmd).toContain('--no-session-persistence');
  expect(flag('--system-prompt')).toBe('INSTR');
  expect(run.cwd.startsWith(tmpdir())).toBe(true);
  expect(existsSync(run.cwd)).toBe(false);
  expect(run.env.CLAUDECODE).toBeUndefined();
  expect(run.stdin).toContain('요청');
  delete process.env.CLAUDECODE;

  await expect(refiner.propose('claude-opus-5-5', 'INSTR', '요청', new AbortController().signal)).rejects.toThrow('claude_refinement_request_invalid');
});

test('result envelope: structured_output or JSON result accepted; errors and tool denials refused', () => {
  expect(parseClaudeRefinementResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: result }))).toEqual(result);
  expect(parseClaudeRefinementResult(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }))).toEqual(result);
  for (const bad of [
    { type: 'result', subtype: 'error_max_turns', result: '{}' },
    { type: 'result', subtype: 'success', is_error: true, result: JSON.stringify(result) },
    { type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Bash' }], structured_output: result },
    { type: 'assistant' },
  ]) expect(() => parseClaudeRefinementResult(JSON.stringify(bad))).toThrow();
});

test('ready Codex + Claude: both selectable in the catalog; POST is pinned to the named provider', async () => {
  const ok: PromptReadinessCheck[] = [{ key: 'auth', label: '로그인', ok: true, detail: 'fixture' }];
  const catalog = buildPromptCatalog([
    { provider: 'Codex CLI', configured: true, defaultModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-astra'], checks: ok },
    { provider: 'Claude CLI', configured: true, defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5'], checks: ok },
  ], null);
  const selectable = catalog.providers.flatMap(p => p.models.filter(m => m.selectable).map(m => `${p.provider}/${m.id}`));
  expect(selectable).toEqual(['Codex CLI/gpt-6.1-sol', 'Codex CLI/gpt-6-astra', 'Claude CLI/claude-opus-5-5']);

  const used: string[] = [];
  const claude: ClaudeRefiner = { provider: CLAUDE_REFINEMENT, model: 'claude-opus-5-5', models: ['claude-opus-5-5'],
    probe: async () => ok, propose: async model => { used.push('claude:' + model); return result; } };
  const route = createPromptRefinementRoute([claude], async () => { throw Error('unexpected fetch'); });
  const post = (provider: string, model: string) => route(new Request('http://127.0.0.1' + PROMPT_PROPOSAL_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: '요청', provider, model, consent: true }) }));
  expect((await post('Codex CLI', 'gpt-6.1-sol')).status).toBe(409);
  expect((await post('Claude CLI', 'claude-sonnet-5')).status).toBe(409);
  expect((await post('Claude CLI', 'claude-opus-5-5')).status).toBe(200);
  expect(used).toEqual(['claude:claude-opus-5-5']);
});
