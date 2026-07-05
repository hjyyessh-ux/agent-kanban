import { describe, test, expect, mock } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { TelegramStateStore } from '../core/telegram-state-store';
import { TelegramPoller, type FollowUpFn } from '../plugin/telegram-poller';
import { createEventHooks } from '../plugin/hooks/index';
import { markSessionActive, resetObservedActiveSessions } from '../plugin/hooks/session-activity-registry';
import { withTempDir } from './setup';
import type { PluginInput } from '@opencode-ai/plugin';
import type { Part, UserMessage } from '@opencode-ai/sdk';

function createMockInput(
  sessionMessages?: Record<string, Array<{ info: { role: string }; parts: Part[] }>>,
  directory = '/tmp/test-project',
): PluginInput {
  return {
    client: {
      session: {
        messages: async ({ path }: { path: { id: string } }) => ({
          data: sessionMessages?.[path.id] ?? [],
        }),
      },
    },
    project: {},
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:4000'),
    $: {},
  } as unknown as PluginInput;
}

function createUserMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg-1',
    sessionID: 'session-parent',
    role: 'user',
    time: { created: Date.now() },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
    ...overrides,
  };
}

function createTextPart(text: string, sessionID = 'session-parent', messageID = 'msg-1'): Part {
  return {
    id: `part-${messageID}`,
    sessionID,
    messageID,
    type: 'text',
    text,
  };
}

async function seedTelegramSettings(settingsStore: SettingsStore): Promise<void> {
  await settingsStore.createEntry({
    key: 'TELEGRAM_BOT_TOKEN',
    value: 'test-bot-token',
    description: 'Bot token',
    category: 'telegram',
    masked: true,
  });
}

function makeUpdate(updateId: number, text: string, chatId = 12345) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' as const },
      date: Math.floor(Date.now() / 1000),
      text,
      from: { id: 1, first_name: 'Test', last_name: 'User' },
    },
  };
}

describe('workflow regression', () => {
  test('child linkage blocks parent idle completion, while Telegram follow-up stays on the same selected session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const telegramStateStore = new TelegramStateStore(dir);
      await seedTelegramSettings(settingsStore);

      const hookInput = createMockInput({
        'ses-parent-main': [
          {
            info: { role: 'assistant' },
            parts: [createTextPart('Parent session completed.', 'ses-parent-main', 'assistant-msg')],
          },
        ],
      });

      const hooks = createEventHooks(store, hookInput, undefined, settingsStore);

      const parentMessage = createUserMessage({
        id: 'msg-parent-main',
        sessionID: 'ses-parent-main',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'ses-parent-main',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
          messageID: 'msg-parent-main',
        },
        { message: parentMessage, parts: [createTextPart('Investigate root issue', 'ses-parent-main', 'msg-parent-main')] },
      );

      const parentCard = (await store.getCards()).find(card => card.sessionId === 'ses-parent-main');
      expect(parentCard).toBeDefined();
      await store.deleteCard(parentCard!.id);
      const telegramParent = await store.createCard({
        title: parentCard!.title,
        description: parentCard!.description,
        sessionId: 'ses-parent-main',
        projectDir: '/tmp/test-project',
        model: 'anthropic/claude-sonnet-4-20250514',
        telegramChatId: 12345,
      });
      await store.updateCard(telegramParent.id, { status: 'in_progress' });

      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'ses-child-agent',
              projectID: 'project-1',
              directory: '/tmp/test-project',
              parentID: 'ses-parent-main',
              title: 'Explore child',
              version: '1.0.0',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      });

      const childMessage = createUserMessage({
        id: 'msg-child-1',
        sessionID: 'ses-child-agent',
      });
      await hooks['chat.message']!(
        {
          sessionID: 'ses-child-agent',
          agent: 'explore',
          messageID: 'msg-child-1',
        },
        { message: childMessage, parts: [createTextPart('Inspect child flow', 'ses-child-agent', 'msg-child-1')] },
      );

      const childCard = (await store.getCards()).find(card => card.sessionId === 'ses-child-agent');
      expect(childCard).toBeDefined();
      expect(childCard?.parentCardId).toBe(telegramParent.id);
      expect(childCard?.title).toBe('Explore#1');

      await telegramStateStore.upsertChatState(12345, {
        selectedSessionId: 'ses-parent-main',
        selectedCardId: telegramParent.id,
        mode: 'pinned',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch;

      markSessionActive('ses-parent-main');
      await hooks.event!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'ses-parent-main' },
        },
      });

      const blockedParent = await store.getCard(telegramParent.id);
      expect(blockedParent?.status).toBe('in_progress');

      const dispatchFn = mock(async () => ({ sessionId: 'ses-new-dispatch' }));
      const followUpFn: FollowUpFn = mock(async () => {});

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(5000, 'Keep going on same session', 12345)],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await (poller as unknown as { poll: () => Promise<void> }).poll();
      } finally {
        globalThis.fetch = originalFetch;
        resetObservedActiveSessions();
      }

      expect(dispatchFn).not.toHaveBeenCalled();
      expect(followUpFn).toHaveBeenCalledTimes(1);
      expect(followUpFn).toHaveBeenCalledWith('ses-parent-main', 'Keep going on same session', {
        agentType: undefined,
        model: 'anthropic/claude-sonnet-4-20250514',
      });

      const followUpCard = (await store.getCards()).find(card => card.description === 'Keep going on same session');
      expect(followUpCard).toBeDefined();
      expect(followUpCard?.sessionId).toBe('ses-parent-main');
    });
  });
});
