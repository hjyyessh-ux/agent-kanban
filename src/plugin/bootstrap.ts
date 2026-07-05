import { existsSync, mkdirSync } from 'node:fs';
import type { PluginInput } from '@opencode-ai/plugin';
import { KanbanStore } from '../core/store';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';
import { ScriptStore } from '../core/script-store';
import { SkillStore } from '../core/skill-store';
import { SkillRootsStore } from '../core/skill-roots-store';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { setDynamicSkillCommands } from '../core/commands';
import { TelegramStateStore } from '../core/telegram-state-store';
import type { DispatchResult } from '../core/types';
import type { RuntimeCatalogEntry } from '../core/runtime-config';
import type { ModelsFn } from '../server/routes';
import { SchedulerEngine } from './scheduler-engine';
import { ServerMonitor } from './server';
import { RuntimeLock } from './runtime-lock';
import { PeerSessionCoordinator, type NativeSessionInfo } from './peer-session-coordinator';
import { TelegramPoller, type FollowUpFn } from './telegram-poller';
import { TelegramReminderService } from './telegram-reminder';
import { WikiWorker } from './wiki/wiki-worker';
import { sweepWikiInternalCards } from './wiki/wiki-sweep';
import { appendRuntimeDebugLog } from './debug-log';
import type { QuestionMonitor } from './question-monitor';
import type { RuntimeRunStore } from './runtimes/runtime-run-store';

/** Owner-gated background service started/stopped with the singleton runtime. */
export interface SingletonService {
  start(): void;
  stop(): void;
}

export interface KanbanAppStores {
  dataDir: string;
  store: KanbanStore;
  schedulerStore: SchedulerStore;
  settingsStore: SettingsStore;
  scriptStore: ScriptStore;
  skillStore: SkillStore;
  skillRootsStore: SkillRootsStore;
  placementTargetsStore: PlacementTargetsStore;
  telegramStateStore: TelegramStateStore;
  schedulerEngine: SchedulerEngine;
}

/** The entrypoint-specific dispatch engine produced by `createDispatch`. */
export interface DispatchEngine {
  dispatchCard: (cardId: string) => Promise<DispatchResult>;
  runStore?: RuntimeRunStore;
  runtimeCatalogFn?: () => RuntimeCatalogEntry[];
  /**
   * Extra owner-gated services (watchdogs, stale checkers). Started right
   * after the scheduler engine, stopped in reverse order.
   */
  singletonServices?: SingletonService[];
}

export interface CreateKanbanAppOptions {
  dataDir: string;
  /** opencode plugin host input; null when running as the standalone daemon. */
  opencodeInput: PluginInput | null;
  /** Debug-log label prefix for runtime lifecycle events (`<label>.start` …). */
  debugLabel: string;
  /**
   * Builds the runtime dispatch engine once the stores exist. The daemon and
   * the opencode plugin keep separate dispatch implementations on purpose —
   * see docs/invariants.md — so this stays a caller-supplied factory.
   */
  createDispatch: (stores: KanbanAppStores) => Promise<DispatchEngine>;
  /** Native session listing for the peer coordinator (opencode host only). */
  listNativeSessions?: () => Promise<NativeSessionInfo[]>;
  /** SDK model catalog for the REST API (opencode host only). */
  modelsFn?: ModelsFn;
  /** Question monitor factory (opencode host only); started by the app. */
  createQuestionMonitor?: (stores: KanbanAppStores, isRuntimeOwner: boolean) => QuestionMonitor;
  /** Telegram follow-up sender for existing sessions (opencode host only). */
  createFollowUpFn?: (stores: KanbanAppStores) => FollowUpFn;
  /** Called with the new owner flag before singleton services react to it. */
  onRuntimeOwnerChange?: (owner: boolean) => void;
}

export interface KanbanApp extends KanbanAppStores {
  dispatchCard: (cardId: string) => Promise<DispatchResult>;
  wikiWorker: WikiWorker;
  peerSessionCoordinator: PeerSessionCoordinator;
  telegramPoller: TelegramPoller;
  telegramReminder: TelegramReminderService;
  questionMonitor?: QuestionMonitor;
  monitor: ServerMonitor;
  port: number | null;
  runtimeLock: RuntimeLock;
  isRuntimeOwner(): boolean;
  startSingleton(): Promise<void>;
  stopSingleton(): void;
  unsubscribeRuntimeLock(): void;
}

/**
 * Shared boot wiring for both backend entrypoints (standalone daemon and
 * opencode plugin): stores, settings seeds, skill discovery, HTTP server,
 * Telegram services, wiki worker, and the singleton-runtime lock lifecycle.
 */
export async function createKanbanApp(options: CreateKanbanAppOptions): Promise<KanbanApp> {
  const { dataDir } = options;

  const store = new KanbanStore(dataDir);
  const schedulerStore = new SchedulerStore(dataDir);
  const settingsStore = new SettingsStore(dataDir);
  // Hide any legacy wiki-internal cards (minted before the chat-message guard)
  // from the board and keep them out of the wiki processing queue.
  await sweepWikiInternalCards(store);
  const scriptStore = new ScriptStore(dataDir);
  const skillStore = new SkillStore(dataDir);
  const skillRootsStore = new SkillRootsStore(dataDir);
  const placementTargetsStore = new PlacementTargetsStore(dataDir);
  const schedulerEngine = new SchedulerEngine(schedulerStore, settingsStore);
  const telegramStateStore = new TelegramStateStore(dataDir);

  const stores: KanbanAppStores = {
    dataDir,
    store,
    schedulerStore,
    settingsStore,
    scriptStore,
    skillStore,
    skillRootsStore,
    placementTargetsStore,
    telegramStateStore,
    schedulerEngine,
  };

  const dispatch = await options.createDispatch(stores);

  // Seed network settings so the Settings UI can render their toggles on
  // fresh installs. Idempotent against the shared settings store.
  const existingEntries = await settingsStore.getEntries();
  if (!existingEntries.some(e => e.key === 'network_exposed')) {
    await settingsStore.createEntry({
      key: 'network_exposed',
      value: 'false',
      description: 'Allow network access to kanban board (0.0.0.0 vs 127.0.0.1)',
      category: 'network',
      masked: false,
    });
  }
  if (!existingEntries.some(e => e.key === 'lan_full_access')) {
    await settingsStore.createEntry({
      key: 'lan_full_access',
      value: 'false',
      description: 'Serve the auth token to LAN clients too, unlocking Capabilities/Skills/Settings and mutations off-localhost (only meaningful with network_exposed)',
      category: 'network',
      masked: false,
    });
  }

  const scriptsDir = scriptStore.scriptsDir;
  if (scriptsDir && !existsSync(scriptsDir)) {
    mkdirSync(scriptsDir, { recursive: true });
  }

  const peerSessionCoordinator = new PeerSessionCoordinator(
    dataDir,
    options.listNativeSessions ?? (async () => []),
  );
  await peerSessionCoordinator.init();

  const runtimeLock = new RuntimeLock(dataDir, 'singleton-runtime');
  let isRuntimeOwner = await runtimeLock.acquire();
  schedulerEngine.setRuntimeOwner(isRuntimeOwner);

  // Wiki worker — consumes wiki-pending archived cards into the Obsidian
  // vault. Only runs on the singleton runtime owner (start/stop below).
  const wikiWorker = new WikiWorker(store, settingsStore);

  // Discover skills from disk and register them so user-authored skills
  // surface as runtime commands without a code change. Best-effort: a scan
  // failure must not block startup.
  try {
    const skillRoots = await skillRootsStore.getRoots();
    await skillStore.sync(skillRoots);
    setDynamicSkillCommands(await skillStore.getSkills());
  } catch {
    // Skill discovery is non-critical; fall back to the static command tables.
  }

  const questionMonitor = options.createQuestionMonitor?.(stores, isRuntimeOwner);

  // Start server with auto-recovery monitoring
  const monitor = new ServerMonitor(
    store,
    options.opencodeInput,
    dispatch.dispatchCard,
    schedulerStore,
    schedulerEngine,
    settingsStore,
    scriptStore,
    options.modelsFn,
    questionMonitor,
    () => peerSessionCoordinator.aggregateAllSessions(),
    peerSessionCoordinator.buildLocalPayload,
    () => peerSessionCoordinator.getPeerToken(),
    dispatch.runtimeCatalogFn,
    wikiWorker,
    skillStore,
    skillRootsStore,
    placementTargetsStore,
    dispatch.runStore,
  );
  const port = await monitor.start();
  if (port) {
    peerSessionCoordinator.register(port);
  }

  // Telegram poller — polls Telegram Bot API for new messages
  const telegramPoller = new TelegramPoller(
    store,
    settingsStore,
    dispatch.dispatchCard,
    options.createFollowUpFn?.(stores),
    { telegramStateStore },
  );

  const telegramReminder = new TelegramReminderService(
    store,
    telegramStateStore,
    async () => {
      const entries = await settingsStore.getEntries();
      return entries.find(entry => entry.key === 'TELEGRAM_BOT_TOKEN')?.value;
    },
    async (chatId) => telegramPoller.getSessionsForChat(chatId),
  );

  const extraServices = dispatch.singletonServices ?? [];
  let singletonStarted = false;

  const startSingleton = async (): Promise<void> => {
    if (singletonStarted) return;
    appendRuntimeDebugLog(`${options.debugLabel}.start`, { owner: true });
    schedulerEngine.setRuntimeOwner(true);
    await schedulerEngine.start();
    for (const service of extraServices) {
      service.start();
    }
    wikiWorker.start();
    telegramPoller.start();
    telegramReminder.start();
    singletonStarted = true;
  };

  const stopSingleton = (): void => {
    if (!singletonStarted) return;
    appendRuntimeDebugLog(`${options.debugLabel}.stop`, { owner: false });
    telegramReminder.stop();
    telegramPoller.stop();
    wikiWorker.stop();
    for (const service of [...extraServices].reverse()) {
      service.stop();
    }
    schedulerEngine.setRuntimeOwner(false);
    singletonStarted = false;
  };

  questionMonitor?.start();

  appendRuntimeDebugLog(`${options.debugLabel}.owner.initial`, { owner: isRuntimeOwner });
  if (isRuntimeOwner) {
    await startSingleton();
  }

  const unsubscribeRuntimeLock = runtimeLock.onChange(async (owner) => {
    isRuntimeOwner = owner;
    options.onRuntimeOwnerChange?.(owner);
    appendRuntimeDebugLog(`${options.debugLabel}.owner.change`, { owner });

    if (owner) {
      await startSingleton();
      return;
    }

    stopSingleton();
  });

  return {
    ...stores,
    dispatchCard: dispatch.dispatchCard,
    wikiWorker,
    peerSessionCoordinator,
    telegramPoller,
    telegramReminder,
    questionMonitor,
    monitor,
    port,
    runtimeLock,
    isRuntimeOwner: () => isRuntimeOwner,
    startSingleton,
    stopSingleton,
    unsubscribeRuntimeLock,
  };
}
