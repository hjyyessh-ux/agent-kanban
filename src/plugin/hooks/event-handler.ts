import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type { Part } from '@opencode-ai/sdk';
import type { KanbanStore } from '../../core/store';
import type { DispatchResult, KanbanCard } from '../../core/types';
import type { SettingsStore } from '../../core/settings-store';
import { sanitizeUserText } from './chat-message';
import { sendTelegramMessage } from '../telegram-notifier';
import { clearDispatch } from './dispatch-tracker';
import { clearSeenSessionActivity, hasSeenSessionActivity } from './session-activity-registry';
import { clearSubagentParent, registerSubagentParent } from './subagent-parent-registry';
import { isTopLevelParentWaitingOnDirectChild } from '../parent-card-guard';
import { resolveSessionParentAnchor } from './parent-anchor';
import { appendRuntimeDebugLog } from '../debug-log';
import { captureGitEndAndUsage } from '../runtimes/git-capture';

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
type DispatchResultLike = DispatchResult | { sessionId: string };


/**
 * Extract text content from message parts.
 * Filters for text-type parts and joins them.
 */
function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}


interface AssistantSnapshot {
  hasAssistantMessage: boolean;
  result?: string;
  progressSummary?: string;
}

export function isRecentlyFailed(card: Pick<KanbanCard, 'progressSummary'>): boolean {
  return !!card.progressSummary
    && /^\[(failed|aborted|reconciled|opencode-error)\]/.test(card.progressSummary);
}

export async function dispatchNextQueuedTodoCard(
  store: KanbanStore,
  completedCardId: string,
  dispatchFn?: (cardId: string) => Promise<DispatchResultLike>,
): Promise<void> {
  if (!dispatchFn) return;

  const queuedCards = await store.getQueuedCards(completedCardId);
  const nextQueuedTodo = queuedCards.find((queuedCard) =>
    queuedCard.status === 'todo' && !isRecentlyFailed(queuedCard)
  );
  if (!nextQueuedTodo) return;

  try {
    await dispatchFn(nextQueuedTodo.id);
  } catch {
  }
}

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

function buildCardTitleFromDescription(description: string): string {
  const [firstLine] = description.split('\n');
  return firstLine.trim();
}

function buildSupersededResult(existingResult: string | undefined, primaryCard: {
  id: string;
  title: string;
}): string {
  const supersededNotice = [
    '[Superseded]',
    '이 카드의 요청은 같은 세션의 다른 카드에서 처리되었습니다.',
    `처리 결과 카드: ${primaryCard.id} (${primaryCard.title})`,
  ].join('\n');

  const trimmedExisting = existingResult?.trim();
  if (!trimmedExisting) {
    return supersededNotice;
  }

  return `${trimmedExisting}\n\n---\n${supersededNotice}`;
}

function buildResponseTimestampsByCreatedAt(cards: Pick<KanbanCard, 'id' | 'createdAt' | 'updatedAt'>[]): Map<string, string> {
  const baseTime = Date.now();
  const sortedCards = [...cards].sort((left, right) => {
    const createdDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (createdDelta !== 0) return createdDelta;

    const updatedDelta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
    if (updatedDelta !== 0) return updatedDelta;

    return left.id.localeCompare(right.id);
  });

  return new Map(sortedCards.map((card, index) => [
    card.id,
    new Date(baseTime + index).toISOString(),
  ]));
}

function buildTelegramReplyUpdates(status: 'sent' | 'failed' | 'skipped', options?: {
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

async function fetchAssistantSnapshot(
  client: PluginInput['client'],
  sessionID: string,
): Promise<AssistantSnapshot | undefined> {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
    });

    if (!response.data) return undefined;

    const assistantMessages = response.data.filter(msg => msg.info.role === 'assistant');
    if (assistantMessages.length === 0) {
      return {
        hasAssistantMessage: true,
        result: undefined,
        progressSummary: undefined,
      };
    }

    const assistantTexts = assistantMessages
      .filter(msg => msg.info.role === 'assistant')
      .map(msg => extractTextFromParts(msg.parts))
      .filter(t => t.length > 0);

    const result = assistantTexts.length > 0
      ? assistantTexts[assistantTexts.length - 1]
      : undefined;

    if (assistantTexts.length === 0) {
      return {
        hasAssistantMessage: true,
        result: undefined,
        progressSummary: undefined,
      };
    }

    const first = assistantTexts[0];
    const last = assistantTexts[assistantTexts.length - 1];
    const progressSummary = first === last
      ? `[Start+End] ${first}`
      : `[Start] ${first}\n\n[End] ${last}`;

    return {
      hasAssistantMessage: true,
      result,
      progressSummary,
    };
  } catch {
    return undefined;
  }
}

/**
 * Creates the `event` hook handler.
 *
 * Listens for `session.idle` events and transitions any `in_progress` card
 * belonging to that session to `complete`.
 *
 * Also:
 * - Fetches the last assistant message to populate the `result` field
 * - Sanitizes card descriptions for cards created before sanitization was added
 *
 * The user then decides whether to mark it `done` or provide feedback.
 */
export function createEventHandler(
  store: KanbanStore,
  input: PluginInput,
  dispatchFn?: (cardId: string) => Promise<DispatchResultLike>,
  settingsStore?: SettingsStore,
  onSessionComplete?: (sessionId: string) => Promise<void> | void,
): NonNullable<Hooks['event']> {
  return async ({ event }) => {
    if (event.type === 'session.created') {
      const childSession = event.properties.info;
      if (!childSession.parentID) return;

      const cards = await store.getCards();
      const parentCard = resolveSessionParentAnchor(cards, childSession.parentID);
      if (!parentCard) return;

      registerSubagentParent(childSession.id, {
        parentCardId: parentCard.id,
        rootCardId: parentCard.parentCardId ?? parentCard.id,
        parentSessionId: childSession.parentID,
      });
      return;
    }

    if (event.type !== 'session.idle') return;

    const sessionID = event.properties.sessionID;
    appendRuntimeDebugLog('session.idle.received', { sessionID });

    if (!hasSeenSessionActivity(sessionID)) {
      appendRuntimeDebugLog('session.idle.skipped', { sessionID, reason: 'no_session_activity' });
      return;
    }

    const cards = await store.getCards({ status: 'in_progress' });
    const matchingCards = cards
      .filter(card => card.sessionId === sessionID)
      .sort((left, right) => {
        const createdDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        if (createdDelta !== 0) return createdDelta;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
    const blockedCards = matchingCards.filter(card => isTopLevelParentWaitingOnDirectChild(card, cards));
    const blockedCardIds = new Set(blockedCards.map(card => card.id));
    const completableCards = matchingCards.filter(card => !blockedCardIds.has(card.id));
    const primaryCard = completableCards[0];
    if (!primaryCard) {
      appendRuntimeDebugLog('session.idle.skipped', {
        sessionID,
        reason: matchingCards.length > 0 ? 'waiting_on_direct_child' : 'no_primary_card',
        blockedCardCount: blockedCards.length,
      });
      return;
    }

    const assistantSnapshot = await fetchAssistantSnapshot(input.client, sessionID);
    if (!assistantSnapshot?.hasAssistantMessage) {
      appendRuntimeDebugLog('session.idle.skipped', { sessionID, cardId: primaryCard.id, reason: 'no_assistant_message' });
      return;
    }

    const result = assistantSnapshot.result ?? '(No result captured)';
    const progressSummary = assistantSnapshot.progressSummary;
    const responseAtByCardId = buildResponseTimestampsByCreatedAt(completableCards);

    let telegramToken: string | undefined;
    if (settingsStore) {
      try {
        const entries = await settingsStore.getEntries();
        telegramToken = entries.find(entry => entry.key === 'TELEGRAM_BOT_TOKEN')?.value;
      } catch {
        telegramToken = undefined;
      }
    }

    let primaryDescription = primaryCard.description;
    let primaryTitle = primaryCard.title;

    if (!primaryCard.feedbackForCardId) {
      const sanitizedDescription = sanitizeUserText(primaryCard.description);
      if (sanitizedDescription && sanitizedDescription !== primaryCard.description) {
        primaryDescription = sanitizedDescription;
        primaryTitle = buildCardTitleFromDescription(sanitizedDescription);
      }
    }

    const updatedPrimaryCard = await store.updateCard(primaryCard.id, {
      status: 'complete',
      resolution: 'completed',
      result,
      responseAt: responseAtByCardId.get(primaryCard.id),
      ...(progressSummary ? { progressSummary } : {}),
      ...(primaryDescription !== primaryCard.description ? { description: primaryDescription } : {}),
      ...(primaryTitle !== primaryCard.title ? { title: primaryTitle } : {}),
      supersededByCardId: null,
      supersededAt: null,
      staleStatus: null,
      staleDetectedAt: null,
      queuedAfterCardId: null,
      queuePosition: null,
      queueSessionMode: null,
      resumeSessionId: null,
    });
    appendRuntimeDebugLog('session.idle.primary_completed', {
      sessionID,
      cardId: updatedPrimaryCard.id,
      matchingCardCount: matchingCards.length,
      completedCardCount: completableCards.length,
      blockedCardCount: blockedCards.length,
      telegramOrigin: isTelegramOriginCard(updatedPrimaryCard),
    });

    for (const supersededCard of completableCards.slice(1)) {
      let supersededDescription = supersededCard.description;
      let supersededTitle = supersededCard.title;

      if (!supersededCard.feedbackForCardId) {
        const sanitizedDescription = sanitizeUserText(supersededCard.description);
        if (sanitizedDescription && sanitizedDescription !== supersededCard.description) {
          supersededDescription = sanitizedDescription;
          supersededTitle = buildCardTitleFromDescription(sanitizedDescription);
        }
      }

      await store.updateCard(supersededCard.id, {
        status: 'complete',
        resolution: 'superseded',
        result: buildSupersededResult(supersededCard.result, {
          id: updatedPrimaryCard.id,
          title: updatedPrimaryCard.title,
        }),
        responseAt: responseAtByCardId.get(supersededCard.id),
        ...(supersededDescription !== supersededCard.description ? { description: supersededDescription } : {}),
        ...(supersededTitle !== supersededCard.title ? { title: supersededTitle } : {}),
        supersededByCardId: updatedPrimaryCard.id,
        supersededAt: new Date().toISOString(),
        staleStatus: null,
        staleDetectedAt: null,
        queuedAfterCardId: null,
        queuePosition: null,
        queueSessionMode: null,
        resumeSessionId: null,
        ...(isTelegramOriginCard(supersededCard) ? buildTelegramReplyUpdates('skipped') : {}),
      });
      appendRuntimeDebugLog('session.idle.superseded', {
        sessionID,
        cardId: supersededCard.id,
        primaryCardId: updatedPrimaryCard.id,
      });
    }

    if (blockedCards.length === 0) {
      clearSubagentParent(sessionID);
      clearDispatch(sessionID);
      clearSeenSessionActivity(sessionID);

      await onSessionComplete?.(sessionID);
    }

    await dispatchNextQueuedTodoCard(store, updatedPrimaryCard.id, dispatchFn);

    if (isTelegramOriginCard(updatedPrimaryCard)) {
      if (telegramToken && updatedPrimaryCard.telegramChatId) {
        appendRuntimeDebugLog('session.idle.telegram_send', {
          sessionID,
          cardId: updatedPrimaryCard.id,
          chatId: updatedPrimaryCard.telegramChatId,
        });
        const sendResult = await sendTelegramMessage(
          telegramToken,
          updatedPrimaryCard.telegramChatId,
          buildTelegramCompletionMessage(updatedPrimaryCard, result),
        );
        await store.updateCard(updatedPrimaryCard.id, buildTelegramReplyUpdates(
          sendResult.ok ? 'sent' : 'failed',
          sendResult.ok ? { messageId: sendResult.messageId } : { error: sendResult.error },
        ));
        appendRuntimeDebugLog('session.idle.telegram_send_result', {
          sessionID,
          cardId: updatedPrimaryCard.id,
          ok: sendResult.ok,
          messageId: sendResult.messageId ?? null,
          error: sendResult.error ?? null,
        });
      } else {
        await store.updateCard(updatedPrimaryCard.id, buildTelegramReplyUpdates('failed', {
          error: telegramToken ? 'Missing Telegram chat ID' : 'Missing TELEGRAM_BOT_TOKEN',
        }));
        appendRuntimeDebugLog('session.idle.telegram_send_result', {
          sessionID,
          cardId: updatedPrimaryCard.id,
          ok: false,
          error: telegramToken ? 'Missing Telegram chat ID' : 'Missing TELEGRAM_BOT_TOKEN',
        });
      }
    }

    // best-effort git capture for the completed card (opencode path has no
    // events.jsonl, so usage is skipped here). Runs last so it can't delay
    // completion, queue auto-dispatch, or the Telegram reply. Never throws.
    await captureGitEndAndUsage(
      store,
      updatedPrimaryCard.id,
      updatedPrimaryCard.projectDir ?? process.cwd(),
    );
  };
}
