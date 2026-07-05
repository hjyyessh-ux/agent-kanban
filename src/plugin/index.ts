import type { Plugin } from '@opencode-ai/plugin';
import { KanbanStore } from '../core/store';
import { createKanbanTools } from './tools/index';
import { createSchedulerTools, createSettingsTools } from './tools/index';
import { createEventHooks } from './hooks/index';
import type { ModelsFn, ModelInfo } from '../server/routes';
import { getKanbanDataDir } from './config';
import { StaleCardChecker } from './stale-checker';
import { QuestionMonitor } from './question-monitor';
import { existsSync, statSync } from 'node:fs';
import { trackDispatch } from './hooks/dispatch-tracker';
import type { FollowUpFn } from './telegram-poller';
import { getPrimaryAgentDispatchLabel } from '../core/agent-config';
import { getBuiltinCommandDefinition, normalizeBuiltinCommandId } from '../core/commands';
import type { DispatchResult, KanbanCard } from '../core/types';
import { resolveAgentRuntime } from '../core/runtime-config';
import type { NativeSessionInfo } from './peer-session-coordinator';
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
import { createKanbanApp } from './bootstrap';

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

  const listNativeSessions = async (): Promise<NativeSessionInfo[]> => {
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
  };

  let questionMonitor: QuestionMonitor | undefined;

  const app = await createKanbanApp({
    dataDir: kanbanDataDir,
    opencodeInput: input,
    debugLabel: 'runtime',
    listNativeSessions,
    modelsFn,
    createQuestionMonitor: (stores, isRuntimeOwner) => {
      // Watches the opencode SSE stream for pending questions
      questionMonitor = new QuestionMonitor(input, stores.store, {
        enableRecommendedAutoReply: isRuntimeOwner,
      });
      return questionMonitor;
    },
    onRuntimeOwnerChange: (owner) => {
      questionMonitor?.setRecommendedAutoReplyEnabled(owner);
    },
    // followUpFn sends a prompt to an existing opencode session
    createFollowUpFn: ({ store }): FollowUpFn => async (sessionId, text, options) => {
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
    },
    createDispatch: async ({ store, settingsStore }) => {
      const runtimeRunStore = new RuntimeRunStore(kanbanDataDir);
      const childLinker = new ChildLinker(store);
      await runtimeRunStore.reconcileStale(store, childLinker);
      const claudeCodexWatchdog = new ClaudeCodexWatchdog(store, runtimeRunStore);
      const staleChecker = new StaleCardChecker(store, input);

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

      return {
        dispatchCard,
        runStore: runtimeRunStore,
        singletonServices: [staleChecker, claudeCodexWatchdog],
      };
    },
  });

  const kanbanTools = createKanbanTools(app.store, input);
  const schedulerTools = createSchedulerTools(app.schedulerStore, app.schedulerEngine, input);
  const settingsTools = createSettingsTools(app.settingsStore, input);
  const eventHooks = createEventHooks(
    app.store,
    input,
    app.dispatchCard,
    app.settingsStore,
  );

  if (app.port) {
    try {
      input.client?.tui?.showToast({
        body: { message: `Kanban board available at http://localhost:${app.port}`, variant: 'info' },
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
    app.peerSessionCoordinator.markDraining();
    app.unsubscribeRuntimeLock();
    app.stopSingleton();
    app.schedulerEngine.stop();
    app.questionMonitor?.stop();
    app.runtimeLock.release();
    app.monitor.stop();
    app.peerSessionCoordinator.unregister();
  });

  return {
    tool: { ...kanbanTools, ...schedulerTools, ...settingsTools },
    ...eventHooks,
  };
};

export default plugin;
