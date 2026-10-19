import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
    env?: Record<string, string>;
  },
): Promise<void> {
  const proc = Bun.spawn(['bash', scriptPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_CODE_CHILD_SESSION: '',
      HOME: options.dataDir,
      KANBAN_API_URL: options.apiUrl,
      KANBAN_DATA_DIR: options.dataDir,
      AGENT_KANBAN_DISPATCH_CARD_ID: options.marker ? 'original-card-id' : '',
      AGENT_KANBAN_DISPATCH_RUN_ID: options.marker ? 'runtime-run-id' : '',
      ...options.env,
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
  opts: { apiUrl: string; dataDir: string; env?: Record<string, string> },
): Promise<void> {
  const proc = Bun.spawn(['bash', HOOKS.claude.stop], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_CODE_CHILD_SESSION: '',
      HOME: opts.dataDir,
      KANBAN_API_URL: opts.apiUrl,
      KANBAN_DATA_DIR: opts.dataDir,
      AGENT_KANBAN_DISPATCH_CARD_ID: '',
      AGENT_KANBAN_DISPATCH_RUN_ID: '',
      ...opts.env,
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

    test(`${runtime} organic hooks preserve full prompt and result content`, async () => {
      await withTempDir(async (dir) => {
        await withFakeApi(async (apiUrl, requests) => {
          const prompt = `${'prompt-'.repeat(12_000)}PROMPT-END`;
          const result = `${'result-'.repeat(12_000)}결과-끝`;
          const promptInput = { ...HOOKS[runtime].promptInput, prompt };
          const stopInput = { ...HOOKS[runtime].stopInput, last_assistant_message: result };

          await runHook(HOOKS[runtime].prompt, promptInput, {
            apiUrl,
            dataDir: dir,
          });
          await runHook(HOOKS[runtime].stop, stopInput, {
            apiUrl,
            dataDir: dir,
          });

          const createRequest = requests.find(
            request => request.method === 'POST' && request.path === '/api/cards',
          );
          const completeRequest = requests.findLast(
            request => request.method === 'PATCH' && request.path === '/api/cards/card-from-hook',
          );
          expect((createRequest?.body as { title?: string }).title).toBe(prompt.slice(0, 120));
          expect((createRequest?.body as { description?: string }).description).toBe(prompt);
          expect((completeRequest?.body as { result?: string }).result).toBe(result);
        });
      });
    });
  }

  test('claude on-stop stores every assistant text block of the current turn from the transcript', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = HOOKS.claude.promptInput.session_id;
        // Previous turn (must be excluded) + current turn: answer → tool call → tool result → answer.
        // Mirrors the real Claude Code transcript shape, including a sidechain (subagent) entry
        // and a tool_result `user` entry, neither of which starts or belongs to the turn.
        const lines = [
          { type: 'user', message: { role: 'user', content: 'earlier prompt' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'current prompt' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '1차 답변' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] } },
          { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
          { type: 'system', content: 'noise' },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '최종 답변\n\n---\n**요약**' }] } },
        ];
        const transcriptPath = join(dir, `${sessionId}.jsonl`);
        writeFileSync(transcriptPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');

        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir });
        await runClaudeStop({
          session_id: sessionId,
          transcript_path: transcriptPath,
          last_assistant_message: '최종 답변\n\n---\n**요약**',
        }, { apiUrl, dataDir: dir });

        const completeRequest = requests.findLast(
          request => request.method === 'PATCH' && request.path === '/api/cards/card-from-hook',
        );
        expect((completeRequest?.body as { result?: string }).result)
          .toBe('1차 답변\n\n최종 답변\n\n---\n**요약**');
      });
    });
  });

  test('claude on-stop falls back to last_assistant_message when the transcript is missing or stale', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = HOOKS.claude.promptInput.session_id;
        // Transcript that does NOT yet contain the harness's final message (unflushed file).
        const stalePath = join(dir, 'stale.jsonl');
        writeFileSync(stalePath, [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'prompt' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
        ].join('\n') + '\n');

        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir });
        await runClaudeStop({
          session_id: sessionId,
          transcript_path: stalePath,
          last_assistant_message: 'harness final',
        }, { apiUrl, dataDir: dir });
        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir });
        await runClaudeStop({
          session_id: sessionId,
          transcript_path: join(dir, 'does-not-exist.jsonl'),
          last_assistant_message: 'harness final 2',
        }, { apiUrl, dataDir: dir });

        const results = requests
          .filter(request => request.method === 'PATCH' && request.path === '/api/cards/card-from-hook')
          .map(request => request.body as { status?: string; result?: string })
          .filter(body => body.status === 'complete')
          .map(body => body.result);
        expect(results).toEqual(['harness final', 'harness final 2']);
      });
    });
  });

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

  test('claude on-stop completes a parent whose named teammates have all rested even while they idle in background_tasks', async () => {
    await withTempDir(async (dir) => {
      // No `inProgressCards` → every teammate child has rested at least once (child cards are
      // `complete`). The teammates are still alive as idle processes (listed in background_tasks)
      // and the parent carries a has-subagents marker. Previously that combination deferred forever
      // (idle named teammates never leave background_tasks), stranding the parent in_progress until
      // the next prompt. Now: complete with this turn's text, keep the tracking file so later Stops
      // re-complete (last-writer-wins), and leave no pending stash behind.
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
            last_assistant_message: '종합 보고: 네 teammate 결과를 합친 최종 결론',
            background_tasks: [{ id: 'idle-teammate-1' }, { id: 'idle-teammate-2' }],
          },
          { apiUrl, dataDir: dir },
        );

        const patches = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/cards/parent-card');
        expect(patches).toHaveLength(1);
        expect(patches[0]?.body).toEqual({ status: 'complete', result: '종합 보고: 네 teammate 결과를 합친 최종 결론' });
        expect(existsSync(join(trackingDir, `${sessionId}.pending-parent-card`))).toBe(false);
        // Preserved: a later turn (teammate follow-up) re-completes with the newer text.
        expect(existsSync(currentTracking)).toBe(true);
      });
    });
  });

  test('claude on-stop still defers while a direct child is in_progress and background tasks remain', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = 'claude-live-child-session';
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        writeFileSync(join(trackingDir, `${sessionId}.card-id`), 'parent-card');
        writeFileSync(join(trackingDir, 'parent-card.has-subagents'), '');

        await runClaudeStop(
          {
            session_id: sessionId,
            last_assistant_message: 'intermediate: waiting on Bravo',
            background_tasks: [{ id: 'live-teammate' }],
          },
          { apiUrl, dataDir: dir },
        );

        expect(requests.some((r) => r.path === '/api/cards/parent-card')).toBe(false);
        expect(readFileSync(join(trackingDir, `${sessionId}.pending-parent-card`), 'utf8')).toBe('intermediate: waiting on Bravo');
      }, {
        inProgressCards: [{ id: 'child-1', parentCardId: 'parent-card', status: 'in_progress' }],
      });
    });
  });

  test('claude on-stop does not treat harness-injected teammate messages as turn boundaries', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionId = HOOKS.claude.promptInput.session_id;
        // Real prompt → spawn → N teammate reports (recorded as `user` entries by the harness, string
        // and text-block forms) → synthesis. The synthesis must include the text written BEFORE the
        // last teammate report, not only the fragment after it. Mirrors on-prompt.sh's filter.
        const lines = [
          { type: 'user', message: { role: 'user', content: 'teammate 4개 띄워서 조사해줘' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '4개 teammate 를 띄웁니다' }] } },
          { type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="alpha" summary="done">보고 A</teammate-message>' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A 보고 수신' }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<agent-id>beta</agent-id>\n</task-notification>' }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<teammate-message teammate_id="gamma" type="idle_notification"/>' }] } },
          { type: 'user', message: { role: 'user', content: '<agent-message from="delta">보고 D</agent-message>' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '## 종합 보고\n\n전체 결론' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '다음 단계' }] } },
        ];
        const transcriptPath = join(dir, `${sessionId}.jsonl`);
        writeFileSync(transcriptPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');

        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir });
        await runClaudeStop({
          session_id: sessionId,
          transcript_path: transcriptPath,
          last_assistant_message: '다음 단계',
        }, { apiUrl, dataDir: dir });

        const completeRequest = requests.findLast(
          request => request.method === 'PATCH' && request.path === '/api/cards/card-from-hook',
        );
        expect((completeRequest?.body as { result?: string }).result)
          .toBe('4개 teammate 를 띄웁니다\n\nA 보고 수신\n\n## 종합 보고\n\n전체 결론\n\n다음 단계');
      });
    });
  });

  test('claude on-prompt stamps forkedFromSessionId on a forked session and on-stop drains the parent pending stash', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const cwd = HOOKS.claude.promptInput.cwd;
        const sessionsDir = join(dir, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });

        const sharedUuid = '11111111-1111-4111-8111-111111111111';
        const body = (sessionId: string, extra: string[] = []) => [
          JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }),
          JSON.stringify({ type: 'user', uuid: sharedUuid, sessionId, isSidechain: false, message: { role: 'user', content: 'first prompt' } }),
          JSON.stringify({ type: 'assistant', uuid: '22222222-2222-4222-8222-222222222222', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
          ...extra,
        ].join('\n') + '\n';
        // Unrelated session (different first uuid) must never be picked.
        writeFileSync(join(sessionsDir, 'other-session.jsonl'), body('other-session').replace(sharedUuid, '99999999-9999-4999-8999-999999999999'));
        // Original (older mtime) and its fork (same entries copied under a new session id).
        writeFileSync(join(sessionsDir, 'origin-session.jsonl'), body('origin-session'));
        const forkId = 'fork-session';
        writeFileSync(join(sessionsDir, `${forkId}.jsonl`), body(forkId));
        const old = new Date(Date.now() - 60_000);
        utimesSync(join(sessionsDir, 'origin-session.jsonl'), old, old);
        // The original deferred a parent card (teammate still live at its Stop) and never stopped again.
        writeFileSync(join(trackingDir, 'origin-session.pending-origin-parent'), 'origin final synthesis');

        await runHook(
          HOOKS.claude.prompt,
          { ...HOOKS.claude.promptInput, session_id: forkId, prompt: 'fork 에서 이어서' },
          { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } },
        );

        const post = requests.find((r) => r.method === 'POST' && r.path === '/api/cards');
        expect((post?.body as { forkedFromSessionId?: string; sessionId?: string })).toMatchObject({
          sessionId: forkId,
          forkedFromSessionId: 'origin-session',
        });
        expect(readFileSync(join(trackingDir, `${forkId}.forked-from`), 'utf8').trim()).toBe('origin-session');

        await runClaudeStop(
          { session_id: forkId, last_assistant_message: 'fork answer', background_tasks: [] },
          { apiUrl, dataDir: dir },
        );
        const patches = requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, (r.body as { result?: string }).result]);
        expect(patches).toContainEqual(['/api/cards/origin-parent', 'origin final synthesis']);
        expect(patches).toContainEqual(['/api/cards/card-from-hook', 'fork answer']);
        expect(existsSync(join(trackingDir, 'origin-session.pending-origin-parent'))).toBe(false);
      });
    });
  });

  test('claude on-stop resolves fork lineage when the forked transcript only appears after the first prompt', async () => {
    await withTempDir(async (dir) => {
      // Real Claude Code behaviour (observed 2026-10-19 with `--fork-session`): during the fork's
      // first UserPromptSubmit its transcript is NOT on disk yet, so on-prompt.sh cannot match.
      // The Stop hook gets `transcript_path`, resolves the parent, caches it, stamps the current
      // card and drains the parent's pending stash in the same run.
      await withFakeApi(async (apiUrl, requests) => {
        const sessionsDir = join(dir, 'projects');
        mkdirSync(sessionsDir, { recursive: true });
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        const sharedUuid = '33333333-3333-4333-8333-333333333333';
        const body = (sessionId: string) => [
          JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }),
          JSON.stringify({ type: 'user', uuid: sharedUuid, sessionId, message: { role: 'user', content: 'first prompt' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
        ].join('\n') + '\n';
        writeFileSync(join(sessionsDir, 'origin-session.jsonl'), body('origin-session'));
        const old = new Date(Date.now() - 60_000);
        utimesSync(join(sessionsDir, 'origin-session.jsonl'), old, old);
        writeFileSync(join(trackingDir, 'origin-session.pending-origin-parent'), 'origin final synthesis');

        const forkId = HOOKS.claude.promptInput.session_id;
        // Prompt time: no transcript for the fork yet → card minted without lineage, no cache file.
        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
        expect((requests[0]?.body as Record<string, unknown>).forkedFromSessionId).toBeUndefined();
        expect(existsSync(join(trackingDir, `${forkId}.forked-from`))).toBe(false);

        // The first turn writes the forked transcript (same first user uuid as the origin).
        const forkTranscript = join(sessionsDir, `${forkId}.jsonl`);
        writeFileSync(forkTranscript, body(forkId) + JSON.stringify({ type: 'user', message: { role: 'user', content: 'fork prompt' } }) + '\n'
          + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fork answer' }] } }) + '\n');

        await runClaudeStop(
          { session_id: forkId, transcript_path: forkTranscript, last_assistant_message: 'fork answer', background_tasks: [] },
          { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } },
        );

        expect(readFileSync(join(trackingDir, `${forkId}.forked-from`), 'utf8')).toBe('origin-session');
        const patches = requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body]);
        expect(patches).toContainEqual(['/api/cards/card-from-hook', { forkedFromSessionId: 'origin-session' }]);
        expect(patches).toContainEqual(['/api/cards/origin-parent', { status: 'complete', result: 'origin final synthesis' }]);
        expect(patches).toContainEqual(['/api/cards/card-from-hook', { status: 'complete', result: 'fork answer' }]);
        expect(existsSync(join(trackingDir, 'origin-session.pending-origin-parent'))).toBe(false);

        // A later prompt of the same session reads the cache and carries the lineage itself.
        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
        const lastPost = requests.filter((r) => r.method === 'POST').at(-1);
        expect((lastPost?.body as Record<string, unknown>).forkedFromSessionId).toBe('origin-session');
      });
    });
  });

  test('claude on-stop caches a negative fork verdict so a plain child session is scanned once', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const sessionsDir = join(dir, 'projects');
        mkdirSync(sessionsDir, { recursive: true });
        const sessionId = HOOKS.claude.promptInput.session_id;
        const own = join(sessionsDir, `${sessionId}.jsonl`);
        writeFileSync(own, JSON.stringify({ type: 'user', uuid: 'solo', message: { role: 'user', content: 'x' } }) + '\n');
        writeFileSync(join(sessionsDir, 'other.jsonl'), JSON.stringify({ type: 'user', uuid: 'different', message: { role: 'user', content: 'y' } }) + '\n');

        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
        await runClaudeStop(
          { session_id: sessionId, transcript_path: own, last_assistant_message: 'done', background_tasks: [] },
          { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } },
        );

        const cache = join(dir, HOOKS.claude.trackingDir, `${sessionId}.forked-from`);
        expect(existsSync(cache)).toBe(true);
        expect(readFileSync(cache, 'utf8')).toBe('');
        // on-prompt's in_progress PATCH plus the completion — and no forkedFromSessionId stamp.
        expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([{ status: 'in_progress' }, { status: 'complete', result: 'done' }]);
      });
    });
  });

  test('claude on-prompt ignores CLAUDE_CODE_CHILD_SESSION when no sibling transcript shares the first uuid', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const cwd = HOOKS.claude.promptInput.cwd;
        const sessionsDir = join(dir, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${HOOKS.claude.promptInput.session_id}.jsonl`),
          JSON.stringify({ type: 'user', uuid: 'solo-uuid', message: { role: 'user', content: 'x' } }) + '\n');

        await runHook(HOOKS.claude.prompt, HOOKS.claude.promptInput, { apiUrl, dataDir: dir, env: { CLAUDE_CODE_CHILD_SESSION: '1' } });

        const post = requests.find((r) => r.method === 'POST' && r.path === '/api/cards');
        expect((post?.body as Record<string, unknown>).forkedFromSessionId).toBeUndefined();
        expect(existsSync(join(dir, HOOKS.claude.trackingDir, `${HOOKS.claude.promptInput.session_id}.forked-from`))).toBe(false);
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

  test('claude subagent completion hooks preserve full results', async () => {
    await withTempDir(async (dir) => {
      await withFakeApi(async (apiUrl, requests) => {
        const trackingDir = join(dir, HOOKS.claude.trackingDir);
        mkdirSync(trackingDir, { recursive: true });
        const syncResult = `${'sync-subagent-'.repeat(6_000)}SYNC-END`;
        const asyncResult = `${'async-subagent-'.repeat(6_000)}ASYNC-END`;

        writeFileSync(join(trackingDir, 'subagent-tool-long.card-id'), 'sync-child');
        await runHook(
          join(process.cwd(), '.claude', 'hooks', 'on-subagent-stop.sh'),
          {
            session_id: 'parent-session',
            tool_name: 'Agent',
            tool_use_id: 'tool-long',
            tool_response: syncResult,
          },
          { apiUrl, dataDir: dir },
        );

        writeFileSync(join(trackingDir, 'subagent-agent-agent-long.card-id'), 'async-child');
        await runHook(
          join(process.cwd(), '.claude', 'hooks', 'on-subagent-realstop.sh'),
          {
            session_id: 'parent-session',
            agent_id: 'agent-long',
            last_assistant_message: asyncResult,
          },
          { apiUrl, dataDir: dir },
        );

        const syncPatch = requests.find(request => request.path === '/api/cards/sync-child');
        const asyncPatch = requests.find(request => request.path === '/api/cards/async-child');
        expect((syncPatch?.body as { result?: string }).result).toBe(syncResult);
        expect((asyncPatch?.body as { result?: string }).result).toBe(asyncResult);
      });
    });
  });
});
