import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from '../core/runtime-config';
import { PROMPT_MODEL_PATTERN, readPromptModels, proposalSchema, type PromptReadinessCheck } from '../core/prompt-proposal';

export const CLAUDE_REFINEMENT = 'Claude CLI';
export type ClaudeRefiner = {
  provider: typeof CLAUDE_REFINEMENT; model: string; models: string[];
  propose(model: string, instructions: string, input: string, signal: AbortSignal): Promise<unknown>;
  /** `claude auth status` only — no model call. Account details are never returned. */
  probe(): Promise<PromptReadinessCheck[]>;
};
type Spawn = (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; stdin: Blob }) =>
  { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void };
type Options = { executable: string; model: string; models: string[]; spawn?: Spawn };
const MAX_OUTPUT = 160_000;

/**
 * The installed `claude` CLI with the user's normal login (`claude -p`). Enabled automatically
 * when the CLI is found; `KANBAN_PROMPT_CLAUDE_ENABLED=false` turns it off.
 * Optional: `KANBAN_PROMPT_CLAUDE_BINARY` (path), `_MODEL` (default model), `_MODELS` (allow-list;
 * default = the card catalog's Claude models). Nothing is sent until the user clicks "AI 제안 생성".
 */
export function findClaudeBinary(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.KANBAN_PROMPT_CLAUDE_BINARY?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const onPath = Bun.which('claude', { PATH: env.PATH ?? '' });
  if (onPath) return onPath;
  // Daemons started by launchd often lack ~/.local/bin on PATH (the native installer's location).
  const local = join(env.HOME ?? homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : undefined;
}

export function configuredClaudeRefiner(env: Record<string, string | undefined>): ClaudeRefiner | undefined {
  if (env.KANBAN_PROMPT_CLAUDE_ENABLED === 'false') return;
  const executable = findClaudeBinary(env);
  if (!executable) return;
  const wanted = env.KANBAN_PROMPT_CLAUDE_MODEL?.trim();
  const model = wanted && PROMPT_MODEL_PATTERN.test(wanted) ? wanted : DEFAULT_CLAUDE_MODEL;
  const list = env.KANBAN_PROMPT_CLAUDE_MODELS?.trim() || CLAUDE_MODELS.map(m => m.id).join(',');
  return createClaudeRefiner({ executable, model, models: readPromptModels(model, list) });
}

export function claudeRefinerIssue(env: Record<string, string | undefined>): string {
  if (env.KANBAN_PROMPT_CLAUDE_ENABLED === 'false') return '서버에서 꺼져 있음 (KANBAN_PROMPT_CLAUDE_ENABLED=false)';
  return 'claude CLI를 찾지 못함 (PATH 또는 KANBAN_PROMPT_CLAUDE_BINARY)';
}

async function readBounded(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > cap) throw Error('claude_refinement_output_limit');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** Inherit the user's env (login, proxy/Vertex settings) but not a parent Claude session's markers. */
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

const defaultSpawn: Spawn = (cmd, opts) => Bun.spawn(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' });

async function run(spawn: Spawn, cmd: string[], stdin: string, signal: AbortSignal, timeoutMs: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'kanban-refine-'));
  try {
    const proc = spawn(cmd, { cwd, env: childEnv(), stdin: new Blob([stdin]) });
    const stop = () => { try { proc.kill('SIGKILL'); } catch { /* exited */ } };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    deadline.addEventListener('abort', stop, { once: true });
    if (deadline.aborted) stop();
    try {
      const [out, , exit] = await Promise.all([readBounded(proc.stdout, MAX_OUTPUT), readBounded(proc.stderr, 48_000), proc.exited]);
      return { out, exit, aborted: deadline.aborted };
    } finally { deadline.removeEventListener('abort', stop); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export function createClaudeRefiner(o: Options): ClaudeRefiner {
  const { executable, model, models } = o;
  const spawn = o.spawn ?? defaultSpawn;
  return {
    provider: CLAUDE_REFINEMENT, model, models,
    async probe() {
      let auth = '평소 Claude 로그인 확인 실패 (터미널에서 claude 로그인 필요)';
      try {
        const { out, exit } = await run(spawn, [executable, 'auth', 'status', '--json'], '', AbortSignal.timeout(8_000), 8_000);
        const status = JSON.parse(out || '{}') as { loggedIn?: unknown };
        if (exit === 0 && status.loggedIn !== false) auth = '';
      } catch { /* keep failure reason */ }
      return [
        { key: 'transport', label: 'claude CLI', ok: true, detail: '설치된 claude -p 사용' },
        { key: 'auth', label: '로그인', ok: !auth, detail: auth || '평소 Claude 로그인 사용' },
        { key: 'schema', label: '구조화 출력', ok: true, detail: '--json-schema 고정 스키마 · 도구 없음' },
      ];
    },
    async propose(selected, instructions, input, signal) {
      if (!models.includes(selected) || signal.aborted) throw Error('claude_refinement_request_invalid');
      // Text-only: no tools, no MCP, no slash commands, no hooks (so no board cards/sessions are
      // created by the user's own hooks), no saved session. Empty temp cwd → no project CLAUDE.md.
      const { out, exit, aborted } = await run(spawn, [executable,
        '-p', '--output-format', 'json', '--model', selected,
        '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-session-persistence',
        '--settings', '{"disableAllHooks":true}',
        '--system-prompt', instructions, '--json-schema', JSON.stringify(proposalSchema),
      ], '<request-data>\n' + input + '\n</request-data>', signal, 45_000);
      if (exit !== 0 || aborted) throw Error('claude_refinement_failed');
      return parseClaudeRefinementResult(out);
    },
  };
}

/** `--output-format json` envelope → the structured proposal. Errors and tool use are refused. */
export function parseClaudeRefinementResult(text: string): unknown {
  const envelope = JSON.parse(text.trim()) as Record<string, unknown>;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.type !== 'result'
      || envelope.subtype !== 'success' || envelope.is_error === true) throw Error('claude_refinement_failed');
  const denials = envelope.permission_denials;
  if (Array.isArray(denials) && denials.length) throw Error('claude_refinement_unexpected_tool');
  const structured = envelope.structured_output;
  if (structured && typeof structured === 'object') return structured;
  if (typeof envelope.result === 'string' && envelope.result.trim()) return JSON.parse(envelope.result);
  throw Error('claude_refinement_no_answer');
}
