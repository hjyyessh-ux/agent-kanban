import type { KanbanStore } from '../core/store';
import type { SettingsStore } from '../core/settings-store';
import { sendTelegramMessage } from './telegram-notifier';

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

function truncateTelegramMessage(text: string): string {
  if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH - 4)}\n...`;
}

function buildTelegramCompletionMessage(card: {
  id: string;
  title: string;
  sessionId?: string;
}, result: string): string {
  return truncateTelegramMessage([
    '✅ 작업 완료',
    `- 카드: ${card.title} (${card.id})`,
    `- 세션: ${card.sessionId ?? 'unknown'}`,
    '',
    result,
  ].join('\n'));
}

function buildTelegramReplyUpdates(status: 'sent' | 'failed', options?: {
  messageId?: number;
  error?: string;
}) {
  return {
    telegramReplyStatus: status,
    telegramReplyMessageId: options?.messageId ?? null,
    telegramReplyError: options?.error ?? null,
    telegramReplyUpdatedAt: new Date().toISOString(),
  };
}

function isTelegramOriginCard(card: {
  originChannel?: string;
  telegramChatId?: number;
}): boolean {
  return card.originChannel === 'telegram' || typeof card.telegramChatId === 'number';
}

export async function notifyTelegramCompletion(input: {
  store: KanbanStore;
  settingsStore?: SettingsStore;
  cardId: string;
  result: string;
}): Promise<void> {
  const card = await input.store.getCard(input.cardId);
  if (!card || !isTelegramOriginCard(card)) return;

  let telegramToken: string | undefined;
  if (input.settingsStore) {
    try {
      const entries = await input.settingsStore.getEntries();
      telegramToken = entries.find(entry => entry.key === 'TELEGRAM_BOT_TOKEN')?.value;
    } catch {
      telegramToken = undefined;
    }
  }

  if (!telegramToken || !card.telegramChatId) {
    await input.store.updateCard(card.id, buildTelegramReplyUpdates('failed', {
      error: telegramToken ? 'Missing Telegram chat ID' : 'Missing TELEGRAM_BOT_TOKEN',
    }));
    return;
  }

  const sendResult = await sendTelegramMessage(
    telegramToken,
    card.telegramChatId,
    buildTelegramCompletionMessage(card, input.result),
  );
  await input.store.updateCard(card.id, buildTelegramReplyUpdates(
    sendResult.ok ? 'sent' : 'failed',
    sendResult.ok ? { messageId: sendResult.messageId } : { error: sendResult.error },
  ));
}
