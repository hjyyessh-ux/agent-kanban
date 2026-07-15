import { existsSync, statSync } from 'node:fs';
import type { KanbanStore } from '../../core/store';
import type { SettingsStore } from '../../core/settings-store';
import type { AgentRuntime, DispatchResult, KanbanCard } from '../../core/types';
import {
  RUNTIME_CATALOG,
  resolveAgentRuntime,
  type RuntimeCatalogEntry,
  type RuntimeHostKind,
} from '../../core/runtime-config';
import { createRuntimeRegistry } from './runtime-registry';
import { createCodexCliAdapter } from './codex-cli-adapter';
import { createClaudeAdapter } from './claude-adapter';
import { ChildLinker } from './child-linker';
import { RuntimeRunStore } from './runtime-run-store';
import { ClaudeCodexWatchdog } from './claude-codex-watchdog';
import { RuntimeDispatchError } from './types';
import type { RuntimeRegistry } from './types';
import { createUnavailableOpencodeAdapter, STANDALONE_OPENCODE_UNAVAILABLE_REASON } from './unavailable-opencode-adapter';
import { isRecentlyFailed } from '../hooks/event-handler';
import { buildDispatchPromptText } from '../dispatch-prompt';
import { captureGitStart } from './git-capture';
import { mergeCodexCliModelsIntoCatalog } from './codex-model-catalog';

export interface RuntimeAvailability {
  runtime: AgentRuntime;
  available: boolean;
  unavailableReason?: string;
  hostKind: RuntimeHostKind;
}

export interface RuntimeHost {
  runStore: RuntimeRunStore;
  registry: RuntimeRegistry;
  watchdog: ClaudeCodexWatchdog;
  dispatchCard(cardId: string): Promise<DispatchResult>;
  getRuntimeAvailability(): RuntimeAvailability[];
  getRuntimeCatalog(): Promise<RuntimeCatalogEntry[]>;
}

export interface StandaloneRuntimeHostOptions {
  store: KanbanStore;
  settingsStore: SettingsStore;
  dataDir: string;
  cwd?: string;
  codexCommandOverride?: string[];
  claudeCommandOverride?: string[];
  codexThreadIdTimeoutMs?: number;
  claudeSessionIdTimeoutMs?: number;
}

export async function createStandaloneRuntimeHost(options: StandaloneRuntimeHostOptions): Promise<RuntimeHost> {
  const runStore = new RuntimeRunStore(options.dataDir);
  const childLinker = new ChildLinker(options.store);
  await runStore.reconcileStale(options.store, childLinker);
  const watchdog = new ClaudeCodexWatchdog(options.store, runStore);
  let dispatchCard: (cardId: string) => Promise<DispatchResult>;
  const registry = createRuntimeRegistry([
    createUnavailableOpencodeAdapter({ store: options.store }),
    createClaudeAdapter({
      store: options.store,
      settingsStore: options.settingsStore,
      runStore,
      commandOverride: options.claudeCommandOverride,
      sessionIdTimeoutMs: options.claudeSessionIdTimeoutMs,
      dispatchFn: (cardId) => dispatchCard(cardId),
      onChildEvent: (parentCardId, runId, ev) => childLinker.onChildEvent(parentCardId, runId, ev),
    }),
    createCodexCliAdapter({
      store: options.store,
      settingsStore: options.settingsStore,
      runStore,
      commandOverride: options.codexCommandOverride,
      threadIdTimeoutMs: options.codexThreadIdTimeoutMs,
      dispatchFn: (cardId) => dispatchCard(cardId),
    }),
  ]);

  dispatchCard = async (cardId: string): Promise<DispatchResult> => {
    const card = await options.store.getCard(cardId);
    if (!card) throw new RuntimeDispatchError('Card not found', 404);
    validateProjectDir(card);

    const adapter = registry.pickAdapter(resolveAgentRuntime(card));
    const prompt = buildDispatchPromptText(card, (screenshot) => options.store.getScreenshotPath(screenshot.filename));
    const cwd = card.projectDir ?? options.cwd ?? process.cwd();
    await captureGitStart(options.store, card.id, cwd); // best-effort, never throws
    const handle = await adapter.start({
      card,
      prompt,
      cwd,
      resumeSessionId: await resolveResumeSessionId(options.store, card),
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

  const availability: RuntimeAvailability[] = [
    {
      runtime: 'opencode',
      available: false,
      unavailableReason: STANDALONE_OPENCODE_UNAVAILABLE_REASON,
      hostKind: 'standalone-daemon',
    },
    { runtime: 'codex', available: true, hostKind: 'standalone-daemon' },
    { runtime: 'claude', available: true, hostKind: 'standalone-daemon' },
  ];

  return {
    runStore,
    registry,
    watchdog,
    dispatchCard,
    getRuntimeAvailability: () => availability,
    getRuntimeCatalog: () => mergeCodexCliModelsIntoCatalog(
      applyRuntimeAvailability(RUNTIME_CATALOG, availability),
      { commandOverride: options.codexCommandOverride },
    ),
  };
}

export function applyRuntimeAvailability(
  catalog: readonly RuntimeCatalogEntry[],
  availability: readonly RuntimeAvailability[],
): RuntimeCatalogEntry[] {
  const byRuntime = new Map(availability.map((entry) => [entry.runtime, entry]));
  return catalog.map((entry) => {
    const runtimeAvailability = byRuntime.get(entry.runtime);
    if (!runtimeAvailability) return { ...entry };
    return {
      ...entry,
      available: runtimeAvailability.available,
      unavailableReason: runtimeAvailability.unavailableReason,
      hostKind: runtimeAvailability.hostKind,
      disabled: entry.disabled || runtimeAvailability.available === false,
    };
  });
}

function validateProjectDir(card: KanbanCard): void {
  if (!card.projectDir) return;
  if (!existsSync(card.projectDir)) {
    throw new RuntimeDispatchError(`Project directory does not exist: ${card.projectDir}`, 400);
  }
  const stat = statSync(card.projectDir);
  if (!stat.isDirectory()) {
    throw new RuntimeDispatchError(`Project path is not a directory: ${card.projectDir}`, 400);
  }
}

async function resolveQueueReusedSession(
  store: KanbanStore,
  card: KanbanCard,
): Promise<string | undefined> {
  if (card.queueSessionMode !== 'continue_queued_after_session') return undefined;
  if (!card.queuedAfterCardId) return undefined;

  const predecessor = await store.getCard(card.queuedAfterCardId);
  if (!predecessor?.sessionId) return undefined;
  if (predecessor.status === 'in_progress') return undefined;
  return predecessor.sessionId;
}

async function resolveResumeSessionId(store: KanbanStore, card: KanbanCard): Promise<string | undefined> {
  if (card.feedbackForCardId) {
    const originalCard = await store.getCard(card.feedbackForCardId);
    if (originalCard?.sessionId) return originalCard.sessionId;
  }

  if (card.resumeSessionId) return card.resumeSessionId;

  const queueSessionId = await resolveQueueReusedSession(store, card);
  if (queueSessionId) return queueSessionId;

  if (card.sessionId && isRecentlyFailed(card)) return card.sessionId;

  return undefined;
}
