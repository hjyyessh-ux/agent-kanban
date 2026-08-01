import { appendRuntimeDebugLog } from './debug-log';

// Telegram Bot API helper for sending messages

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/** Telegram rejects `sendMessage` above 4096 UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Room reserved on each part for the `(2/5)\n` prefix that multi-part sends
 * carry. Only spent when a message actually splits.
 */
const PART_PREFIX_BUDGET = 16;

/**
 * Telegram throttles sustained sends to roughly one message per second per
 * chat. Long results arrive as several parts, so pace them rather than risk a
 * 429 dropping the tail.
 */
const PART_SEND_DELAY_MS = 350;

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/**
 * Cut `text` into Telegram-sized parts, preferring a line boundary so code
 * blocks and list items stay readable. Never truncates: every code unit of the
 * input lands in exactly one part.
 */
export function splitTelegramMessage(
  text: string,
  limit: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= limit) return [text];

  // Parts get a `(i/n)` prefix, so each slice must leave room for it.
  const sliceLimit = Math.max(1, limit - PART_PREFIX_BUDGET);
  const parts: string[] = [];
  let rest = text;

  while (rest.length > sliceLimit) {
    let cut = rest.lastIndexOf('\n', sliceLimit);
    // No line break to land on — cut at the limit, but never between the two
    // halves of a surrogate pair or the emoji turns into a replacement char.
    if (cut <= 0) {
      cut = sliceLimit;
      const lead = rest.charCodeAt(cut - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) parts.push(rest);

  return parts.map((part, index) => `(${index + 1}/${parts.length})\n${part}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface TelegramBotApiResult {
  ok: boolean;
  error?: string;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

async function postTelegramApi<TResponse extends { ok: boolean; description?: string }>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<TResponse> {
  const url = `${TELEGRAM_API_BASE}${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return await response.json() as TResponse;
}

/**
 * Send a text message to a Telegram chat. Text over the 4096-code-unit API
 * limit is split across several messages rather than truncated; the returned
 * `messageId` is the first part's.
 *
 * @param token - Bot token from BotFather
 * @param chatId - Telegram chat ID (negative for groups/channels)
 * @param text - Message text (supports Markdown)
 * @param parseMode - Parse mode: 'Markdown', 'MarkdownV2', or 'HTML'. Omit for plain text (default).
 * @param replyMarkup - Inline keyboard, attached to the last part.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
  replyMarkup?: TelegramInlineKeyboardMarkup,
): Promise<TelegramSendResult> {
  const parts = splitTelegramMessage(text);
  appendRuntimeDebugLog('telegram.send.attempt', {
    chatId,
    parseMode: parseMode ?? null,
    textPreview: text.slice(0, 160),
    textLength: text.length,
    ...(parts.length > 1 ? { partCount: parts.length } : {}),
  });

  let firstMessageId: number | undefined;
  try {
    for (const [index, part] of parts.entries()) {
      if (index > 0) await delay(PART_SEND_DELAY_MS);

      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: part,
      };
      if (parseMode) {
        payload.parse_mode = parseMode;
      }
      // Buttons belong at the bottom of the conversation, not mid-result.
      if (replyMarkup && index === parts.length - 1) {
        payload.reply_markup = replyMarkup;
      }
      const data = await postTelegramApi<{ ok: boolean; result?: { message_id: number }; description?: string }>(
        token,
        'sendMessage',
        payload,
      );

      if (!data.ok) {
        appendRuntimeDebugLog('telegram.send.result', {
          chatId,
          ok: false,
          error: data.description ?? 'Unknown Telegram API error',
          ...(parts.length > 1 ? { failedPart: index + 1, partCount: parts.length } : {}),
        });
        return { ok: false, error: data.description ?? 'Unknown Telegram API error' };
      }

      if (index === 0) firstMessageId = data.result?.message_id;
    }

    appendRuntimeDebugLog('telegram.send.result', {
      chatId,
      ok: true,
      messageId: firstMessageId,
      ...(parts.length > 1 ? { partCount: parts.length } : {}),
    });
    return { ok: true, messageId: firstMessageId };
  } catch (error) {
    appendRuntimeDebugLog('telegram.send.result', {
      chatId,
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to send Telegram message',
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to send Telegram message',
    };
  }
}

/**
 * Acknowledge a tapped inline-keyboard button. Telegram shows the spinner on
 * the button until this is called, so it must run even when the action failed.
 */
export async function answerTelegramCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<TelegramBotApiResult> {
  try {
    const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) {
      // Telegram caps the toast at 200 characters.
      payload.text = text.slice(0, 200);
    }
    const data = await postTelegramApi<{ ok: boolean; description?: string }>(
      token,
      'answerCallbackQuery',
      payload,
    );
    if (!data.ok) {
      return { ok: false, error: data.description ?? 'Unknown Telegram API error' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to answer Telegram callback query',
    };
  }
}

export async function setTelegramCommands(
  token: string,
  commands: TelegramBotCommand[],
  options?: { scope?: Record<string, unknown> },
): Promise<TelegramBotApiResult> {
  appendRuntimeDebugLog('telegram.commands.register.attempt', {
    count: commands.length,
    commands: commands.map(command => command.command),
    scope: options?.scope ?? null,
  });

  try {
    const payload: Record<string, unknown> = {
      commands,
    };

    if (options?.scope) {
      payload.scope = options.scope;
    }

    const data = await postTelegramApi<{ ok: boolean; description?: string }>(token, 'setMyCommands', payload);
    if (!data.ok) {
      appendRuntimeDebugLog('telegram.commands.register.result', {
        ok: false,
        error: data.description ?? 'Unknown Telegram API error',
      });
      return { ok: false, error: data.description ?? 'Unknown Telegram API error' };
    }

    appendRuntimeDebugLog('telegram.commands.register.result', { ok: true });
    return { ok: true };
  } catch (error) {
    appendRuntimeDebugLog('telegram.commands.register.result', {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to register Telegram commands',
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to register Telegram commands',
    };
  }
}

export async function setTelegramChatMenuButton(
  token: string,
  options?: { chatId?: number; menuButton?: { type: 'commands' | 'default' | 'web_app'; text?: string; web_app?: { url: string } } },
): Promise<TelegramBotApiResult> {
  appendRuntimeDebugLog('telegram.menu_button.register.attempt', {
    chatId: options?.chatId ?? null,
    buttonType: options?.menuButton?.type ?? 'commands',
  });

  try {
    const payload: Record<string, unknown> = {
      menu_button: options?.menuButton ?? { type: 'commands' },
    };

    if (options?.chatId !== undefined) {
      payload.chat_id = options.chatId;
    }

    const data = await postTelegramApi<{ ok: boolean; description?: string }>(token, 'setChatMenuButton', payload);
    if (!data.ok) {
      appendRuntimeDebugLog('telegram.menu_button.register.result', {
        ok: false,
        error: data.description ?? 'Unknown Telegram API error',
      });
      return { ok: false, error: data.description ?? 'Unknown Telegram API error' };
    }

    appendRuntimeDebugLog('telegram.menu_button.register.result', { ok: true });
    return { ok: true };
  } catch (error) {
    appendRuntimeDebugLog('telegram.menu_button.register.result', {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to update Telegram menu button',
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to update Telegram menu button',
    };
  }
}

/**
 * Telegram getUpdates response types
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
    };
    date: number;
    text?: string;
  };
  /** Present when the user taps an inline-keyboard button. */
  callback_query?: {
    id: string;
    from?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
        title?: string;
      };
    };
    data?: string;
  };
}

export interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

/**
 * Fetch new updates from Telegram Bot API using long polling.
 *
 * @param token - Bot token
 * @param offset - Update ID offset (pass last_update_id + 1 to avoid duplicates)
 * @param timeout - Long poll timeout in seconds (0 = no long poll)
 */
export async function getTelegramUpdates(
  token: string,
  offset?: number,
  timeout: number = 0,
): Promise<TelegramUpdate[]> {
  const url = new URL(`${TELEGRAM_API_BASE}${token}/getUpdates`);
  if (offset !== undefined) {
    url.searchParams.set('offset', String(offset));
  }
  url.searchParams.set('timeout', String(timeout));

  const response = await fetch(url.toString());
  const data = await response.json() as TelegramGetUpdatesResponse;

  if (!data.ok || !data.result) {
    return [];
  }

  return data.result;
}
