import { describe, test, expect, mock, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sendTelegramMessage,
  getTelegramUpdates,
  setTelegramChatMenuButton,
  setTelegramCommands,
} from '../plugin/telegram-notifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-token-123';
const TEST_CHAT_ID = 12345;

// ---------------------------------------------------------------------------
// Tests — sendTelegramMessage
// ---------------------------------------------------------------------------

describe('sendTelegramMessage', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE;
  });

  test('sends message and returns ok result', async () => {
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 42 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello');

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(42);
    expect(result.error).toBeUndefined();
    expect(capturedUrls[0]).toContain(`/bot${TEST_TOKEN}/sendMessage`);
    expect(capturedBodies[0]).toEqual({
      chat_id: TEST_CHAT_ID,
      text: 'Hello',
    });
  });

  test('sends message with HTML parse mode', async () => {
    const capturedBodies: unknown[] = [];

    globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
      capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 43 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, '<b>Bold</b>', 'HTML');

    expect(result.ok).toBe(true);
    expect((capturedBodies[0] as any).parse_mode).toBe('HTML');
  });

  test('returns error when Telegram API returns ok: false', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        ok: false,
        description: 'Bad Request: chat not found',
      }), { status: 400 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Bad Request: chat not found');
    expect(result.messageId).toBeUndefined();
  });

  test('returns error when Telegram API returns ok: false without description', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown Telegram API error');
  });

  test('returns error when fetch throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  test('returns generic error when fetch throws non-Error', async () => {
    globalThis.fetch = mock(async () => {
      throw 'some string error';
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Failed to send Telegram message');
  });

  test('writes runtime debug log for send attempt and result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-log-test-'));
    const logPath = join(dir, 'runtime-debug.log');
    process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE = logPath;

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 99 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMessage(TEST_TOKEN, TEST_CHAT_ID, 'Hello log');

    expect(result.ok).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.some((line) => line.event === 'telegram.send.attempt' && line.chatId === TEST_CHAT_ID)).toBe(true);
    expect(lines.some((line) => line.event === 'telegram.send.result' && line.ok === true && line.messageId === 99)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — getTelegramUpdates
// ---------------------------------------------------------------------------

describe('getTelegramUpdates', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('fetches updates with offset and timeout', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mock(async (url: RequestInfo) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      return new Response(JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 1,
              chat: { id: 12345, type: 'private' },
              date: 1700000000,
              text: 'Hello bot',
              from: { id: 1, first_name: 'Test' },
            },
          },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const updates = await getTelegramUpdates(TEST_TOKEN, 50, 10);

    expect(updates).toHaveLength(1);
    expect(updates[0].update_id).toBe(100);
    expect(updates[0].message?.text).toBe('Hello bot');

    const url = new URL(capturedUrls[0]);
    expect(url.pathname).toContain(`/bot${TEST_TOKEN}/getUpdates`);
    expect(url.searchParams.get('offset')).toBe('50');
    expect(url.searchParams.get('timeout')).toBe('10');
  });

  test('fetches updates without offset', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mock(async (url: RequestInfo) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      return new Response(JSON.stringify({
        ok: true,
        result: [],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const updates = await getTelegramUpdates(TEST_TOKEN);

    expect(updates).toEqual([]);

    const url = new URL(capturedUrls[0]);
    expect(url.searchParams.has('offset')).toBe(false);
    expect(url.searchParams.get('timeout')).toBe('0');
  });

  test('returns empty array when API returns ok: false', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        ok: false,
        description: 'Unauthorized',
      }), { status: 401 });
    }) as unknown as typeof fetch;

    const updates = await getTelegramUpdates(TEST_TOKEN);

    expect(updates).toEqual([]);
  });

  test('returns empty array when API returns no result', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const updates = await getTelegramUpdates(TEST_TOKEN);

    expect(updates).toEqual([]);
  });

  test('throws when fetch fails', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    await expect(getTelegramUpdates(TEST_TOKEN)).rejects.toThrow('Network error');
  });
});

describe('setTelegramCommands', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('registers Telegram bot commands with scope and language', async () => {
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await setTelegramCommands(TEST_TOKEN, [
      { command: 'help', description: '사용 가능한 명령 보기' },
    ], {
      scope: { type: 'all_private_chats' },
      languageCode: 'ko',
    });

    expect(result).toEqual({ ok: true });
    expect(capturedUrls[0]).toContain(`/bot${TEST_TOKEN}/setMyCommands`);
    expect(capturedBodies[0]).toEqual({
      commands: [{ command: 'help', description: '사용 가능한 명령 보기' }],
      scope: { type: 'all_private_chats' },
      language_code: 'ko',
    });
  });

  test('returns error when Telegram command registration fails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        ok: false,
        description: 'Bad Request: commands are invalid',
      }), { status: 400 });
    }) as unknown as typeof fetch;

    const result = await setTelegramCommands(TEST_TOKEN, [{ command: 'help', description: 'desc' }]);

    expect(result).toEqual({ ok: false, error: 'Bad Request: commands are invalid' });
  });
});

describe('setTelegramChatMenuButton', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('updates Telegram chat menu button to commands', async () => {
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    globalThis.fetch = mock(async (url: RequestInfo, init?: RequestInit) => {
      capturedUrls.push(url instanceof URL ? url.toString() : url as string);
      capturedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await setTelegramChatMenuButton(TEST_TOKEN, {
      menuButton: { type: 'commands' },
    });

    expect(result).toEqual({ ok: true });
    expect(capturedUrls[0]).toContain(`/bot${TEST_TOKEN}/setChatMenuButton`);
    expect(capturedBodies[0]).toEqual({
      menu_button: { type: 'commands' },
    });
  });
});
