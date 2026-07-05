import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { withTempDir } from './setup';

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type RuntimeHook = 'claude' | 'codex';

const HOOKS = {
  claude: {
    prompt: join(process.cwd(), '.claude', 'hooks', 'on-prompt.sh'),
    stop: join(process.cwd(), '.claude', 'hooks', 'on-stop.sh'),
    trackingDir: '.claude-hooks',
    promptInput: {
      session_id: 'claude-script-session',
      cwd: process.cwd(),
      prompt: 'organic claude prompt',
    },
    stopInput: {
      session_id: 'claude-script-session',
      last_assistant_message: 'claude final result',
    },
  },
  codex: {
    prompt: join(process.cwd(), '.codex', 'hooks', 'on-prompt.sh'),
    stop: join(process.cwd(), '.codex', 'hooks', 'on-stop.sh'),
    trackingDir: '.codex-hooks',
    promptInput: {
      session_id: 'codex-script-session',
      cwd: process.cwd(),
      prompt: 'organic codex prompt',
    },
    stopInput: {
      session_id: 'codex-script-session',
      last_assistant_message: 'codex final result',
    },
  },
} satisfies Record<RuntimeHook, {
  prompt: string;
  stop: string;
  trackingDir: string;
  promptInput: Record<string, string>;
  stopInput: Record<string, string>;
}>;

async function withFakeApi<T>(
  fn: (url: string, requests: RecordedRequest[]) => Promise<T>,
  opts: { inProgressCards?: unknown[] } = {},
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const bodyText = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        body: bodyText ? JSON.parse(bodyText) : null,
      });

      // GET /api/cards (used by on-stop.sh's card_has_live_children child query) returns the
      // card array. Defaults to empty — tests that need a live child pass `inProgressCards`.
      if (request.method === 'GET' && url.pathname === '/api/cards') {
        return Response.json(opts.inProgressCards ?? []);
      }
      if (request.method === 'POST' && url.pathname === '/api/cards') {
        return Response.json({ id: 'card-from-hook' });
      }
      if (request.method === 'PATCH' && url.pathname.startsWith('/api/cards/')) {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  });

  try {
    return await fn(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    server.stop(true);
  }
}

async function runHook(
  scriptPath: string,
  input: Record<string, string>,
  options: {
    apiUrl: string;
    dataDir: string;
    marker?: boolean;
  },
): Promise<void> {
  const proc = Bun.spawn(['bash', scriptPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: options.dataDir,
      KANBAN_API_URL: options.apiUrl,
      KANBAN_DATA_DIR: options.dataDir,
      AGENT_KANBAN_DISPATCH_CARD_ID: options.marker ? 'original-card-id' : '',
      AGENT_KANBAN_DISPATCH_RUN_ID: options.marker ? 'runtime-run-id' : '',
    },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
}

function trackingFile(dataDir: string, runtime: RuntimeHook): string {
  const sessionId = HOOKS[runtime].promptInput.session_id;
  return join(dataDir, HOOKS[runtime].trackingDir, `${sessionId}.card-id`);
}

// Run the claude Stop hook with an arbitrary input object (background_tasks is an array, so the
// stricter runHook signature does not fit). Asserts a clean exit, mirroring runHook's contract.
async function runClaudeStop(
  input: Record<string, unknown>,
  opts: { apiUrl: string; dataDir: string },
): Promise<void> {
  const proc = Bun.spawn(['bash', HOOKS.claude.stop], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: opts.dataDir,
      KANBAN_API_URL: opts.apiUrl,
      KANBAN_DATA_DIR: opts.dataDir,
      AGENT_KANBAN_DISPATCH_CARD_ID: '',
      AGENT_KANBAN_DISPATCH_RUN_ID: '',
    },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
}

describe('runtime hook scripts', () => {
  test('install script registers Codex hooks with Codex event names and handler shape', () => {
    const installScript = readFileSync(join(process.cwd(), 'scripts', 'install.sh'), 'utf8');
    const codexBlockStart = installScript.indexOf('# Register hooks in global Codex hooks config');
    const codexBlockEnd = installScript.indexOf('echo "Codex hooks registered in $GLOBAL_CODEX_HOOKS"', codexBlockStart);
    const codexBlock = installScript.slice(codexBlockStart, codexBlockEnd);

    expect(codexBlock).toContain('.hooks.SessionStart = ((.hooks.SessionStart // []) + [{"hooks": [{"type": "command", "command": $session_cmd, "timeout": 15}]}])');
    expect(codexBlock).toContain('.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [{"hooks": [{"type": "command", "command": $prompt_cmd, "timeout": 30}]}])');
    expect(codexBlock).toContain('.hooks.Stop = ((.hooks.Stop // []) + [{"hooks": [{"type": "command", "command": $stop_cmd, "timeout": 30}]}])');
    expect(codexBlock).not.toContain('.hooks.session_start =');
    expect(codexBlock).not.toContain('.hooks.user_prompt_submit =');
    expect(codexBlock).not.toContain('.hooks.stop =');
  });

  for (const runtime of ['claude', 'codex'] as const) {
    test(`${runtime} on-prompt exits without API calls or tracking file when dispatch marker is present`, async () => {
      await withTempDir(async (dir) => {
        await withFakeApi(async (apiUrl, requests) => {
          await runHook(HOOKS[runtime].prompt, HOOKS[runtime].promptInput, {
            apiUrl,
            dataDir: dir,
            marker: true,
          });

          expect(requests).toHaveLength(0);
          expect(existsSync(trackingFile(dir, runtime))).toBe(false);
        });
      });
    });

    test(`${runtime} on-stop exits without PATCH when dispatch marker is present`, async () => {
      await withTempDir(async (dir) => {
        const file = trackingFile(dir, runtime);
        mkdirSync(join(dir, HOOKS[runtime].trackingDir), { recursive: true });
        writeFileSync(file, 'original-card-id');

        await withFakeApi(async (apiUrl, requests) => {
          await runHook(HOOKS[runtime].stop, HOOKS[runtime].stopInput, {
            apiUrl,
            dataDir: dir,
            marker: true,
          });

          expect(requests).toHaveLength(0);
          expect(existsSync(file)).toBe(true);
        });
      });
    });

    test(`${runtime} organic hooks keep creating and completing cards`, async () => {
      await withTempDir(async (dir) => {
        await withFakeApi(async (apiUrl, requests) => {
          await runHook(HOOKS[runtime].prompt, HOOKS[runtime].promptInput, {
            apiUrl,
            dataDir: dir,
          });
          expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
            'POST /api/cards',
            'PATCH /api/cards/card-from-hook',
          ]);
          expect(existsSync(trackingFile(dir, runtime))).toBe(true);

          await runHook(HOOKS[runtime].stop, HOOKS[runtime].stopInput, {
            apiUrl,
            dataDir: dir,
          });
          expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
            'POST /api/cards',
            'PATCH /api/cards/card-from-hook',
            'PATCH /api/cards/card-from-hook',
          ]);
          expect(existsSync(trackingFile(dir, runtime))).toBe(false);
        });
      });
    });
  }

  test('claude on-stop drains earlier deferred cards even while background tasks remain', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = 'claude-bg-drain-session';
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        // An earlier turn ended with background work and was deferred to a pending file.
        const earlierPending = join(trackingDir, `${sessionId}.pending-earlier-card`);
        writeFileSync(earlierPending, 'earlier turn result');
        // This turn's card is live in the tracking file.
        const currentTracking = join(trackingDir, `${sessionId}.card-id`);
        writeFileSync(currentTracking, 'current-card');

        const proc = Bun.spawn(['bash', HOOKS.claude.stop], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            HOME: dir,
            KANBAN_API_URL: apiUrl,
            KANBAN_DATA_DIR: dir,
            AGENT_KANBAN_DISPATCH_CARD_ID: '',
            AGENT_KANBAN_DISPATCH_RUN_ID: '',
          },
        });
        proc.stdin.write(
          JSON.stringify({
            session_id: sessionId,
            last_assistant_message: 'current turn result',
            background_tasks: [{ id: 'bg-1' }],
          }),
        );
        proc.stdin.end();
        const [exitCode, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
          new Response(proc.stdout).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);

        // The earlier deferred card is completed and its pending file removed...
        expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('PATCH /api/cards/earlier-card');
        expect(existsSync(earlierPending)).toBe(false);
        // ...while THIS turn's card is NOT completed — it has a live in_progress child of its
        // own (below), so it is deferred (stashed) until that child finishes.
        expect(requests.some((r) => r.path === '/api/cards/current-card')).toBe(false);
        expect(existsSync(join(trackingDir, `${sessionId}.pending-current-card`))).toBe(true);
        // The tracking file is preserved so the turn can still be drained next Stop.
        expect(existsSync(currentTracking)).toBe(true);
      }, {
        inProgressCards: [{ id: 'live-child', parentCardId: 'current-card', status: 'in_progress' }],
      });
    });
  });

  test('claude on-stop completes the current card when background tasks are unrelated (no live children)', async () => {
    await withTempDir(async (dir) => {
      // No `inProgressCards` → card_has_live_children sees zero direct children. A non-empty
      // session-global background_tasks (e.g. a zombie teammate slot from an earlier turn) must
      // NOT defer a card that spawned nothing of its own. Regression test for childless cards
      // (plain prompts, scheduled wakeups) stranded in_progress forever.
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = 'claude-bg-zombie-session';
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        const currentTracking = join(trackingDir, `${sessionId}.card-id`);
        writeFileSync(currentTracking, 'current-card');

        const proc = Bun.spawn(['bash', HOOKS.claude.stop], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            HOME: dir,
            KANBAN_API_URL: apiUrl,
            KANBAN_DATA_DIR: dir,
            AGENT_KANBAN_DISPATCH_CARD_ID: '',
            AGENT_KANBAN_DISPATCH_RUN_ID: '',
          },
        });
        proc.stdin.write(
          JSON.stringify({
            session_id: sessionId,
            last_assistant_message: 'hi',
            background_tasks: [{ id: 'zombie-teammate' }],
          }),
        );
        proc.stdin.end();
        const [exitCode, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
          new Response(proc.stdout).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);

        // The childless card is completed — not held hostage by the unrelated background task...
        expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('PATCH /api/cards/current-card');
        // ...with no pending stash and the tracking file cleared.
        expect(existsSync(join(trackingDir, `${sessionId}.pending-current-card`))).toBe(false);
        expect(existsSync(currentTracking)).toBe(false);
      });
    });
  });

  test('claude on-stop defers a parent whose named teammate is resting (has-subagents marker, live background task, no in_progress child)', async () => {
    await withTempDir(async (dir) => {
      // No `inProgressCards` → card_has_live_children sees zero direct children: the teammate has
      // rested at least once, flipping its child card to `complete`. But it is still alive (listed
      // in background_tasks) and the parent carries a has-subagents marker, so the parent must NOT
      // complete on this turn's intermediate message — it defers. Regression test for the parent
      // freezing on a mid-exchange message.
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = 'claude-resting-teammate-session';
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        const currentTracking = join(trackingDir, `${sessionId}.card-id`);
        writeFileSync(currentTracking, 'parent-card');
        // on-subagent-start.sh drops this when the parent spawns a subagent.
        writeFileSync(join(trackingDir, 'parent-card.has-subagents'), '');

        await runClaudeStop(
          {
            session_id: sessionId,
            last_assistant_message: 'intermediate: waiting on Bravo',
            background_tasks: [{ id: 'live-teammate' }],
          },
          { apiUrl, dataDir: dir },
        );

        // Deferred: no completion PATCH for the parent...
        expect(requests.some((r) => r.path === '/api/cards/parent-card')).toBe(false);
        // ...the intermediate message is stashed, and the tracking file is preserved for re-drain.
        expect(existsSync(join(trackingDir, `${sessionId}.pending-parent-card`))).toBe(true);
        expect(existsSync(currentTracking)).toBe(true);
      });
    });
  });

  test('claude on-stop re-completes a spawned-subagent parent on later Stops so the final turn wins (last-writer-wins)', async () => {
    await withTempDir(async (dir) => {
      // Teammates are done (empty background_tasks), so the parent completes — but because it spawned
      // subagents (has-subagents marker) its tracking file is PRESERVED, letting a later turn (the
      // wrap-up summary) re-complete it with the final message instead of freezing on the first one.
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = 'claude-reconverge-session';
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        const currentTracking = join(trackingDir, `${sessionId}.card-id`);
        writeFileSync(currentTracking, 'parent-card');
        writeFileSync(join(trackingDir, 'parent-card.has-subagents'), '');

        // First post-exchange Stop: completes with an intermediate message, keeps the tracking file.
        await runClaudeStop(
          {
            session_id: sessionId,
            last_assistant_message: 'intermediate summary',
            background_tasks: [],
          },
          { apiUrl, dataDir: dir },
        );
        const firstPatch = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/cards/parent-card');
        expect(firstPatch).toHaveLength(1);
        expect((firstPatch[0]?.body as { result?: string }).result).toBe('intermediate summary');
        expect(existsSync(currentTracking)).toBe(true);

        // A later turn re-completes the SAME card, overwriting the result with the final message.
        await runClaudeStop(
          {
            session_id: sessionId,
            last_assistant_message: 'final wrap-up summary',
            background_tasks: [],
          },
          { apiUrl, dataDir: dir },
        );
        const allPatches = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/cards/parent-card');
        expect(allPatches).toHaveLength(2);
        expect((allPatches[1]?.body as { result?: string }).result).toBe('final wrap-up summary');
        // Still preserved for any further turns.
        expect(existsSync(currentTracking)).toBe(true);
      });
    });
  });
});
