import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { SettingsStore } from '../../core/settings-store';
import type { CodexReasoningEffort, WikiLlmRoute } from '../../core/types';
import { DEFAULT_CODEX_REASONING_EFFORT } from '../../core/runtime-config';
import { createClaudeBinaryResolver } from '../runtimes/claude-binary';
import { WIKI_INTERNAL_ENV } from '../../core/types';

/** One-shot prompt → raw response text. Injectable for tests. */
export interface WikiLlmCallOptions {
  model?: string;
  route?: WikiLlmRoute;
  effort?: CodexReasoningEffort;
}

export type WikiLlmRunner = (prompt: string, options?: WikiLlmCallOptions) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 240_000;

export function resolveWikiLlmRoute(model: string): WikiLlmRoute {
  return model.startsWith('gpt') ? 'codex' : 'claude';
}

interface OneShotResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a CLI with the prompt on stdin and collect its output (with timeout kill). */
async function runOneShot(argv: string[], prompt: string, timeoutMs: number): Promise<OneShotResult> {
  const proc = Bun.spawn(argv, {
    stdin: new TextEncoder().encode(prompt),
    stdout: 'pipe',
    stderr: 'pipe',
    // Tell the Claude/Codex UserPromptSubmit hooks this is an internal wiki
    // one-shot so they exit early and never POST a board card.
    env: { ...process.env, [WIKI_INTERNAL_ENV]: '1' },
  });

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  if (typeof timeout === 'object' && 'unref' in timeout) {
    (timeout as NodeJS.Timeout).unref();
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One-shot `claude -p` runner. The prompt is fed via stdin (avoids argv length
 * limits); the response is the `result` field of claude's
 * `--output-format json` payload.
 */
export function createClaudeWikiLlm(deps: {
  settingsStore: SettingsStore;
  model: () => Promise<string>;
  timeoutMs?: number;
}): WikiLlmRunner {
  const resolveClaudeBinary = createClaudeBinaryResolver({ settingsStore: deps.settingsStore });
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (prompt: string, options?: WikiLlmCallOptions): Promise<string> => {
    const command = await resolveClaudeBinary();
    const model = options?.model ?? await deps.model();
    const argv = [...command, '-p', '--output-format', 'json', '--model', model];
    if (options?.effort) {
      argv.push('--effort', options.effort);
    }

    const { stdout, stderr, exitCode } = await runOneShot(argv, prompt, timeoutMs);
    if (exitCode !== 0) {
      throw new Error(`claude -p exited with ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    try {
      const parsed = JSON.parse(stdout) as { result?: unknown };
      if (typeof parsed.result === 'string') {
        return parsed.result;
      }
    } catch {
      // Not the expected JSON envelope — fall back to raw stdout.
    }
    return stdout;
  };
}

/**
 * One-shot `codex exec` runner for gpt-* models. Mirrors the codex-cli-adapter
 * contract: prompt on stdin (`-`), read-only sandbox, and the final assistant
 * message captured via `-o <file>`.
 */
export function createCodexWikiLlm(deps: {
  model: () => Promise<string>;
  effort?: () => Promise<CodexReasoningEffort>;
  timeoutMs?: number;
}): WikiLlmRunner {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (prompt: string, options?: WikiLlmCallOptions): Promise<string> => {
    const model = options?.model ?? await deps.model();
    const effort = options?.effort ?? (await deps.effort?.()) ?? DEFAULT_CODEX_REASONING_EFFORT;
    const lastMessagePath = join(tmpdir(), `agent-kanban-wiki-${nanoid()}.txt`);
    const argv = [
      'codex', 'exec',
      '--json',
      '-o', lastMessagePath,
      '-m', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '-s', 'read-only',
      '--skip-git-repo-check',
      // Wiki calls are pure text generation — skip the user's global MCP
      // servers, which otherwise slow every call's startup.
      '-c', 'mcp_servers={}',
      '-',
    ];

    try {
      const { stdout, stderr, exitCode } = await runOneShot(argv, prompt, timeoutMs);
      if (exitCode !== 0) {
        throw new Error(`codex exec exited with ${exitCode}: ${stderr.slice(0, 500)}`);
      }
      if (existsSync(lastMessagePath)) {
        const lastMessage = readFileSync(lastMessagePath, 'utf-8').trim();
        if (lastMessage) {
          return lastMessage;
        }
      }
      return stdout;
    } finally {
      try { unlinkSync(lastMessagePath); } catch { /* never created */ }
    }
  };
}

/**
 * Model-routing runner: `gpt-*` models run through the codex CLI, everything
 * else through the claude CLI. The wiki model is a runtime setting, so the
 * route is decided per call.
 */
export function createWikiLlm(deps: {
  settingsStore: SettingsStore;
  model: () => Promise<string>;
  effort?: () => Promise<CodexReasoningEffort>;
  timeoutMs?: number;
}): WikiLlmRunner {
  const claudeRunner = createClaudeWikiLlm(deps);
  const codexRunner = createCodexWikiLlm(deps);

  return async (prompt: string, options?: WikiLlmCallOptions): Promise<string> => {
    const model = options?.model ?? await deps.model();
    const route = options?.route ?? resolveWikiLlmRoute(model);
    const effort = options?.effort ?? (await deps.effort?.()) ?? DEFAULT_CODEX_REASONING_EFFORT;
    return route === 'codex'
      ? codexRunner(prompt, { model, route, effort })
      : claudeRunner(prompt, { model, route, effort });
  };
}
