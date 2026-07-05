import { describe, test, expect, mock, afterEach } from 'bun:test';
import { TelegramPoller, type FollowUpFn } from '../plugin/telegram-poller';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { TelegramStateStore } from '../core/telegram-state-store';
import { buildTelegramHelpText, getTelegramRegisteredCommands, resolveTelegramCommand } from '../plugin/telegram-commands';
import { DEFAULT_CLAUDE_MODEL } from '../core/runtime-config';
import { withTempDir } from './setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bot-token';

function makeUpdate(updateId: number, text: string, chatId = 12345, from?: { first_name: string; last_name?: string }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' as const },
      date: Math.floor(Date.now() / 1000),
      text,
      from: from ?? { id: 1, first_name: 'Test', last_name: 'User' },
    },
  };
}

async function seedTelegramSettings(settingsStore: SettingsStore, token = TEST_TOKEN, channelIds?: string) {
  await settingsStore.createEntry({
    key: 'TELEGRAM_BOT_TOKEN',
    value: token,
    description: 'Bot token',
    category: 'telegram',
    masked: true,
  });
  if (channelIds) {
    await settingsStore.createEntry({
      key: 'TELEGRAM_CHANNEL_IDS',
      value: channelIds,
      description: 'Channel IDs',
      category: 'telegram',
      masked: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramPoller', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function createPoller(
    dir: string,
    store: KanbanStore,
    settingsStore: SettingsStore,
    dispatchFn: (cardId: string) => Promise<{ sessionId: string }>,
    followUpFn?: FollowUpFn,
  ) {
    const telegramStateStore = new TelegramStateStore(dir);
    return new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
  }

  async function runPoll(poller: TelegramPoller): Promise<void> {
    await (poller as unknown as { poll: () => Promise<void> }).poll();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  test('start and stop without errors', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      const poller = createPoller(dir, store, settingsStore, dispatchFn);

      // Should not throw
      await poller.start();
      poller.stop();
    });
  });

  test('start is idempotent', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      const poller = createPoller(dir, store, settingsStore, dispatchFn);

      await poller.start();
      await poller.start(); // Second call should be no-op
      poller.stop();
    });
  });

  test('start registers Telegram commands and menu button once when token exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        calls.push({
          url: urlStr,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await poller.start();
      await poller.start();
      poller.stop();

      const commandCalls = calls.filter(call => call.url.includes('/setMyCommands'));
      const menuCalls = calls.filter(call => call.url.includes('/setChatMenuButton'));
      expect(commandCalls).toHaveLength(1);
      expect(menuCalls).toHaveLength(1);
      expect(commandCalls[0].body).toEqual({
        commands: getTelegramRegisteredCommands(),
        scope: { type: 'all_private_chats' },
        language_code: 'ko',
      });
      expect(menuCalls[0].body).toEqual({
        menu_button: { type: 'commands' },
      });
    });
  });

  test('start skips Telegram command registration when token is missing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      const calls: string[] = [];
      globalThis.fetch = mock(async (url: RequestInfo) => {
        calls.push(url instanceof URL ? url.toString() : url as string);
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await poller.start();
      poller.stop();

      expect(calls).toEqual([]);
    });
  });

  test('start stays non-fatal when Telegram command registration fails', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/setMyCommands')) {
          return new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await expect(poller.start()).resolves.toBeUndefined();
      poller.stop();
    });
  });

  test('stop is safe to call before start', () => {
    const store = {} as KanbanStore;
    const settingsStore = {} as SettingsStore;
    const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

    const poller = new TelegramPoller(store, settingsStore, dispatchFn);
    expect(() => poller.stop()).not.toThrow();
  });

  test('stop is safe to call multiple times', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await poller.start();
      poller.stop();
      expect(() => poller.stop()).not.toThrow();
    });
  });

  // ── poll() — no token ──────────────────────────────────────────────────

  test('poll does nothing when no TELEGRAM_BOT_TOKEN is configured', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      // No token seeded
      const poller = createPoller(dir, store, settingsStore, dispatchFn);

      // Invoke poll directly
      await (poller as any).poll();

      // dispatch should never be called
      expect(dispatchFn).not.toHaveBeenCalled();
    });
  });

  // ── poll() — creates cards from messages ───────────────────────────────

  test('poll creates a card from a Telegram message and dispatches it', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-dispatched' }));

      // Mock fetch: getUpdates returns 1 message, sendMessage succeeds
      let fetchCallCount = 0;
      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        fetchCallCount++;

        if (urlStr.includes('/setMyCommands') || urlStr.includes('/setChatMenuButton')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(100, 'Build a REST API')],
          }), { status: 200 });
        }

        // sendMessage calls
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: fetchCallCount },
        }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await (poller as any).poll();

      // Card should be created
      const board = await store.load();
      const cards = board.cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe('Build a REST API');
      expect(cards[0].description).toBe('Build a REST API');
      expect(cards[0].dispatchType).toBe('instant');
      expect(cards[0].telegramChatId).toBe(12345);
      expect(cards[0].sourceContext).toContain('Telegram message from Test User');

      // Dispatch should have been called
      expect(dispatchFn).toHaveBeenCalledTimes(1);
      expect(dispatchFn).toHaveBeenCalledWith(cards[0].id);

      // sendMessage should have been called once (combined notification)
      const sendCalls = (globalThis.fetch as any).mock.calls.filter(
        (call: any[]) => {
          const u = call[0] instanceof URL ? call[0].toString() : call[0] as string;
          return u.includes('/sendMessage');
        },
      );
      expect(sendCalls.length).toBe(1);
    });
  });

  test('poll truncates long message titles to 80 chars', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const longText = 'A'.repeat(100);
      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/setMyCommands') || urlStr.includes('/setChatMenuButton')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(101, longText)],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await (poller as any).poll();

      const board = await store.load();
      expect(board.cards[0].title).toBe('A'.repeat(77) + '...');
      expect(board.cards[0].description).toBe(longText);
    });
  });

  // ── poll() — channel filtering ─────────────────────────────────────────

  test('poll filters messages by TELEGRAM_CHANNEL_IDS when set', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore, TEST_TOKEN, '99999');

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/setMyCommands') || urlStr.includes('/setChatMenuButton')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [
              makeUpdate(200, 'Allowed message', 99999),
              makeUpdate(201, 'Blocked message', 12345),
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await (poller as any).poll();

      const board = await store.load();
      expect(board.cards).toHaveLength(1);
      expect(board.cards[0].title).toBe('Allowed message');
      expect(board.cards[0].telegramChatId).toBe(99999);
    });
  });

  test('poll processes all messages when TELEGRAM_CHANNEL_IDS is not set', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore); // No channel IDs

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/setMyCommands') || urlStr.includes('/setChatMenuButton')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [
              makeUpdate(300, 'Message A', 11111),
              makeUpdate(301, 'Message B', 22222),
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await (poller as any).poll();

      const board = await store.load();
      expect(board.cards).toHaveLength(2);
    });
  });

  // ── poll() — skips non-text messages ───────────────────────────────────

  test('poll skips updates without text', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/setMyCommands') || urlStr.includes('/setChatMenuButton')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [
              { update_id: 400, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: 1 } },
              { update_id: 401 }, // No message at all
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn);
      await (poller as any).poll();

      const board = await store.load();
      expect(board.cards).toHaveLength(0);
      expect(dispatchFn).not.toHaveBeenCalled();
    });
  });

  test('help text stays aligned with registered Telegram commands', () => {
    const helpText = buildTelegramHelpText();

    for (const command of getTelegramRegisteredCommands()) {
      expect(helpText).toContain(`/${command.command}`);
    }
  });

  test('resolveTelegramCommand accepts bot mention suffix for registered commands', () => {
    const result = resolveTelegramCommand('/help@test_bot', {
      chatId: 12345,
      sessions: [],
    }, false);

    expect(result).toEqual({
      type: 'reply',
      text: buildTelegramHelpText(),
    });
  });

  test('model list commands show available Claude and Codex model ids', () => {
    const claudeResult = resolveTelegramCommand('/claude_model_list', {
      chatId: 12345,
      sessions: [],
    }, false);
    const codexResult = resolveTelegramCommand('/codex_model_list', {
      chatId: 12345,
      sessions: [],
    }, false);

    expect(claudeResult?.type).toBe('reply');
    expect(claudeResult && 'text' in claudeResult ? claudeResult.text : '').toContain('claude-fable-5');
    expect(claudeResult && 'text' in claudeResult ? claudeResult.text : '').toContain('claude-opus-4-8');
    expect(codexResult?.type).toBe('reply');
    expect(codexResult && 'text' in codexResult ? codexResult.text : '').toContain('gpt-5.5');
    expect(codexResult && 'text' in codexResult ? codexResult.text : '').toContain('gpt-5.3-codex');
  });

  test('model commands reject unknown ids instead of saving fallback-prone defaults', () => {
    const claudeResult = resolveTelegramCommand('/claude_model opus4.8', {
      chatId: 12345,
      sessions: [],
    }, false);
    const codexResult = resolveTelegramCommand('/codex_model gpt-6', {
      chatId: 12345,
      sessions: [],
    }, false);

    expect(claudeResult?.type).toBe('reply');
    expect(claudeResult && 'text' in claudeResult ? claudeResult.text : '').toContain('지원하지 않는 Claude 모델');
    expect(claudeResult && 'text' in claudeResult ? claudeResult.text : '').toContain('claude-opus-4-8');
    expect(codexResult?.type).toBe('reply');
    expect(codexResult && 'text' in codexResult ? codexResult.text : '').toContain('지원하지 않는 Codex 모델');
    expect(codexResult && 'text' in codexResult ? codexResult.text : '').toContain('gpt-5.5');
  });

  test('model commands accept exact model ids and hyphen aliases', () => {
    const claudeResult = resolveTelegramCommand('/claude-model claude-opus-4-8', {
      chatId: 12345,
      sessions: [],
    }, false);
    const codexResult = resolveTelegramCommand('/codex-model gpt-5.5', {
      chatId: 12345,
      sessions: [],
    }, false);

    expect(claudeResult?.type).toBe('set-defaults');
    expect(claudeResult && 'model' in claudeResult ? claudeResult.model : undefined).toBe('claude-opus-4-8');
    expect(claudeResult && 'agentRuntime' in claudeResult ? claudeResult.agentRuntime : undefined).toBe('claude');
    expect(codexResult?.type).toBe('set-defaults');
    expect(codexResult && 'model' in codexResult ? codexResult.model : undefined).toBe('gpt-5.5');
    expect(codexResult && 'agentRuntime' in codexResult ? codexResult.agentRuntime : undefined).toBe('codex');
  });

  // ── poll() — dispatch failure ──────────────────────────────────────────

  test('poll sends warning when dispatch fails', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => {
        throw new Error('No opencode session available');
      });

      const sentMessages: string[] = [];
      globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(500, 'Some task')],
          }), { status: 200 });
        }
        if (urlStr.includes('/sendMessage') && init?.body) {
          const body = JSON.parse(init.body as string);
          sentMessages.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = new TelegramPoller(store, settingsStore, dispatchFn);
      await (poller as any).poll();

      // Card should still be created
      const board = await store.load();
      expect(board.cards).toHaveLength(1);

      // Should have 1 message: failure warning (with card ID)
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('자동 실행에 실패했습니다');
      expect(sentMessages[0]).toContain('No opencode session available');
    });
  });

  // ── poll() — offset tracking ───────────────────────────────────────────

  test('poll tracks offset to avoid reprocessing', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      let getUpdatesCalls = 0;
      const capturedOffsets: (string | null)[] = [];

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          getUpdatesCalls++;
          const u = new URL(urlStr);
          capturedOffsets.push(u.searchParams.get('offset'));

          if (getUpdatesCalls === 1) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(100, 'First message')],
            }), { status: 200 });
          }
          // Second call — empty
          return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = new TelegramPoller(store, settingsStore, dispatchFn);

      // First poll
      await (poller as any).poll();
      // Second poll
      await (poller as any).poll();

      // First call had no offset, second should have offset=101
      expect(capturedOffsets[0]).toBeNull();
      expect(capturedOffsets[1]).toBe('101');
    });
  });

  test('poll does not create a duplicate card when the same Telegram message is replayed after restart', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-replayed' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(777, 'Replay-safe task', 32123)],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const firstPoller = createPoller(dir, store, settingsStore, dispatchFn);
      await runPoll(firstPoller);

      const secondPoller = createPoller(dir, store, settingsStore, dispatchFn);
      await runPoll(secondPoller);

      const board = await store.load();
      expect(board.cards).toHaveLength(1);
      expect(board.cards[0].originChannel).toBe('telegram');
      expect(board.cards[0].telegramMessageId).toBe('777');
      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });
  });

  // ── poll() — overlap guard ─────────────────────────────────────────────

  test('poll guard prevents overlapping polls', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          // Simulate slow response
          await new Promise(resolve => setTimeout(resolve, 50));
          return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = new TelegramPoller(store, settingsStore, dispatchFn);

      // Start two polls simultaneously
      const poll1 = (poller as any).poll();
      const poll2 = (poller as any).poll(); // Should be skipped (polling guard)

      await Promise.all([poll1, poll2]);

      // getUpdates should only be called once (second poll was skipped)
      const getUpdatesCalls = (globalThis.fetch as any).mock.calls.filter(
        (call: any[]) => {
          const u = call[0] instanceof URL ? call[0].toString() : call[0] as string;
          return u.includes('/getUpdates');
        },
      );
      expect(getUpdatesCalls.length).toBe(1);
    });
  });

  // ── poll() — network error resilience ──────────────────────────────────

  test('poll silently handles network errors', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const poller = new TelegramPoller(store, settingsStore, dispatchFn);

      // Should not throw
      expect((poller as any).poll()).resolves.toBeUndefined();

      // No cards created
      const board = await store.load();
      expect(board.cards).toHaveLength(0);
    });
  });

  // ── poll() — sender name formatting ────────────────────────────────────

  test('poll handles sender without last name', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await seedTelegramSettings(settingsStore);

      const dispatchFn = mock(async () => ({ sessionId: 'ses-1' }));

      globalThis.fetch = mock(async (url: RequestInfo) => {
        const urlStr = url instanceof URL ? url.toString() : url as string;
        if (urlStr.includes('/getUpdates')) {
          return new Response(JSON.stringify({
            ok: true,
            result: [makeUpdate(600, 'No last name', 12345, { first_name: 'Alice' })],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const poller = new TelegramPoller(store, settingsStore, dispatchFn);
      await (poller as any).poll();

      const board = await store.load();
      expect(board.cards[0].sourceContext).toContain('Telegram message from Alice');
    });
  });

  // ── Session Persistence ─────────────────────────────────────────────────

  describe('session persistence', () => {
    test('second message from same chat creates new card via followUpFn', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-abc' }));
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        const sentMessages: string[] = [];
        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(700, 'First message', 55555)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(701, 'Follow-up message', 55555)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          // Capture sent messages
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

      const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // First poll: creates card + dispatches
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        // Second poll: should use followUpFn AND create new card
        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledWith('ses-abc', 'Follow-up message', {
          agentType: undefined,
          model: undefined,
        });
        expect(dispatchFn).toHaveBeenCalledTimes(1); // Still 1 — no new dispatch needed

        // 2 cards should exist (original + follow-up)
        const board = await store.load();
        expect(board.cards).toHaveLength(2);

        // New card should have follow-up message as description
        const followUpCard = board.cards.find(c => c.description === 'Follow-up message');
        expect(followUpCard).toBeDefined();
        expect(followUpCard!.status).toBe('in_progress');
        expect(followUpCard!.sessionId).toBe('ses-abc');
        expect(followUpCard!.telegramChatId).toBe(55555);

        // Follow-up Telegram message should show card registered
        const followUpMsg = sentMessages.find(m => m.includes('기존 세션에 전달됨') && m.includes(followUpCard!.id));
        expect(followUpMsg).toBeDefined();
      });
    });

    test('follow-up creates new in_progress card while original remains complete', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-reopen' }));
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(800, 'Initial task', 66666)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(801, 'Continue working', 66666)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates card + dispatches (card stays 'todo' — status change is done by chat.message hook)
        await (poller as any).poll();
        const board1 = await store.load();
        // Manually set to in_progress (simulating what chat.message hook does)
        await store.updateCard(board1.cards[0].id, { status: 'in_progress' });

        // Simulate session.idle completing the card → complete
        await store.updateCard(board1.cards[0].id, { status: 'complete' });
        const board2 = await store.load();
        expect(board2.cards[0].status).toBe('complete');

        // Poll 2: follow-up should create a NEW card (in_progress), original stays complete
        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        const board3 = await store.load();
        expect(board3.cards).toHaveLength(2);

        // Original card remains complete
        const originalCard = board3.cards.find(c => c.description === 'Initial task');
        expect(originalCard!.status).toBe('complete');

        // New follow-up card is in_progress with same sessionId
        const newCard = board3.cards.find(c => c.description === 'Continue working');
        expect(newCard).toBeDefined();
        expect(newCard!.status).toBe('in_progress');
        expect(newCard!.sessionId).toBe('ses-reopen');
      });
    });

    test('follow-up replay does not create a second card for the same Telegram message', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async (cardId: string) => {
          await store.updateCard(cardId, { sessionId: 'ses-followup-replay' });
          return { sessionId: 'ses-followup-replay' };
        });
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount += 1;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(900, 'Initial Telegram task', 45454)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(901, 'Repeated follow-up body', 45454)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const firstPoller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await runPoll(firstPoller);
        const initialCard = (await store.load()).cards.find(card => card.description === 'Initial Telegram task');
        expect(initialCard).toBeDefined();
        await store.updateCard(initialCard!.id, { status: 'in_progress' });

        const secondPoller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await runPoll(secondPoller);

        const thirdPoller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await runPoll(thirdPoller);

        const board = await store.load();
        expect(board.cards.filter(card => card.description === 'Repeated follow-up body')).toHaveLength(1);
        expect(followUpFn).toHaveBeenCalledTimes(1);
      });
    });

    test('plain text 새 세션 is treated as follow-up message instead of reset command', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async (_cardId: string) => ({ sessionId: 'ses-first' }));
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(800, 'Initial task', 66666)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(801, '새 세션', 66666)],
              }), { status: 200 });
            }
            if (pollCount === 3) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(802, 'New task after reset', 66666)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates first card
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledWith('ses-first', '새 세션', {
          agentType: undefined,
          model: undefined,
        });

        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledTimes(2);
        expect(followUpFn).toHaveBeenCalledWith('ses-first', 'New task after reset', {
          agentType: undefined,
          model: undefined,
        });

        const board = await store.load();
        expect(board.cards).toHaveLength(3);
        expect(board.cards.some(card => card.description === '새 세션')).toBe(true);
        expect(board.cards.some(card => card.description === 'New task after reset')).toBe(true);
      });
    });

    test('followUpFn failure keeps selected session and avoids new dispatch', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);
        const telegramStateStore = new TelegramStateStore(dir);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new' }));
        const followUpFn = mock(async () => {
          throw new Error('Session is dead');
        });

        let pollCount = 0;
        const sentMessages: string[] = [];
        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(900, 'First task', 77777)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(901, 'After dead session', 77777)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage')) {
            sentMessages.push(JSON.parse(init?.body as string).text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates card + dispatches
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        // deleteCard soft-deletes the failed follow-up card; only the original
        // dispatched card remains active.
        const activeCards = await store.getCards();
        expect(activeCards).toHaveLength(1);

        const state = await telegramStateStore.getChatState(77777);
        expect(state?.selectedSessionId).toBe('ses-new');
        expect(state?.selectedCardId).toBe(activeCards[0].id);
        expect(sentMessages.some(message => message.includes('현재 세션에 전달하지 못했습니다.'))).toBe(true);
      });
    });

    test('each followUpFn failure keeps the same selected session without creating cards', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);
        const telegramStateStore = new TelegramStateStore(dir);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new' }));
        const followUpFn = mock(async () => {
          throw new Error('Session is dead');
        });

        let pollCount = 0;
        const sentMessages: string[] = [];
        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount >= 1 && pollCount <= 3) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(900 + pollCount, `Message ${pollCount}`, 77777)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage')) {
            sentMessages.push(JSON.parse(init?.body as string).text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates first card
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(2);
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        // Each failed follow-up card is soft-deleted; only the original
        // dispatched card stays active.
        const activeCards = await store.getCards();
        expect(activeCards).toHaveLength(1);

        const state = await telegramStateStore.getChatState(77777);
        expect(state?.selectedSessionId).toBe('ses-new');
        expect(state?.selectedCardId).toBe(activeCards[0].id);
        expect(sentMessages.filter(message => message.includes('현재 세션에 전달하지 못했습니다.'))).toHaveLength(2);
      });
    });

    test('followUpFn success keeps session alive and creates follow-up cards', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-alive' }));
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount >= 1 && pollCount <= 3) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(1300 + pollCount, `Msg ${pollCount}`, 44444)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates card
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        // Poll 2: followUp succeeds — session kept
        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(dispatchFn).toHaveBeenCalledTimes(1); // No new dispatch

        // Poll 3: followUp succeeds again — session still kept
        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(2);
        expect(dispatchFn).toHaveBeenCalledTimes(1); // Still no new dispatch

        // 3 cards: 1 original + 2 follow-ups (each follow-up creates a new card)
        const board = await store.load();
        expect(board.cards).toHaveLength(3);

        // All follow-up cards share the same sessionId
        const followUpCards = board.cards.filter(c => c.status === 'in_progress');
        expect(followUpCards).toHaveLength(2);
        for (const card of followUpCards) {
          expect(card.sessionId).toBe('ses-alive');
        }
      });
    });

    test('getSessionsForChat includes runtime-aware Telegram sessions', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        await store.createCard({
          title: 'Opencode task',
          description: 'Opencode task',
          sessionId: 'ses-opencode-1',
          telegramChatId: 24680,
          agentRuntime: 'opencode',
        });
        await store.createCard({
          title: 'Codex task',
          description: 'Codex task',
          sessionId: 'thread-codex-1',
          telegramChatId: 24680,
          agentRuntime: 'codex',
          model: 'gpt-5.3-codex',
        });
        await store.createCard({
          title: 'Claude task',
          description: 'Claude task',
          sessionId: 'claude-session-1',
          telegramChatId: 24680,
          agentRuntime: 'claude',
          model: 'claude-sonnet-4-6',
        });

        const poller = new TelegramPoller(store, settingsStore, async () => ({ sessionId: 'unused' }), async () => {});
        const sessions = await poller.getSessionsForChat(24680);

        expect(new Set(sessions.map(session => session.sessionId))).toEqual(new Set([
          'claude-session-1',
          'thread-codex-1',
          'ses-opencode-1',
        ]));
        expect(new Set(sessions.map(session => session.agentRuntime))).toEqual(new Set(['claude', 'codex', 'opencode']));
      });
    });

    test('invalid selected session replies with failure and does not create a hidden new session', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(24682, {
          selectedSessionId: 'missing-claude-session',
          selectedCardId: 'missing-card',
          selectedAgentRuntime: 'claude',
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'should-not-create' }));
        const followUpFn = mock(async () => {});
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(4302, 'Should not create new session', 24682)],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            sentMessages.push(JSON.parse(init.body as string).text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).not.toHaveBeenCalled();
        expect(await store.getCards()).toHaveLength(0);
        expect(sentMessages[0]).toContain('선택된 세션을 찾지 못해');
        expect(sentMessages[0]).toContain('새 세션을 몰래 만들지 않았습니다');

        const state = await telegramStateStore.getChatState(24682);
        expect(state?.selectedSessionId).toBe('missing-claude-session');
        expect(state?.selectedAgentRuntime).toBe('claude');
      });
    });

    test('clearSessionBySessionId clears the correct chat mapping', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-to-clear' }));
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(1000, 'Task to clear', 88888)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              // After session cleared, should create new card
              dispatchFn.mockImplementation(async () => ({ sessionId: 'ses-new-after-clear' }));
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(1001, 'After clear', 88888)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: creates card with ses-to-clear
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        // Simulate session.idle: clear the session
        poller.clearSessionBySessionId('ses-to-clear');

        // Poll 2: should create NEW card (mapping was cleared)
        await (poller as any).poll();
        expect(followUpFn).not.toHaveBeenCalled();
        expect(dispatchFn).toHaveBeenCalledTimes(2);

        const board = await store.load();
        expect(board.cards).toHaveLength(2);
      });
    });

    test('without followUpFn, always creates new cards', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        let dispatchCount = 0;
        const dispatchFn = mock(async () => {
          dispatchCount++;
          return { sessionId: `ses-${dispatchCount}` };
        });

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(1100, 'Message 1', 99999)],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(1101, 'Message 2', 99999)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        // No followUpFn passed — 3-arg constructor
        const poller = createPoller(dir, store, settingsStore, dispatchFn);

        await (poller as any).poll();
        await (poller as any).poll();

        // Should have created 2 cards, dispatched 2 times
        expect(dispatchFn).toHaveBeenCalledTimes(2);
        const board = await store.load();
        expect(board.cards).toHaveLength(2);
      });
    });

    test('different chats maintain independent sessions', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        let dispatchCount = 0;
        const dispatchFn = mock(async () => {
          dispatchCount++;
          return { sessionId: `ses-chat-${dispatchCount}` };
        });
        const followUpFn = mock(async () => {});

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              // Two messages from different chats
              return new Response(JSON.stringify({
                ok: true,
                result: [
                  makeUpdate(1200, 'Chat A first', 11111),
                  makeUpdate(1201, 'Chat B first', 22222),
                ],
              }), { status: 200 });
            }
            if (pollCount === 2) {
              // Follow-ups for both chats
              return new Response(JSON.stringify({
                ok: true,
                result: [
                  makeUpdate(1202, 'Chat A follow-up', 11111),
                  makeUpdate(1203, 'Chat B follow-up', 22222),
                ],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);

        // Poll 1: two new cards from different chats
        await (poller as any).poll();
        expect(dispatchFn).toHaveBeenCalledTimes(2);

        // Poll 2: follow-ups for both chats
        await (poller as any).poll();
        expect(followUpFn).toHaveBeenCalledTimes(2);
        expect(followUpFn).toHaveBeenCalledWith('ses-chat-1', 'Chat A follow-up', {
          agentType: undefined,
          model: undefined,
        });
        expect(followUpFn).toHaveBeenCalledWith('ses-chat-2', 'Chat B follow-up', {
          agentType: undefined,
          model: undefined,
        });

        // 4 cards: 2 original + 2 follow-ups (each follow-up creates a new card)
        const board = await store.load();
        expect(board.cards).toHaveLength(4);
      });
    });

    test('plain text reset phrases are treated as normal follow-up messages', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-t' }));
        const followUpFn = mock(async () => {});

        const triggers = ['새 세션', '새로운 세션', '새세션', 'new session', '세션 초기화', '세션 리셋', 'reset session'];
        let updateId = 2000;

        for (const [index, trigger] of triggers.entries()) {
          let pollCount = 0;
          const chatId = 33333 + index;
          globalThis.fetch = mock(async (url: RequestInfo) => {
            const urlStr = url instanceof URL ? url.toString() : url as string;
            if (urlStr.includes('/getUpdates')) {
              pollCount++;
              if (pollCount === 1) {
                return new Response(JSON.stringify({
                  ok: true,
                  result: [makeUpdate(updateId++, 'task before trigger', chatId)],
                }), { status: 200 });
              }
              if (pollCount === 2) {
                return new Response(JSON.stringify({
                  ok: true,
                  result: [makeUpdate(updateId++, trigger, chatId)],
                }), { status: 200 });
              }
              return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
          }) as unknown as typeof fetch;

          const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
          await (poller as any).poll(); // Creates card
          await (poller as any).poll();
        }

        expect(followUpFn).toHaveBeenCalledTimes(triggers.length);
        for (const trigger of triggers) {
          expect(followUpFn).toHaveBeenCalledWith('ses-t', trigger, {
            agentType: undefined,
            model: undefined,
          });
        }
      });
    });

    test('plain text reset phrase without active session creates a normal new card', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-plain-new-task' }));
        const followUpFn = mock(async () => {});

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(2500, 'new session', 45454)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await runPoll(poller);

        expect(followUpFn).not.toHaveBeenCalled();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].description).toBe('new session');
        expect(board.cards[0].telegramChatId).toBe(45454);
      });
    });

    test('slash sessions command replies without creating cards', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        await store.createCard({
          title: 'Existing task',
          description: 'Existing task',
          sessionId: 'ses-existing',
          sessionTitle: 'Existing session',
          telegramChatId: 12345,
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new' }));
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3000, '/세션목록', 12345)],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn);
        await (poller as any).poll();

        expect(dispatchFn).not.toHaveBeenCalled();
        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(sentMessages[0]).toContain('세션 목록');
        expect(sentMessages[0]).toContain('런타임: Opencode');
      });
    });

    test('switch session command pins selected session for follow-up', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const card = await store.createCard({
          title: 'Pinned task',
          description: 'Pinned task',
          sessionId: 'ses-pinned',
          sessionTitle: 'Pinned Session',
          telegramChatId: 12345,
        });
        await store.updateCard(card.id, { status: 'in_progress' });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new' }));
        const followUpFn = mock(async () => {});
        let pollCount = 0;

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(3100, '/세션변경 1', 12345)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3101, 'Follow pinned session', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await (poller as any).poll();
        await (poller as any).poll();

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).toHaveBeenCalledWith('ses-pinned', 'Follow pinned session', {
          agentType: undefined,
          model: undefined,
        });
      });
    });

    test('single poll sequentially consumes switch command and follow-up from same batch', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const pinnedCard = await store.createCard({
          title: 'Pinned batch task',
          description: 'Pinned batch task',
          sessionId: 'ses-batch-pinned',
          sessionTitle: 'Pinned Batch Session',
          telegramChatId: 12345,
        });
        await store.updateCard(pinnedCard.id, { status: 'in_progress' });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-unused' }));
        const followUpFn = mock(async () => {});
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [
                makeUpdate(3400, '/세션변경 1', 12345),
                makeUpdate(3401, 'Pinned follow-up from same batch', 12345),
              ],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn, followUpFn);
        await runPoll(poller);

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledWith('ses-batch-pinned', 'Pinned follow-up from same batch', {
          agentType: undefined,
          model: undefined,
        });
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[0]).toContain('세션으로 전환했습니다');
        expect(sentMessages[1]).toContain('기존 세션에 전달됨');

        const board = await store.load();
        expect(board.cards).toHaveLength(2);
        const followUpCard = board.cards.find(card => card.description === 'Pinned follow-up from same batch');
        expect(followUpCard).toBeDefined();
        expect(followUpCard?.sessionId).toBe('ses-batch-pinned');
        expect(followUpCard?.status).toBe('in_progress');
      });
    });

    test('single poll sequentially consumes new session command and next task from same batch', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Existing pinned task',
          description: 'Existing pinned task',
          sessionId: 'ses-old',
          sessionTitle: 'Old Session',
          telegramChatId: 12345,
        });
        await store.updateCard(existingCard.id, { status: 'in_progress' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-old',
          selectedCardId: existingCard.id,
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new-batch' }));
        const followUpFn = mock(async () => {});
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [
                makeUpdate(3500, '/새세션', 12345),
                makeUpdate(3501, 'Fresh task after command', 12345),
              ],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(followUpFn).not.toHaveBeenCalled();
        expect(dispatchFn).toHaveBeenCalledTimes(1);
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[0]).toContain('다음 메시지부터 새 세션으로 시작합니다');
        expect(sentMessages[1]).toContain('카드 등록 및 작업 시작');

        const board = await store.load();
        expect(board.cards).toHaveLength(2);
        const newCard = board.cards.find(card => card.description === 'Fresh task after command');
        expect(newCard).toBeDefined();
        expect(newCard?.telegramChatId).toBe(12345);

        const state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBe('ses-new-batch');
        expect(state?.selectedCardId).toBe(newCard?.id);
        expect(state?.mode).toBe('auto');
      });
    });

    test('single poll sequentially consumes canonical /new_session command and next task from same batch', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Existing canonical pinned task',
          description: 'Existing canonical pinned task',
          sessionId: 'ses-old-canonical',
          sessionTitle: 'Old Canonical Session',
          telegramChatId: 12345,
        });
        await store.updateCard(existingCard.id, { status: 'in_progress' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-old-canonical',
          selectedCardId: existingCard.id,
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-new-canonical' }));
        const followUpFn = mock(async () => {});
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [
                makeUpdate(3550, '/new_session', 12345),
                makeUpdate(3551, 'Fresh task after canonical command', 12345),
              ],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(followUpFn).not.toHaveBeenCalled();
        expect(dispatchFn).toHaveBeenCalledTimes(1);
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[0]).toContain('다음 메시지부터 새 세션으로 시작합니다');
        expect(sentMessages[1]).toContain('카드 등록 및 작업 시작');

        const board = await store.load();
        expect(board.cards).toHaveLength(2);
        const newCard = board.cards.find(card => card.description === 'Fresh task after canonical command');
        expect(newCard).toBeDefined();
        expect(newCard?.telegramChatId).toBe(12345);

        const state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBe('ses-new-canonical');
        expect(state?.selectedCardId).toBe(newCard?.id);
        expect(state?.mode).toBe('auto');
      });
    });

    test('restores persisted pinned session and consumes plain message as follow-up without in-memory state', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Persisted task',
          description: 'Persisted task',
          sessionId: 'ses-persisted',
          sessionTitle: 'Persisted Session',
          telegramChatId: 12345,
          model: 'github-copilot/claude-opus-4.6',
          agentType: 'hephaestus',
        });
        await store.updateCard(existingCard.id, { status: 'in_progress' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-persisted',
          selectedCardId: existingCard.id,
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-should-not-dispatch' }));
        const followUpFn = mock(async () => {});

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3600, 'Persisted follow-up message', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledWith('ses-persisted', 'Persisted follow-up message', {
          agentType: 'hephaestus',
          model: 'github-copilot/claude-opus-4.6',
        });

        const board = await store.load();
        const followUpCard = board.cards.find(card => card.description === 'Persisted follow-up message');
        expect(followUpCard).toBeDefined();
        expect(followUpCard?.sessionId).toBe('ses-persisted');

        const updatedState = await telegramStateStore.getChatState(12345);
        expect(updatedState?.selectedSessionId).toBe('ses-persisted');
        expect(updatedState?.selectedCardId).toBe(followUpCard?.id);
        expect(updatedState?.mode).toBe('pinned');
        expect(updatedState?.lastAcknowledgedAt).toBeTruthy();
      });
    });

    test('follow-up passes Hephaestus agent and model into followUpFn when session metadata has them', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Hephaestus task',
          description: 'Hephaestus task',
          sessionId: 'ses-heph-follow',
          sessionTitle: 'Hephaestus Session',
          telegramChatId: 54321,
          model: 'github-copilot/gpt-5.4',
          agentType: 'hephaestus',
        });
        await store.updateCard(existingCard.id, { status: 'complete' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(54321, {
          selectedSessionId: 'ses-heph-follow',
          selectedCardId: existingCard.id,
          mode: 'auto',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-unused' }));
        const followUpFn = mock(async () => {});

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(4050, '계속 진행해줘', 54321)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).toHaveBeenCalledWith('ses-heph-follow', '계속 진행해줘', {
          agentType: 'hephaestus',
          model: 'github-copilot/gpt-5.4',
        });
      });
    });

    test('trailing agent command overrides persisted pinned session and forces new dispatch', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Pinned old task',
          description: 'Pinned old task',
          sessionId: 'ses-old-pinned',
          sessionTitle: 'Old Pinned Session',
          telegramChatId: 12345,
        });
        await store.updateCard(existingCard.id, { status: 'in_progress' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-old-pinned',
          selectedCardId: existingCard.id,
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-hephaestus-new' }));
        const followUpFn = mock(async () => {});

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3700, '새 작업 시작 /헤파이스토', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(followUpFn).not.toHaveBeenCalled();
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        const board = await store.load();
        const newCard = board.cards.find(card => card.description === '새 작업 시작');
        expect(newCard).toBeDefined();
        expect(newCard?.agentType).toBe('hephaestus');
        expect(newCard?.model).toBe('github-copilot/gpt-5.4');

        const updatedState = await telegramStateStore.getChatState(12345);
        expect(updatedState?.selectedSessionId).toBe('ses-hephaestus-new');
        expect(updatedState?.selectedCardId).toBe(newCard?.id);
        expect(updatedState?.defaultAgentType).toBe('hephaestus');
        expect(updatedState?.defaultModel).toBe('github-copilot/gpt-5.4');
      });
    });

    test('trailing agent command creates card with default agent model', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-hephaestus' }));

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3200, '로그인 버그 수정해줘 /헤파이스토', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn);
        await (poller as any).poll();

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].description).toBe('로그인 버그 수정해줘');
        expect(board.cards[0].agentType).toBe('hephaestus');
        expect(board.cards[0].model).toBe('github-copilot/gpt-5.4');
      });
    });

    test('agent-only command sets sticky default used by later plain message', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-sticky-default' }));
        const sentMessages: string[] = [];
        let pollCount = 0;

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(3250, '/헤파이토스', 12345)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3251, '기본 에이전트로 실행해줘', 12345)],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn);
        await runPoll(poller);
        await runPoll(poller);

        expect(dispatchFn).toHaveBeenCalledTimes(1);
        expect(sentMessages[0]).toContain('기본 에이전트를 Hephaestus로 설정했습니다');

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].description).toBe('기본 에이전트로 실행해줘');
        expect(board.cards[0].agentType).toBe('hephaestus');
        expect(board.cards[0].model).toBe('github-copilot/gpt-5.4');
      });
    });

    test('runtime command sets Codex as sticky default for later plain messages', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);
        const telegramStateStore = new TelegramStateStore(dir);

        const dispatchFn = mock(async () => ({ sessionId: 'thread-sticky-codex' }));
        let pollCount = 0;

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(3260, '/runtime codex', 12345)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3261, 'Codex 기본 런타임으로 실행해줘', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);
        await runPoll(poller);

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].agentRuntime).toBe('codex');
        expect(board.cards[0].model).toBe('gpt-5.3-codex');

        const state = await telegramStateStore.getChatState(12345);
        expect(state?.defaultAgentRuntime).toBe('codex');
        expect(state?.selectedAgentRuntime).toBe('codex');
      });
    });

    test('standalone Codex follow-up resumes selected session without followUpFn', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);
        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          defaultAgentRuntime: 'codex',
          defaultModel: 'gpt-5.5',
        });

        let newSessionCount = 0;
        const dispatchFn = mock(async (cardId: string) => {
          const card = await store.getCard(cardId);
          const sessionId = card?.resumeSessionId ?? `thread-${++newSessionCount}`;
          await store.updateCard(cardId, {
            status: 'complete',
            sessionId,
            resumeSessionId: null,
          });
          return { sessionId };
        });

        let pollCount = 0;
        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(3264, 'Codex first task', 12345)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3265, 'Codex follow-up task', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);
        await runPoll(poller);

        expect(dispatchFn).toHaveBeenCalledTimes(2);
        expect(newSessionCount).toBe(1);

        const board = await store.load();
        expect(board.cards).toHaveLength(2);
        const firstCard = board.cards.find(card => card.description === 'Codex first task');
        const followUpCard = board.cards.find(card => card.description === 'Codex follow-up task');
        expect(firstCard?.sessionId).toBe('thread-1');
        expect(followUpCard?.resumeSessionId).toBeUndefined();
        expect(followUpCard?.sessionId).toBe('thread-1');
        expect(followUpCard?.agentRuntime).toBe('codex');

        const state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBe('thread-1');
        expect(state?.selectedCardId).toBe(followUpCard?.id);
        expect(state?.selectedAgentRuntime).toBe('codex');
      });
    });

    test('new_session starts a fresh Codex session and later plain messages resume it', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Old Codex task',
          description: 'Old Codex task',
          sessionId: 'thread-old',
          agentRuntime: 'codex',
          telegramChatId: 12345,
        });
        await store.updateCard(existingCard.id, { status: 'complete' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'thread-old',
          selectedCardId: existingCard.id,
          selectedAgentRuntime: 'codex',
          defaultAgentRuntime: 'codex',
          defaultModel: 'gpt-5.5',
          mode: 'pinned',
        });

        let newSessionCount = 0;
        const dispatchFn = mock(async (cardId: string) => {
          const card = await store.getCard(cardId);
          const sessionId = card?.resumeSessionId ?? `thread-new-${++newSessionCount}`;
          await store.updateCard(cardId, {
            status: 'complete',
            sessionId,
            resumeSessionId: null,
          });
          return { sessionId };
        });

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [
                makeUpdate(3266, '/new_session', 12345),
                makeUpdate(3267, 'Fresh Codex task', 12345),
                makeUpdate(3268, 'Fresh Codex follow-up', 12345),
              ],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);

        expect(dispatchFn).toHaveBeenCalledTimes(2);
        expect(newSessionCount).toBe(1);

        const board = await store.load();
        const freshCard = board.cards.find(card => card.description === 'Fresh Codex task');
        const followUpCard = board.cards.find(card => card.description === 'Fresh Codex follow-up');
        expect(freshCard?.sessionId).toBe('thread-new-1');
        expect(followUpCard?.sessionId).toBe('thread-new-1');
        expect(board.cards.find(card => card.id === existingCard.id)?.sessionId).toBe('thread-old');

        const state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBe('thread-new-1');
        expect(state?.selectedCardId).toBe(followUpCard?.id);
        expect(state?.selectedAgentRuntime).toBe('codex');
        expect(state?.defaultAgentRuntime).toBe('codex');
        expect(state?.defaultModel).toBe('gpt-5.5');
      });
    });

    test('runtime dispatch commands create cards with runtime-specific options', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);
        const telegramStateStore = new TelegramStateStore(dir);

        await telegramStateStore.upsertChatState(12345, {
          defaultProjectDir: dir,
          defaultClaudePermissionMode: 'plan',
          defaultCodexSandbox: 'read-only',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'claude-direct-session' }));

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3262, '/claude 이 리팩토링 검토해줘', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].agentRuntime).toBe('claude');
        expect(board.cards[0].projectDir).toBe(dir);
        expect(board.cards[0].claudeOptions?.permissionMode).toBe('plan');
      });
    });

    test('opencode command accepts a leading agent command', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-opencode-leading-agent' }));

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3263, '/opencode /헤파이스토 테스트 깨지는 원인 찾아줘', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn);
        await runPoll(poller);

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].agentRuntime).toBe('opencode');
        expect(board.cards[0].agentType).toBe('hephaestus');
        expect(board.cards[0].description).toBe('테스트 깨지는 원인 찾아줘');
      });
    });

    test('new session command clears selected session but preserves sticky default agent and model', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Pinned task',
          description: 'Pinned task',
          sessionId: 'ses-old-selected',
          telegramChatId: 12345,
        });
        await store.updateCard(existingCard.id, { status: 'in_progress' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-old-selected',
          selectedCardId: existingCard.id,
          mode: 'pinned',
          defaultAgentType: 'hephaestus',
          defaultModel: 'github-copilot/gpt-5.4',
          defaultAgentRuntime: 'claude',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-default-after-reset' }));
        const sentMessages: string[] = [];
        let pollCount = 0;

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({
                ok: true,
                result: [makeUpdate(4100, '/new_session', 12345)],
              }), { status: 200 });
            }
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(4101, 'reset 이후 기본 에이전트로 실행', 12345)],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            sentMessages.push(JSON.parse(init.body as string).text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);

        let state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBeUndefined();
        expect(state?.selectedCardId).toBeUndefined();
        expect(state?.defaultAgentType).toBe('hephaestus');
        expect(state?.defaultModel).toBe('github-copilot/gpt-5.4');
        expect(state?.defaultAgentRuntime).toBe('claude');

        await runPoll(poller);
        expect(dispatchFn).toHaveBeenCalledTimes(1);

        const board = await store.load();
        const newCard = board.cards.find(card => card.description === 'reset 이후 기본 에이전트로 실행');
        expect(newCard).toBeDefined();
        expect(newCard?.agentType).toBeUndefined();
        expect(newCard?.model).toBe(DEFAULT_CLAUDE_MODEL);
        expect(newCard?.agentRuntime).toBe('claude');

        state = await telegramStateStore.getChatState(12345);
        expect(state?.selectedSessionId).toBe('ses-default-after-reset');
        expect(state?.selectedCardId).toBe(newCard?.id);
        expect(state?.selectedAgentRuntime).toBe('claude');
        expect(state?.defaultAgentType).toBe('hephaestus');
        expect(state?.defaultModel).toBe('github-copilot/gpt-5.4');
        expect(state?.defaultAgentRuntime).toBe('claude');
        expect(sentMessages[0]).toContain('다음 메시지부터 새 세션으로 시작합니다');
      });
    });

    test('completed selected session is restored for follow-up after idle-style status change', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const existingCard = await store.createCard({
          title: 'Completed selected task',
          description: 'Completed selected task',
          sessionId: 'ses-completed-selected',
          sessionTitle: 'Completed Session',
          telegramChatId: 12345,
          agentType: 'hephaestus',
          model: 'github-copilot/gpt-5.4',
        });
        await store.updateCard(existingCard.id, { status: 'complete' });

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          selectedSessionId: 'ses-completed-selected',
          selectedCardId: existingCard.id,
          mode: 'pinned',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-should-not-dispatch' }));
        const followUpFn = mock(async () => {});

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(4200, '완료 후에도 같은 세션으로 이어서', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, followUpFn, { telegramStateStore });
        await runPoll(poller);

        expect(dispatchFn).not.toHaveBeenCalled();
        expect(followUpFn).toHaveBeenCalledTimes(1);
        expect(followUpFn).toHaveBeenCalledWith('ses-completed-selected', '완료 후에도 같은 세션으로 이어서', {
          agentType: 'hephaestus',
          model: 'github-copilot/gpt-5.4',
        });

        const board = await store.load();
        const followUpCard = board.cards.find(card => card.description === '완료 후에도 같은 세션으로 이어서');
        expect(followUpCard).toBeDefined();
        expect(followUpCard?.sessionId).toBe('ses-completed-selected');
      });
    });

    test('persisted sticky agent uses shared default model mapping over stale stored model', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const telegramStateStore = new TelegramStateStore(dir);
        await telegramStateStore.upsertChatState(12345, {
          defaultAgentType: 'hephaestus',
          defaultModel: 'github-copilot/claude-opus-4.6',
        });

        const dispatchFn = mock(async () => ({ sessionId: 'ses-shared-default-model' }));

        globalThis.fetch = mock(async (url: RequestInfo) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3252, '공유 기본 모델로 실행해줘', 12345)],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = new TelegramPoller(store, settingsStore, dispatchFn, undefined, { telegramStateStore });
        await runPoll(poller);

        const board = await store.load();
        expect(board.cards).toHaveLength(1);
        expect(board.cards[0].agentType).toBe('hephaestus');
        expect(board.cards[0].model).toBe('github-copilot/gpt-5.4');
      });
    });

    test('dispatch acknowledgement includes agent and model', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        await seedTelegramSettings(settingsStore);

        const dispatchFn = mock(async () => ({ sessionId: 'ses-ack' }));
        const sentMessages: string[] = [];

        globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
          const urlStr = url instanceof URL ? url.toString() : url as string;
          if (urlStr.includes('/getUpdates')) {
            return new Response(JSON.stringify({
              ok: true,
              result: [makeUpdate(3300, '원인 분석해줘 /시시푸스', 12345)],
            }), { status: 200 });
          }
          if (urlStr.includes('/sendMessage') && init?.body) {
            const body = JSON.parse(init.body as string);
            sentMessages.push(body.text);
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }) as unknown as typeof fetch;

        const poller = createPoller(dir, store, settingsStore, dispatchFn);
        await (poller as any).poll();

        expect(sentMessages[0]).toContain('에이전트: Sisyphus');
        expect(sentMessages[0]).toContain('모델: github-copilot/claude-opus-4.6');
      });
    });
  });
});
