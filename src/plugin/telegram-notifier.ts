import { appendRuntimeDebugLog } from './debug-log';

// Telegram Bot API helper for sending messages

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
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
 * Send a text message to a Telegram chat.
 *
 * @param token - Bot token from BotFather
 * @param chatId - Telegram chat ID (negative for groups/channels)
 * @param text - Message text (supports Markdown)
 * @param parseMode - Parse mode: 'Markdown', 'MarkdownV2', or 'HTML'. Omit for plain text (default).
 */
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
): Promise<TelegramSendResult> {
  appendRuntimeDebugLog('telegram.send.attempt', {
    chatId,
    parseMode: parseMode ?? null,
    textPreview: text.slice(0, 160),
    textLength: text.length,
  });
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (parseMode) {
      payload.parse_mode = parseMode;
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
      });
      return { ok: false, error: data.description ?? 'Unknown Telegram API error' };
    }

    appendRuntimeDebugLog('telegram.send.result', {
      chatId,
      ok: true,
      messageId: data.result?.message_id,
    });
    return { ok: true, messageId: data.result?.message_id };
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

export async function setTelegramCommands(
  token: string,
  commands: TelegramBotCommand[],
  options?: { scope?: Record<string, unknown>; languageCode?: string },
): Promise<TelegramBotApiResult> {
  appendRuntimeDebugLog('telegram.commands.register.attempt', {
    count: commands.length,
    commands: commands.map(command => command.command),
    scope: options?.scope ?? null,
    languageCode: options?.languageCode ?? null,
  });

  try {
    const payload: Record<string, unknown> = {
      commands,
    };

    if (options?.scope) {
      payload.scope = options.scope;
    }

    if (options?.languageCode) {
      payload.language_code = options.languageCode;
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
