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
import { createServer } from '../src/server/index';
import type { DispatchResult, KanbanCard } from '../src/core/types';
import { resolveAgentRuntime } from '../src/core/runtime-config';
import { isRecentlyFailed, dispatchNextQueuedTodoCard } from '../src/plugin/hooks/event-handler';
import { RuntimeDispatchError } from '../src/plugin/runtimes/types';
import { buildDispatchPromptText } from '../src/plugin/dispatch-prompt';

const port = Number.parseInt(process.env.E2E_PORT ?? '24681', 10);
const dataDir = resolve(process.cwd(), '.e2e-data');
const staticDir = resolve(process.cwd(), 'web/dist');

if (process.env.E2E_KEEP_DATA !== 'true') {
  rmSync(dataDir, { recursive: true, force: true });
}

if (!existsSync(join(staticDir, 'index.html'))) {
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
const schedulerEngine = new SchedulerEngine(schedulerStore, settingsStore);
const scriptStore = new ScriptStore(dataDir);
const runtimeRunStore = new RuntimeRunStore(dataDir);
const wikiWorker = new WikiWorker(store, settingsStore);

// Skill discovery is wired against an ISOLATED fixture tree under .e2e-data so the
// Capabilities tab is exercisable end-to-end without scanning the developer's real
// ~/.claude / ~/.codex skill directories (which would break test isolation and
// determinism). We seed one claude skill and point skill-roots.json at the fixture.
const skillFixtureRoot = join(dataDir, 'skills-fixtures', 'claude');
const codexFixtureRoot = join(dataDir, 'skills-fixtures', 'codex');
const sampleSkillDir = join(skillFixtureRoot, 'e2e-sample-skill');
mkdirSync(sampleSkillDir, { recursive: true });
// Empty codex root: gives a second enabled root so Duplicate/Port targets exist
// and the agent filter is meaningful, without seeding a codex skill.
mkdirSync(codexFixtureRoot, { recursive: true });
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

  const runtime = resolveAgentRuntime(card);
  const resumeSessionId = await resolveResumeSessionId(card);
  const prompt = buildDispatchPromptText(card, (screenshot) => store.getScreenshotPath(screenshot.filename));
  const hasScreenshotContext = prompt.includes('Attached screenshots:');
  const sessionId = nextSessionId(runtime, resumeSessionId);
  const runId = `${runtime}-e2e-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();

  const shouldFail = card.description.includes('[fail-once]') && !isRecentlyFailed(card);
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

const server = createServer(
  store,
  port,
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

console.log(`E2E server listening on http://127.0.0.1:${server.port}`);

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
