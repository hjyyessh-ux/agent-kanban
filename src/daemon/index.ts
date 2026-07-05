import { KanbanStore } from '../core/store';
import { SchedulerStore } from '../core/scheduler-store';
import { SettingsStore } from '../core/settings-store';
import { ScriptStore } from '../core/script-store';
import { SkillStore } from '../core/skill-store';
import { SkillRootsStore } from '../core/skill-roots-store';
import { PlacementTargetsStore } from '../core/placement-targets-store';
import { setDynamicSkillCommands } from '../core/commands';
import { TelegramStateStore } from '../core/telegram-state-store';
import { SchedulerEngine } from '../plugin/scheduler-engine';
import { ServerMonitor } from '../plugin/server';
import { RuntimeLock } from '../plugin/runtime-lock';
import { PeerSessionCoordinator } from '../plugin/peer-session-coordinator';
import { TelegramPoller } from '../plugin/telegram-poller';
import { TelegramReminderService } from '../plugin/telegram-reminder';
import { WikiWorker } from '../plugin/wiki/wiki-worker';
import { sweepWikiInternalCards } from '../plugin/wiki/wiki-sweep';
import { getKanbanDataDir } from '../plugin/config';
import { appendRuntimeDebugLog } from '../plugin/debug-log';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';

const kanbanDataDir = getKanbanDataDir();

const store = new KanbanStore(kanbanDataDir);
const schedulerStore = new SchedulerStore(kanbanDataDir);
const settingsStore = new SettingsStore(kanbanDataDir);
// Hide any legacy wiki-internal cards (minted before the chat-message guard)
// from the board and keep them out of the wiki processing queue.
await sweepWikiInternalCards(store);
const scriptStore = new ScriptStore(kanbanDataDir);
const skillStore = new SkillStore(kanbanDataDir);
const skillRootsStore = new SkillRootsStore(kanbanDataDir);
const placementTargetsStore = new PlacementTargetsStore(kanbanDataDir);
const schedulerEngine = new SchedulerEngine(schedulerStore, settingsStore);
const telegramStateStore = new TelegramStateStore(kanbanDataDir);
const runtimeHost = await createStandaloneRuntimeHost({
  store,
  settingsStore,
  dataDir: kanbanDataDir,
});

// Seed network settings so the Settings UI can render their toggles on
// daemon-only installs (the opencode plugin path seeds these too; both are
// idempotent against the shared settings store).
{
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
}

const peerSessionCoordinator = new PeerSessionCoordinator(
  kanbanDataDir,
  async () => [],
);
await peerSessionCoordinator.init();

const runtimeLock = new RuntimeLock(kanbanDataDir, 'singleton-runtime');
let isOwner = await runtimeLock.acquire();
schedulerEngine.setRuntimeOwner(isOwner);

// Wiki worker — consumes wiki-pending archived cards into the Obsidian vault.
// Only runs on the singleton runtime owner (start/stop below).
const wikiWorker = new WikiWorker(store, settingsStore);

// Discover skills from disk and register them so user-authored skills surface
// as runtime commands without a code change. Best-effort: a scan failure must
// not block startup.
try {
  const skillRoots = await skillRootsStore.getRoots();
  await skillStore.sync(skillRoots);
  setDynamicSkillCommands(await skillStore.getSkills());
} catch {
  // Skill discovery is non-critical; fall back to the static command tables.
}

const monitor = new ServerMonitor(
  store,
  null,
  runtimeHost.dispatchCard,
  schedulerStore,
  schedulerEngine,
  settingsStore,
  scriptStore,
  undefined,
  undefined,
  () => peerSessionCoordinator.aggregateAllSessions(),
  peerSessionCoordinator.buildLocalPayload,
  () => peerSessionCoordinator.getPeerToken(),
  () => runtimeHost.getRuntimeCatalog(),
  wikiWorker,
  skillStore,
  skillRootsStore,
  placementTargetsStore,
  runtimeHost.runStore,
);

const port = await monitor.start();
if (port) {
  peerSessionCoordinator.register(port);
}

const telegramPoller = new TelegramPoller(
  store,
  settingsStore,
  runtimeHost.dispatchCard,
  undefined,
  { telegramStateStore },
);

const telegramReminder = new TelegramReminderService(
  store,
  telegramStateStore,
  async () => {
    const entries = await settingsStore.getEntries();
    return entries.find(e => e.key === 'TELEGRAM_BOT_TOKEN')?.value;
  },
  async (chatId) => telegramPoller.getSessionsForChat(chatId),
);

let singletonStarted = false;

const startSingleton = async (): Promise<void> => {
  if (singletonStarted) return;
  appendRuntimeDebugLog('daemon.runtime.start', { owner: true });
  schedulerEngine.setRuntimeOwner(true);
  await schedulerEngine.start();
  telegramPoller.start();
  telegramReminder.start();
  wikiWorker.start();
  singletonStarted = true;
};

const stopSingleton = (): void => {
  if (!singletonStarted) return;
  appendRuntimeDebugLog('daemon.runtime.stop', { owner: false });
  telegramReminder.stop();
  telegramPoller.stop();
  wikiWorker.stop();
  schedulerEngine.setRuntimeOwner(false);
  singletonStarted = false;
};

if (isOwner) {
  await startSingleton();
}

runtimeLock.onChange(async (owner) => {
  isOwner = owner;
  if (owner) {
    await startSingleton();
  } else {
    stopSingleton();
  }
});

appendRuntimeDebugLog('daemon.init', { port, owner: isOwner, dataDir: kanbanDataDir });

const shutdown = (): void => {
  stopSingleton();
  runtimeLock.release();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep process alive — all real work is driven by timers inside the services above.
setInterval(() => {}, 30_000).unref();
// Prevent Bun from exiting by holding a ref on a dummy timer
setInterval(() => {}, 1_000 * 60 * 60);
