import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { PluginInput } from '@opencode-ai/plugin';
import type { KanbanStore } from '../core/store';
import {
  createServer,
  type DispatchFn,
  type ModelsFn,
  type RuntimeCatalogFn,
  type AggregateSessionsFn,
  type LocalPeerSessionsFn,
  type PeerTokenFn,
} from '../server/index';
import type { SchedulerStore } from '../core/scheduler-store';
import type { SchedulerEngine } from './scheduler-engine';
import type { SettingsStore } from '../core/settings-store';
import type { ScriptStore } from '../core/script-store';
import type { QuickActionStore } from '../core/quick-action-store';
import type { ScriptExecutionService } from './script-execution-service';
import type { SkillStore } from '../core/skill-store';
import type { SkillRootsStore } from '../core/skill-roots-store';
import type { PlacementTargetsStore } from '../core/placement-targets-store';
import type { RuntimeRunStore } from './runtimes/runtime-run-store';
import type { QuestionMonitor } from './question-monitor';
import type { WikiWorker } from './wiki/wiki-worker';

/**
 * Resolve the web UI static directory.
 *
 * Checks multiple candidate paths to support both:
 * - Development: plugin source is in src/plugin/, web/dist is at ../../web/dist
 * - Installed: plugin bundle is in $PLUGIN_DIR/, web UI is at ./web
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    resolve(import.meta.dir, '../../web/dist'),  // development (source tree)
    resolve(import.meta.dir, 'web/dist'),         // installed (nested dist)
    resolve(import.meta.dir, 'web'),              // installed (flat copy)
  ];

  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'index.html'))) {
      return dir;
    }
  }

  return undefined; // No static dir found — API-only mode
}

export class ServerMonitor {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly store: KanbanStore;
  private readonly input: PluginInput | null;
  private readonly port: number;
  private readonly dispatchFn?: DispatchFn;
  private hostname?: string;
  private onNetworkSettingChange: (hostname: string) => void;
  private readonly schedulerStore?: SchedulerStore;
  private readonly schedulerEngine?: SchedulerEngine;
  private readonly settingsStore?: SettingsStore;
  private readonly scriptStore?: ScriptStore;
  private readonly modelsFn?: ModelsFn;
  private readonly questionMonitor?: QuestionMonitor;
  private readonly aggregateSessionsFn?: AggregateSessionsFn;
  private readonly localPeerSessionsFn?: LocalPeerSessionsFn;
  private readonly peerTokenFn?: PeerTokenFn;
  private readonly runtimeCatalogFn?: RuntimeCatalogFn;
  private readonly wikiWorker?: WikiWorker;
  private readonly skillStore?: SkillStore;
  private readonly skillRootsStore?: SkillRootsStore;
  private readonly placementTargetsStore?: PlacementTargetsStore;
  private readonly runtimeRunStore?: RuntimeRunStore;
  private readonly quickActionStore?: QuickActionStore;
  private readonly scriptExecutionService?: ScriptExecutionService;

  constructor(
    store: KanbanStore,
    input: PluginInput | null,
    dispatchFn?: DispatchFn,
    schedulerStore?: SchedulerStore,
    schedulerEngine?: SchedulerEngine,
    settingsStore?: SettingsStore,
    scriptStore?: ScriptStore,
    modelsFn?: ModelsFn,
    questionMonitor?: QuestionMonitor,
    aggregateSessionsFn?: AggregateSessionsFn,
    localPeerSessionsFn?: LocalPeerSessionsFn,
    peerTokenFn?: PeerTokenFn,
    runtimeCatalogFn?: RuntimeCatalogFn,
    wikiWorker?: WikiWorker,
    skillStore?: SkillStore,
    skillRootsStore?: SkillRootsStore,
    placementTargetsStore?: PlacementTargetsStore,
    runtimeRunStore?: RuntimeRunStore,
    quickActionStore?: QuickActionStore,
    scriptExecutionService?: ScriptExecutionService,
  ) {
    this.store = store;
    this.input = input;
    this.port = parseInt(process.env.KANBAN_PORT ?? '24680', 10);
    this.dispatchFn = dispatchFn;
    this.schedulerStore = schedulerStore;
    this.schedulerEngine = schedulerEngine;
    this.settingsStore = settingsStore;
    this.scriptStore = scriptStore;
    this.modelsFn = modelsFn;
    this.questionMonitor = questionMonitor;
    this.aggregateSessionsFn = aggregateSessionsFn;
    this.localPeerSessionsFn = localPeerSessionsFn;
    this.peerTokenFn = peerTokenFn;
    this.runtimeCatalogFn = runtimeCatalogFn;
    this.wikiWorker = wikiWorker;
    this.skillStore = skillStore;
    this.skillRootsStore = skillRootsStore;
    this.placementTargetsStore = placementTargetsStore;
    this.runtimeRunStore = runtimeRunStore;
    this.quickActionStore = quickActionStore;
    this.scriptExecutionService = scriptExecutionService;

    // Create the network setting change callback that restarts with new hostname
    this.onNetworkSettingChange = (newHostname: string) => this.restart(newHostname);

    // Read initial hostname from settings
    this.hostname = undefined; // will be resolved in start()
  }

  /** Single place that assembles the createServer() dependency list. */
  private createServerInstance(hostname: string | undefined) {
    return createServer(
      this.store,
      this.port,
      resolveStaticDir(),
      this.dispatchFn,
      this.schedulerStore,
      this.schedulerEngine,
      this.settingsStore,
      hostname,
      this.onNetworkSettingChange,
      this.scriptStore,
      this.modelsFn,
      this.questionMonitor,
      this.aggregateSessionsFn,
      this.localPeerSessionsFn,
      this.peerTokenFn,
      this.runtimeCatalogFn,
      this.wikiWorker,
      this.skillStore,
      this.skillRootsStore,
      this.placementTargetsStore,
      this.runtimeRunStore,
      undefined,
      this.quickActionStore,
      this.scriptExecutionService,
    );
  }

  /** Try to start the server. Returns port if successful, null if port is in use. */
  async start(): Promise<number | null> {
    // Resolve initial hostname from network_exposed setting
    if (this.settingsStore) {
      const entries = await this.settingsStore.getEntries();
      const networkSetting = entries.find(e => e.key === 'network_exposed');
      if (networkSetting && networkSetting.value === 'true') {
        this.hostname = '0.0.0.0';
      } else {
        this.hostname = '127.0.0.1';
      }
    }

    try {
      const result = this.createServerInstance(this.hostname);
      this.server = result.server;
      this.startMonitoring();
      return result.port;
    } catch {
      // Port likely in use by another opencode process — start monitoring
      this.startMonitoring();
      return null;
    }
  }

  /** Restart server with new hostname. Used when network_exposed setting changes. */
  restart(hostname: string): void {
    this.hostname = hostname;
    // Stop existing server immediately
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    // Recreate with new hostname immediately to prevent port theft
    try {
      const result = this.createServerInstance(hostname);
      this.server = result.server;
    } catch {
      // Failed to restart — will be recovered by monitor on next poll
    }
  }

  /** Poll every 10s to check if server is alive. If dead, try to take over. */
  private startMonitoring(): void {
    // Don't start duplicate monitors
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.checkAndRecover();
    }, 10_000);

    // Unref so timer doesn't prevent process exit
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
  }

  /** Check if the port is serving. If not, attempt to start our own server. */
  private async checkAndRecover(): Promise<void> {
    // If we already own the server, skip
    if (this.server) return;

    try {
      // Quick health check — try to connect
      const response = await fetch(`http://localhost:${this.port}/api/board`, {
        signal: AbortSignal.timeout(2000),
      });
      // Server is alive (someone else is serving) — do nothing
      if (response.ok) return;
    } catch {
      // Connection failed — server is down, try to take over
    }

    try {
      const result = this.createServerInstance(this.hostname);
      this.server = result.server;

      // Notify user if possible
      try {
        this.input?.client?.tui?.showToast({
          body: { message: `Kanban board recovered at http://localhost:${result.port}`, variant: 'info' },
        });
      } catch {
        // Toast not available
      }
    } catch {
      // Still can't start — another process beat us to it, or port issue
      // Will retry on next interval
    }
  }

  /** Stop the server and monitoring. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }
}
