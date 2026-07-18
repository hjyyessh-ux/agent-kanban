import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KanbanStore } from '../src/core/store';
import { SettingsStore } from '../src/core/settings-store';
import { SchedulerStore } from '../src/core/scheduler-store';
import { SchedulerEngine } from '../src/plugin/scheduler-engine';
import { ScriptStore } from '../src/core/script-store';
import { SkillStore } from '../src/core/skill-store';
import { SkillRootsStore } from '../src/core/skill-roots-store';
import { PlacementTargetsStore } from '../src/core/placement-targets-store';
import { RuntimeRunStore } from '../src/plugin/runtimes/runtime-run-store';
import { WikiWorker } from '../src/plugin/wiki/wiki-worker';
import { ScheduledDispatchService } from '../src/plugin/scheduled-dispatch-service';
import { createServer } from '../src/server/index';
import type { DispatchResult, KanbanCard } from '../src/core/types';
import { resolveAgentRuntime } from '../src/core/runtime-config';
import { isRecentlyFailed, dispatchNextQueuedTodoCard } from '../src/plugin/hooks/event-handler';
import { RuntimeDispatchError } from '../src/plugin/runtimes/types';
import { buildDispatchPromptText } from '../src/plugin/dispatch-prompt';

const port = Number.parseInt(process.env.E2E_PORT ?? '24681', 10);
const dataDir = resolve(process.cwd(), '.e2e-data');
const e2eHome = resolve(process.env.E2E_HOME ?? join(process.cwd(), '.e2e-home'));
const staticDir = resolve(process.cwd(), 'web/dist');
const DEFAULT_E2E_NOW = '2026-07-18T00:20:00.000Z';

class FakeClock {
  private nowMs: number;

  constructor(initialIso: string) {
    this.nowMs = new Date(initialIso).getTime();
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  toISOString(): string {
    return this.now().toISOString();
  }

  set(iso: string): void {
    const nextMs = new Date(iso).getTime();
    if (Number.isNaN(nextMs)) {
      throw new Error(`Invalid fake clock value: ${iso}`);
    }
    this.nowMs = nextMs;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid fake clock advance: ${ms}`);
    }
    this.nowMs += ms;
  }
}

if (resolve(process.env.HOME ?? '') !== e2eHome) {
  throw new Error(
    `Refusing to start E2E server without isolated HOME=${e2eHome}. ` +
      'Use Playwright via bun run test:e2e.',
  );
}

if (process.env.E2E_KEEP_DATA !== 'true') {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(e2eHome, { recursive: true, force: true });
}
mkdirSync(e2eHome, { recursive: true });

if (process.env.E2E_SKIP_BUILD !== 'true') {
  const build = Bun.spawnSync(['bun', 'run', 'build:web'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  if (build.exitCode !== 0) {
    throw new Error(`web build failed with exit code ${build.exitCode}`);
  }
}

const store = new KanbanStore(dataDir);
const settingsStore = new SettingsStore(dataDir);
const schedulerStore = new SchedulerStore(dataDir);
const fakeClock = new FakeClock(process.env.E2E_FAKE_NOW ?? DEFAULT_E2E_NOW);
const schedulerEngine = new SchedulerEngine(schedulerStore, {
  settingsStore,
  now: () => fakeClock.now(),
});
const scriptStore = new ScriptStore(dataDir);
const runtimeRunStore = new RuntimeRunStore(dataDir);
const wikiWorker = new WikiWorker(store, settingsStore);

// Capabilities MCP and Skill discovery are wired against isolated HOME/data fixtures.
// The Playwright webServer sets HOME=.e2e-home before this module is loaded, so
// CLAUDE_JSON_PATH/CODEX_CONFIG_PATH never resolve to the developer's real files.
const claudeProjectDir = join(e2eHome, 'workspace', 'claude-project');
const codexProjectDir = join(e2eHome, 'workspace', 'codex-project');
const codexSubdir = join(codexProjectDir, 'packages', 'app');
const codexDestinationDir = join(e2eHome, 'workspace', 'codex-destination');
const codexUiTargetDir = join(e2eHome, 'workspace', 'codex-ui-target');
mkdirSync(join(e2eHome, '.codex'), { recursive: true });
mkdirSync(claudeProjectDir, { recursive: true });
mkdirSync(join(codexProjectDir, '.git'), { recursive: true });
mkdirSync(join(codexProjectDir, '.codex'), { recursive: true });
mkdirSync(join(codexSubdir, '.codex'), { recursive: true });
mkdirSync(join(codexDestinationDir, '.codex'), { recursive: true });
mkdirSync(codexUiTargetDir, { recursive: true });
await Bun.write(join(e2eHome, '.claude.json'), JSON.stringify({
  mcpServers: {
    shared: { command: 'claude-shared', alwaysLoad: true },
    'claude-only': { command: 'claude-only', args: ['--fixture'], alwaysLoad: false },
  },
  projects: {},
}, null, 2) + '\n');
await Bun.write(join(claudeProjectDir, '.mcp.json'), JSON.stringify({
  mcpServers: { 'claude-project': { command: 'claude-project-server' } },
  fixtureMetadata: { preserve: true },
}, null, 2) + '\n');
await Bun.write(join(e2eHome, '.codex', 'config.toml'), [
  '# e2e user config',
  'model = "gpt-5.4"',
  '',
  '[features]',
  'apps = true',
  '',
  '[mcp_servers.shared]',
  'command = "codex-user-shared"',
  '',
  '[mcp_servers.codex_user]',
  'url = "https://user.example.test/mcp"',
  '',
].join('\n'));
await Bun.write(join(codexProjectDir, '.codex', 'config.toml'), [
  '# project comment must survive mutations',
  '[hooks]',
  'enabled = true',
  '',
  '[mcp_servers.shared]',
  'command = "codex-project-shared"',
  '',
  '[mcp_servers.secret_team]',
  'command = "secret-server"',
  '',
  '[mcp_servers.secret_team.env]',
  'TOKEN = "sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefgh"',
  '',
].join('\n'));
await Bun.write(join(codexSubdir, '.codex', 'config.toml'), [
  '[mcp_servers.shared]',
  'command = "codex-nearest-shared"',
  '',
  '[mcp_servers.subdirectory_only]',
  'command = "subdirectory-server"',
  '',
].join('\n'));
await Bun.write(join(codexDestinationDir, '.codex', 'config.toml'), [
  'model = "gpt-5.4-mini" # preserve destination',
  '',
  '[features]',
  'apps = false',
  '',
].join('\n'));

// Skill discovery is wired against an ISOLATED fixture tree under .e2e-data so the
// Capabilities tab is exercisable end-to-end without scanning the developer's real
// ~/.claude / ~/.codex skill directories (which would break test isolation and
// determinism). We seed one claude skill and point skill-roots.json at the fixture.
const skillFixtureRoot = join(dataDir, 'skills-fixtures', 'claude');
const codexFixtureRoot = join(dataDir, 'skills-fixtures', 'codex');
const opencodeFixtureRoot = join(dataDir, 'skills-fixtures', 'opencode');
const sampleSkillDir = join(skillFixtureRoot, 'e2e-sample-skill');
const codexSkillDir = join(codexFixtureRoot, 'e2e-codex-skill');
const opencodeSkillDir = join(opencodeFixtureRoot, 'e2e-opencode-skill');
mkdirSync(sampleSkillDir, { recursive: true });
mkdirSync(codexSkillDir, { recursive: true });
mkdirSync(opencodeSkillDir, { recursive: true });
await Bun.write(
  join(sampleSkillDir, 'SKILL.md'),
  [
    '---',
    'name: e2e-sample-skill',
    'description: Isolated e2e fixture skill for Capabilities testing.',
    'allowed-tools: [Read, Grep]',
    '---',
    '',
    '# e2e-sample-skill',
    '',
    'Fixture body used by capabilities.e2e.ts.',
    '',
  ].join('\n'),
);
await Bun.write(join(codexSkillDir, 'SKILL.md'), '---\nname: e2e-codex-skill\ndescription: Isolated Codex skill.\n---\n\n# Codex fixture\n');
await Bun.write(join(opencodeSkillDir, 'SKILL.md'), '---\nname: e2e-opencode-skill\ndescription: Isolated OpenCode skill.\n---\n\n# OpenCode fixture\n');
await Bun.write(
  join(dataDir, 'skill-roots.json'),
  JSON.stringify(
    {
      version: 1,
      roots: [
        {
          id: 'e2e-claude',
          dir: skillFixtureRoot,
          agent: 'claude',
          source: 'claude-user',
          enabled: true,
        },
        {
          id: 'e2e-codex',
          dir: codexFixtureRoot,
          agent: 'codex',
          source: 'codex-user',
          enabled: true,
        },
        {
          id: 'e2e-opencode',
          dir: opencodeFixtureRoot,
          agent: 'opencode',
          source: 'opencode-user',
          enabled: true,
        },
      ],
      lastModified: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const skillStore = new SkillStore(dataDir);
const skillRootsStore = new SkillRootsStore(dataDir);
const placementTargetsStore = new PlacementTargetsStore(dataDir);
await placementTargetsStore.addTarget({
  label: 'E2E Claude project', dir: claudeProjectDir, kind: 'project', runtime: 'claude', teamShared: true,
});
await placementTargetsStore.addTarget({
  label: 'E2E Codex subdirectory', dir: codexSubdir, kind: 'local', runtime: 'codex', teamShared: false,
});
await placementTargetsStore.addTarget({
  label: 'E2E Codex destination', dir: codexDestinationDir, kind: 'project', runtime: 'codex', teamShared: true,
});
// Best-effort initial scan so GET /api/skills returns the fixture skill on boot.
try {
  await skillStore.sync(await skillRootsStore.getRoots());
} catch {
  // Non-critical for e2e; the Sync button can re-trigger discovery.
}

const runtimeCounters: Record<string, number> = {
  opencode: 0,
  codex: 0,
  claude: 0,
};
const dispatchAttemptsByCardId = new Map<string, number>();

async function resolveResumeSessionId(card: KanbanCard): Promise<string | undefined> {
  if (card.feedbackForCardId) {
    const original = await store.getCard(card.feedbackForCardId);
    if (original?.sessionId) return original.sessionId;
  }
  if (card.resumeSessionId) return card.resumeSessionId;
  if (card.queueSessionMode === 'continue_queued_after_session' && card.queuedAfterCardId) {
    const predecessor = await store.getCard(card.queuedAfterCardId);
    if (predecessor?.sessionId && predecessor.status !== 'in_progress') return predecessor.sessionId;
  }
  if (card.sessionId && isRecentlyFailed(card)) return card.sessionId;
  return undefined;
}

function nextSessionId(runtime: string, resumeSessionId?: string): string {
  if (resumeSessionId) return resumeSessionId;
  runtimeCounters[runtime] = (runtimeCounters[runtime] ?? 0) + 1;
  if (runtime === 'codex') return `thread-e2e-${runtimeCounters[runtime]}`;
  if (runtime === 'claude') return `claude-e2e-${runtimeCounters[runtime]}`;
  return `opencode-e2e-${runtimeCounters[runtime]}`;
}

async function simulatePromptHookForRuntime(
  runtime: string,
  input: { card: KanbanCard; prompt: string; sessionId: string; runId: string },
): Promise<void> {
  if (runtime !== 'codex' && runtime !== 'claude') return;

  const hookPath = runtime === 'codex'
    ? resolve(process.cwd(), '.codex/hooks/on-prompt.sh')
    : resolve(process.cwd(), '.claude/hooks/on-prompt.sh');
  const hookInput = runtime === 'codex'
    ? {
        session_id: input.sessionId,
        cwd: input.card.projectDir ?? process.cwd(),
        prompt: input.prompt,
        model: input.card.model ?? '',
      }
    : {
        session_id: input.sessionId,
        cwd: input.card.projectDir ?? process.cwd(),
        prompt: input.prompt,
      };

  const proc = Bun.spawn(['bash', hookPath], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      HOME: dataDir,
      KANBAN_API_URL: `http://127.0.0.1:${port}`,
      KANBAN_DATA_DIR: dataDir,
      AGENT_KANBAN_DISPATCH_CARD_ID: input.card.id,
      AGENT_KANBAN_DISPATCH_RUN_ID: input.runId,
    },
  });
  proc.stdin.write(JSON.stringify(hookInput));
  proc.stdin.end();
  await proc.exited;
}

async function fakeDispatch(cardId: string): Promise<DispatchResult> {
  const card = await store.getCard(cardId);
  if (!card) throw new RuntimeDispatchError('Card not found', 404);
  dispatchAttemptsByCardId.set(cardId, (dispatchAttemptsByCardId.get(cardId) ?? 0) + 1);

  const runtime = resolveAgentRuntime(card);
  const resumeSessionId = await resolveResumeSessionId(card);
  const prompt = buildDispatchPromptText(card, (screenshot) => store.getScreenshotPath(screenshot.filename));
  const hasScreenshotContext = prompt.includes('Attached screenshots:');
  const sessionId = nextSessionId(runtime, resumeSessionId);
  const startedAt = fakeClock.toISOString();
  const runId = `${runtime}-e2e-run-${startedAt.replace(/[-:.TZ]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;

  const shouldFail = card.description.includes('[fail-once]') && !isRecentlyFailed(card);
  const shouldHoldOpen = card.description.includes('[hold-open]');
  await store.updateCard(card.id, {
    status: 'in_progress',
    sessionId,
    staleStatus: null,
    staleDetectedAt: null,
    resumeSessionId: null,
  });
  await simulatePromptHookForRuntime(runtime, { card, prompt, sessionId, runId });

  if (shouldFail) {
    setTimeout(() => {
      void store.updateCard(card.id, {
        status: 'todo',
        progressSummary: `[failed] fake ${runtime} failure runId=${runId}`,
        result: `Fake ${runtime} failure`,
        staleStatus: null,
        staleDetectedAt: null,
      });
    }, 120);
    return { sessionId, runId, startedAt };
  }

  if (shouldHoldOpen) {
    return { sessionId, runId, startedAt };
  }

  setTimeout(() => {
    void (async () => {
      await store.updateCard(card.id, {
        status: 'complete',
        resolution: 'completed',
        sessionId,
        progressSummary: undefined,
        result: `Fake ${runtime} result${resumeSessionId ? ` resumed ${resumeSessionId}` : ''}${hasScreenshotContext ? ' with screenshot context' : ''}`,
        staleStatus: null,
        staleDetectedAt: null,
      });
      await dispatchNextQueuedTodoCard(store, card.id, fakeDispatch);
    })();
  }, 160);

  return { sessionId, runId, startedAt };
}

const scheduledDispatchService = new ScheduledDispatchService({
  store,
  dispatchFn: fakeDispatch,
  now: () => fakeClock.now(),
  tickMs: 60_000,
});
schedulerEngine.setPromptDispatcher(store, fakeDispatch);

const modelsFn = async () => [
  { id: 'github-copilot/gpt-5.4', name: 'GPT-5.4', providerID: 'github-copilot', providerName: 'GitHub Copilot' },
  { id: 'github-copilot/claude-opus-4.6', name: 'Claude Opus 4.6', providerID: 'github-copilot', providerName: 'GitHub Copilot' },
  { id: 'github-copilot/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', providerID: 'github-copilot', providerName: 'GitHub Copilot' },
];

await settingsStore.upsertByKey('network_exposed', 'false', {
  description: 'Allow network access to kanban board (0.0.0.0 vs 127.0.0.1)',
  category: 'network',
  masked: false,
});

await schedulerEngine.start();
await scheduledDispatchService.start();

const innerServer = createServer(
  store,
  0,
  staticDir,
  fakeDispatch,
  schedulerStore,
  schedulerEngine,
  settingsStore,
  '127.0.0.1',
  undefined,
  scriptStore,
  modelsFn,
  undefined, // questionMonitor
  undefined, // aggregateSessionsFn
  undefined, // localPeerSessionsFn
  undefined, // peerTokenFn
  undefined, // runtimeCatalogFn
  wikiWorker,
  skillStore,
  skillRootsStore,
  placementTargetsStore,
  runtimeRunStore,
);

async function restartBackgroundServices(): Promise<void> {
  scheduledDispatchService.stop();
  schedulerEngine.stop();
  await schedulerEngine.start();
  await scheduledDispatchService.start();
}

const outerServer = Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/e2e/clock' && req.method === 'GET') {
      return Response.json({ now: fakeClock.toISOString() });
    }

    if (url.pathname === '/api/e2e/clock' && req.method === 'PUT') {
      const body = await req.json() as { now?: string; kickScheduledDispatch?: boolean };
      if (typeof body.now !== 'string') {
        return Response.json({ error: 'now is required' }, { status: 400 });
      }
      fakeClock.set(body.now);
      if (body.kickScheduledDispatch) {
        await scheduledDispatchService.kick();
      }
      return Response.json({ now: fakeClock.toISOString() });
    }

    if (url.pathname === '/api/e2e/clock/advance' && req.method === 'POST') {
      const body = await req.json() as { ms?: number; kickScheduledDispatch?: boolean };
      if (typeof body.ms !== 'number') {
        return Response.json({ error: 'ms is required' }, { status: 400 });
      }
      fakeClock.advance(body.ms);
      if (body.kickScheduledDispatch) {
        await scheduledDispatchService.kick();
      }
      return Response.json({ now: fakeClock.toISOString() });
    }

    if (url.pathname === '/api/e2e/scheduled-dispatch/kick' && req.method === 'POST') {
      await scheduledDispatchService.kick();
      return Response.json({ ok: true, now: fakeClock.toISOString() });
    }

    const dispatchAttemptsMatch = url.pathname.match(/^\/api\/e2e\/dispatch-attempts\/([^/]+)$/);
    if (dispatchAttemptsMatch && req.method === 'GET') {
      const cardId = decodeURIComponent(dispatchAttemptsMatch[1] ?? '');
      return Response.json({ cardId, attempts: dispatchAttemptsByCardId.get(cardId) ?? 0 });
    }

    if (url.pathname === '/api/e2e/services/restart' && req.method === 'POST') {
      await restartBackgroundServices();
      return Response.json({ ok: true, now: fakeClock.toISOString() });
    }

    const proxyUrl = new URL(req.url);
    proxyUrl.port = String(innerServer.port);
    const headers = new Headers(req.headers);
    headers.delete('origin');
    headers.delete('host');
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: 'manual',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.arrayBuffer();
    }
    return fetch(proxyUrl, init);
  },
});

console.log(`E2E server listening on http://127.0.0.1:${outerServer.port}`);

function stopAll(): void {
  outerServer.stop(true);
  innerServer.stop();
  scheduledDispatchService.stop();
  schedulerEngine.stop();
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
