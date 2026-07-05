import type { Plugin } from '@opencode-ai/plugin';
import { KanbanStore } from '../core/store';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';
import { ScriptStore } from '../core/script-store';
import { SkillStore } from '../core/skill-store';
import { SkillRootsStore } from '../core/skill-roots-store';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { setDynamicSkillCommands } from '../core/commands';
import { SchedulerEngine } from './scheduler-engine';
import { createKanbanTools } from './tools/index';
import { createSchedulerTools, createSettingsTools } from './tools/index';
import { createEventHooks } from './hooks/index';
import { ServerMonitor } from './server';
import type { ModelsFn, ModelInfo } from '../server/routes';
import { getKanbanDataDir } from './config';
import { StaleCardChecker } from './stale-checker';
import { QuestionMonitor } from './question-monitor';
import { TelegramReminderService } from './telegram-reminder';
import { TelegramStateStore } from '../core/telegram-state-store';
import { existsSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { trackDispatch } from './hooks/dispatch-tracker';
import { TelegramPoller, type FollowUpFn } from './telegram-poller';
import { getPrimaryAgentDispatchLabel } from '../core/agent-config';
import { getBuiltinCommandDefinition, normalizeBuiltinCommandId } from '../core/commands';
import type { DispatchResult, KanbanCard } from '../core/types';
import { resolveAgentRuntime } from '../core/runtime-config';
import { RuntimeLock } from './runtime-lock';
import { PeerSessionCoordinator, type NativeSessionInfo } from './peer-session-coordinator';
import { appendRuntimeDebugLog, getRuntimeDebugLogPath } from './debug-log';
import { createRuntimeRegistry } from './runtimes/runtime-registry';
import { createOpencodeAdapter } from './runtimes/opencode-adapter';
import { createCodexCliAdapter } from './runtimes/codex-cli-adapter';
import { createClaudeAdapter } from './runtimes/claude-adapter';
import { ChildLinker } from './runtimes/child-linker';
import { ClaudeCodexWatchdog } from './runtimes/claude-codex-watchdog';
import { RuntimeRunStore } from './runtimes/runtime-run-store';
import { RuntimeDispatchError } from './runtimes/types';
import { captureGitStart } from './runtimes/git-capture';
import { isRecentlyFailed } from './hooks/event-handler';
import { buildDispatchPromptText } from './dispatch-prompt';
import { WikiWorker } from './wiki/wiki-worker';
import { sweepWikiInternalCards } from './wiki/wiki-sweep';

function resolveDispatchAgent(agentType?: string): string | undefined {
  return getPrimaryAgentDispatchLabel(agentType);
}

async function resolveQueueReusedSession(
  store: KanbanStore,
  card: KanbanCard,
): Promise<{ sessionId: string; predecessor: KanbanCard } | undefined> {
  if (card.queueSessionMode !== 'continue_queued_after_session') return undefined;
  if (!card.queuedAfterCardId) return undefined;

  const predecessor = await store.getCard(card.queuedAfterCardId);
  if (!predecessor?.sessionId) return undefined;
  if (predecessor.status === 'in_progress') return undefined;

  return {
    sessionId: predecessor.sessionId,
    predecessor,
  };
}

async function resolveResumeSessionId(store: KanbanStore, card: KanbanCard): Promise<string | undefined> {
  if (card.feedbackForCardId) {
    const originalCard = await store.getCard(card.feedbackForCardId);
    if (originalCard?.sessionId) return originalCard.sessionId;
  }

  if (card.resumeSessionId) {
    return card.resumeSessionId;
  }

  const queueReuse = await resolveQueueReusedSession(store, card);
  if (queueReuse) {
    return queueReuse.sessionId;
  }

  if (card.sessionId && isRecentlyFailed(card)) {
    return card.sessionId;
  }

  return undefined;
}

export function buildDispatchPromptBody(card: {
  model?: string;
  agentType?: string;
  description: string;
}): {
  model?: { providerID: string; modelID: string };
  agent?: string;
  parts: [{ type: 'text'; text: string }];
} {
  const model = card.model
    ? { providerID: card.model.split('/')[0], modelID: card.model.split('/').slice(1).join('/') }
    : undefined;
  const agent = resolveDispatchAgent(card.agentType);

  return {
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    parts: [{ type: 'text', text: card.description }],
  };
}

export async function runCardCommand(params: {
  runCommand: (options: {
    path: { id: string };
    body: { command: string; arguments: string };
    query?: { directory?: string };
  }) => Promise<unknown>;
  showToast?: (options: { body: { message: string; variant: 'info' } }) => unknown;
  card: Pick<KanbanCard, 'command' | 'arguments' | 'projectDir' | 'description'>;
  sessionId: string;
}): Promise<void> {
  const { runCommand, showToast, card, sessionId } = params;
  const command = normalizeBuiltinCommandId(card.command);
  if (!command) return;
  const definition = getBuiltinCommandDefinition(command);
  const description = 'description' in card && typeof card.description === 'string'
    ? card.description.trim()
    : '';
  const baseArguments = (card.arguments ?? '').trim();
  const combinedArguments = definition?.executionMode === 'command_with_prompt' && description
    ? [description, baseArguments].filter(Boolean).join(' ')
    : baseArguments;

  try {
    await runCommand({
      path: { id: sessionId },
      body: {
        command,
        arguments: combinedArguments,
      },
      ...(card.projectDir ? { query: { directory: card.projectDir } } : {}),
    });
  } catch {
    try {
      showToast?.({
        body: {
          message: `Command failed but prompt continued: ${command}`,
          variant: 'info',
        },
      });
    } catch {
    }
  }
}

export async function runCardCommandThenPrompt(params: {
  runCommand: (options: {
    path: { id: string };
    body: { command: string; arguments: string };
    query?: { directory?: string };
  }) => Promise<unknown>;
  runPrompt: () => Promise<unknown>;
  showToast?: (options: { body: { message: string; variant: 'info' } }) => unknown;
  card: Pick<KanbanCard, 'command' | 'arguments' | 'projectDir' | 'description'>;
  sessionId: string;
}): Promise<void> {
  const definition = getBuiltinCommandDefinition(params.card.command);
  await runCardCommand(params);
  if (definition) {
    return;
  }
  await params.runPrompt();
}

const kanbanDataDir = getKanbanDataDir();

const plugin: Plugin = async (input) => {
  appendRuntimeDebugLog('plugin.init', {
    dataDir: kanbanDataDir,
    serverUrl: input.serverUrl.toString(),
    debugLogPath: getRuntimeDebugLogPath(),
  });
  const store = new KanbanStore(kanbanDataDir);
  const kanbanTools = createKanbanTools(store, input);
  const peerSessionCoordinator = new PeerSessionCoordinator(kanbanDataDir, async () => {
    try {
      const response = await input.client.session.list();
      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      const sessions: NativeSessionInfo[] = [];
      for (const session of response.data as Array<{
        id: string;
        title?: string;
        time?: { created?: string | number; updated?: string | number };
      }>) {
        sessions.push({
          sessionId: session.id,
          sessionTitle: session.title || undefined,
          sessionCreatedAt: session.time?.created ? new Date(session.time.created).toISOString() : undefined,
          updatedAt: session.time?.updated ? new Date(session.time.updated).toISOString() : undefined,
        });
      }
      return sessions;
    } catch {
      return [];
    }
  });
  await peerSessionCoordinator.init();

  const settingsStore = new SettingsStore(kanbanDataDir);
  const telegramStateStore = new TelegramStateStore(kanbanDataDir);
  const runtimeRunStore = new RuntimeRunStore(kanbanDataDir);
  const childLinker = new ChildLinker(store);
  await runtimeRunStore.reconcileStale(store, childLinker);
  const claudeCodexWatchdog = new ClaudeCodexWatchdog(store, runtimeRunStore);

  let dispatchCard: (cardId: string) => Promise<DispatchResult>;

  const runtimeRegistry = createRuntimeRegistry([
    createOpencodeAdapter({
      store,
      client: input.client,
      serverUrl: input.serverUrl,
      trackDispatch,
      buildPromptBody: buildDispatchPromptBody,
      runCommandThenPrompt: runCardCommandThenPrompt,
      selectSession: async (sessionId, title) => {
        try {
          const selectUrl = new URL('/tui/select-session', input.serverUrl);
          const selectResponse = await fetch(selectUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionID: sessionId }),
          });
          if (!selectResponse.ok) {
            input.client.tui.showToast({
              body: {
                message: `Kanban dispatched: ${title} → session ${sessionId}`,
                variant: 'info',
              },
            });
          }
        } catch {
          try {
            input.client.tui.showToast({
              body: {
                message: `Kanban dispatched: ${title} → session ${sessionId}`,
                variant: 'info',
              },
            });
          } catch {
          }
        }
      },
    }),
    createClaudeAdapter({
      store,
      settingsStore,
      runStore: runtimeRunStore,
      dispatchFn: (cardId) => dispatchCard(cardId),
      onChildEvent: (parentCardId, runId, ev) => childLinker.onChildEvent(parentCardId, runId, ev),
    }),
    createCodexCliAdapter({
      store,
      settingsStore,
      runStore: runtimeRunStore,
      dispatchFn: (cardId) => dispatchCard(cardId),
    }),
  ]);

  dispatchCard = async (cardId: string): Promise<DispatchResult> => {
    const card = await store.getCard(cardId);
    if (!card) throw new Error('Card not found');

    // Validate projectDir if specified
    if (card.projectDir) {
      if (!existsSync(card.projectDir)) {
        throw new Error(`Project directory does not exist: ${card.projectDir}`);
      }
      const stat = statSync(card.projectDir);
      if (!stat.isDirectory()) {
        throw new Error(`Project path is not a directory: ${card.projectDir}`);
      }
    }

    const resumeSessionId = await resolveResumeSessionId(store, card);
    const adapter = runtimeRegistry.pickAdapter(resolveAgentRuntime(card));
    const prompt = buildDispatchPromptText(card, (screenshot) => store.getScreenshotPath(screenshot.filename));
    const cwd = card.projectDir ?? process.cwd();
    await captureGitStart(store, card.id, cwd); // best-effort, never throws
    const handle = await adapter.start({
      card,
      prompt,
      cwd,
      resumeSessionId,
    });

    if (!handle.sessionId) {
      throw new RuntimeDispatchError('Runtime did not return a continuation sessionId', 500);
    }

    return {
      sessionId: handle.sessionId,
      runId: handle.runId,
      startedAt: handle.startedAt,
    };
  };

  let telegramPoller: TelegramPoller | undefined;

  const eventHooks = createEventHooks(
    store,
    input,
    dispatchCard,
    settingsStore,
  );

  // Scheduler subsystem
  const schedulerStore = new SchedulerStore(kanbanDataDir);
  const schedulerEngine = new SchedulerEngine(schedulerStore, settingsStore);
  const scriptStore = new ScriptStore(kanbanDataDir);
  const skillStore = new SkillStore(kanbanDataDir);
  const skillRootsStore = new SkillRootsStore(kanbanDataDir);
  const placementTargetsStore = new PlacementTargetsStore(kanbanDataDir);
  const runtimeLock = new RuntimeLock(kanbanDataDir, 'singleton-runtime');
  let isRuntimeOwner = await runtimeLock.acquire();
  schedulerEngine.setRuntimeOwner(isRuntimeOwner);

  const scriptsDir = scriptStore.scriptsDir;
  if (scriptsDir && !existsSync(scriptsDir)) {
    mkdirSync(scriptsDir, { recursive: true });
  }

  // Discover skills from disk and register them so user-authored skills surface
  // as runtime commands without a code change. Best-effort: a scan failure must
  // not block plugin startup.
  try {
    const skillRoots = await skillRootsStore.getRoots();
    await skillStore.sync(skillRoots);
    setDynamicSkillCommands(await skillStore.getSkills());
  } catch {
    // Skill discovery is non-critical; fall back to the static command tables.
  }
  const schedulerTools = createSchedulerTools(schedulerStore, schedulerEngine, input);
  const settingsTools = createSettingsTools(settingsStore, input);

  // Ensure default network_exposed setting exists
  const existingEntries = await settingsStore.getEntries();
  const hasNetworkSetting = existingEntries.some((e: import('../core/types').SettingsEntry) => e.key === 'network_exposed');
  if (!hasNetworkSetting) {
    await settingsStore.createEntry({
      key: 'network_exposed',
      value: 'false',
      description: 'Allow network access to kanban board (0.0.0.0 vs 127.0.0.1)',
      category: 'network',
      masked: false,
    });
  }
  const hasLanFullAccess = existingEntries.some((e: import('../core/types').SettingsEntry) => e.key === 'lan_full_access');
  if (!hasLanFullAccess) {
    await settingsStore.createEntry({
      key: 'lan_full_access',
      value: 'false',
      description: 'Serve the auth token to LAN clients too, unlocking Capabilities/Skills/Settings and mutations off-localhost (only meaningful with network_exposed)',
      category: 'network',
      masked: false,
    });
  }

  // Hide any legacy wiki-internal cards (minted before the chat-message guard)
  // from the board and keep them out of the wiki processing queue.
  await sweepWikiInternalCards(store);

  // Wiki worker — consumes wiki-pending archived cards into the Obsidian vault
  const wikiWorker = new WikiWorker(store, settingsStore);

  // Models function: returns available models from opencode SDK
  const modelsFn: ModelsFn = async (): Promise<ModelInfo[]> => {
    try {
      const response = await input.client.config.providers();
      if (!response.data) return [];
      const models: ModelInfo[] = [];
      for (const provider of response.data.providers) {
        for (const [, model] of Object.entries(provider.models)) {
          models.push({
            id: `${provider.id}/${model.id}`,
            name: model.name || model.id,
            providerID: provider.id,
            providerName: provider.name || provider.id,
          });
        }
      }
      return models;
    } catch {
      return [];
    }
  };

  // Create question monitor (watches opencode SSE stream for pending questions)
  const questionMonitor = new QuestionMonitor(input, store, {
    enableRecommendedAutoReply: isRuntimeOwner,
  });

  // Start server with auto-recovery monitoring
  const monitor = new ServerMonitor(
    store,
    input,
    dispatchCard,
    schedulerStore,
    schedulerEngine,
    settingsStore,
    scriptStore,
    modelsFn,
    questionMonitor,
    () => peerSessionCoordinator.aggregateAllSessions(),
    peerSessionCoordinator.buildLocalPayload,
    () => peerSessionCoordinator.getPeerToken(),
    undefined,
    wikiWorker,
    skillStore,
    skillRootsStore,
    placementTargetsStore,
    runtimeRunStore,
  );
  const port = await monitor.start();
  if (port) {
    peerSessionCoordinator.register(port);
  }

  const staleChecker = new StaleCardChecker(store, input);
  let singletonRuntimeStarted = false;

  const startSingletonRuntime = async (): Promise<void> => {
    if (singletonRuntimeStarted) return;
    appendRuntimeDebugLog('runtime.start', {
      runtimeOwner: true,
    });
    schedulerEngine.setRuntimeOwner(true);
    await schedulerEngine.start();
    staleChecker.start();
    claudeCodexWatchdog.start();
    wikiWorker.start();
    telegramPoller?.start();
    telegramReminder.start();
    singletonRuntimeStarted = true;
  };

  const stopSingletonRuntime = (): void => {
    if (!singletonRuntimeStarted) return;
    appendRuntimeDebugLog('runtime.stop', {
      runtimeOwner: false,
    });
    telegramReminder.stop();
    telegramPoller?.stop();
    wikiWorker.stop();
    claudeCodexWatchdog.stop();
    staleChecker.stop();
    schedulerEngine.setRuntimeOwner(false);
    singletonRuntimeStarted = false;
  };

  questionMonitor.start();
  questionMonitor.setRecommendedAutoReplyEnabled(isRuntimeOwner);

  // Telegram poller — polls Telegram Bot API for new messages
  // followUpFn sends a prompt to an existing opencode session
  const followUpFn: FollowUpFn = async (sessionId: string, text: string, options) => {
    const latestCard = await store.findCardBySessionId(sessionId);
    const promptBody = buildDispatchPromptBody({
      model: options?.model ?? latestCard?.model,
      agentType: options?.agentType ?? latestCard?.agentType,
      description: text,
    });

    await input.client.session.promptAsync({
      path: { id: sessionId },
      body: promptBody,
    });
  };
  telegramPoller = new TelegramPoller(store, settingsStore, dispatchCard, followUpFn, {
    telegramStateStore,
  });
  const telegramReminder = new TelegramReminderService(
    store,
    telegramStateStore,
    async () => {
      const entries = await settingsStore.getEntries();
      return entries.find(entry => entry.key === 'TELEGRAM_BOT_TOKEN')?.value;
    },
    async (chatId) => telegramPoller.getSessionsForChat(chatId),
  );

  if (isRuntimeOwner) {
    appendRuntimeDebugLog('runtime.owner.initial', { owner: true });
    await startSingletonRuntime();
  } else {
    appendRuntimeDebugLog('runtime.owner.initial', { owner: false });
  }

  const unsubscribeRuntimeLock = runtimeLock.onChange(async (owner) => {
    isRuntimeOwner = owner;
    questionMonitor.setRecommendedAutoReplyEnabled(owner);
    appendRuntimeDebugLog('runtime.owner.change', { owner });

    if (owner) {
      await startSingletonRuntime();
      return;
    }

    stopSingletonRuntime();
  });

  if (port) {
    try {
      input.client?.tui?.showToast({
        body: { message: `Kanban board available at http://localhost:${port}`, variant: 'info' },
      });
    } catch {
      // Toast not available
    }
  } else {
    try {
      input.client?.tui?.showToast({
        body: { message: 'Kanban server: another instance is serving. Monitoring for recovery.', variant: 'info' },
      });
    } catch {
      // Toast not available
    }
  }

  // Cleanup on process exit
  process.on('beforeExit', () => {
    appendRuntimeDebugLog('plugin.beforeExit');
    peerSessionCoordinator.markDraining();
    unsubscribeRuntimeLock();
    stopSingletonRuntime();
    schedulerEngine.stop();
    questionMonitor.stop();
    runtimeLock.release();
    monitor.stop();
    peerSessionCoordinator.unregister();
  });

  return {
    tool: { ...kanbanTools, ...schedulerTools, ...settingsTools },
    ...eventHooks,
  };
};

export default plugin;
