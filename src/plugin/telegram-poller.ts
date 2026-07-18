import type { KanbanStore } from '../core/store';
import type { SettingsStore } from '../core/settings-store';
import type { TelegramStateStore } from '../core/telegram-state-store';
import type { AgentRuntime, ClaudeOptions, CodexOptions, DispatchResult, KanbanCard } from '../core/types';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  isClaudeModelValid,
  isCodexModelValid,
  resolveAgentRuntime,
} from '../core/runtime-config';
import { DEFAULT_PRIMARY_MODEL, getDefaultModelForAgent, getPrimaryAgentDisplayLabel } from '../core/agent-config';
import { getTelegramUpdates, sendTelegramMessage, setTelegramChatMenuButton, setTelegramCommands } from './telegram-notifier';
import { clearDispatch, trackDispatch } from './hooks/dispatch-tracker';
import {
  getTelegramRegisteredCommands,
  extractTelegramCommand,
  extractTrailingAgentCommand,
  resolveTelegramCommand,
  type TelegramSessionSummary,
} from './telegram-commands';

const POLL_INTERVAL_MS = 5_000;

export type FollowUpFn = (
  sessionId: string,
  text: string,
  options?: { agentType?: string; model?: string },
) => Promise<void>;

interface ActiveSession {
  sessionId: string;
  cardId: string;
  agentRuntime: AgentRuntime;
  consecutiveFailures: number;
}

interface TelegramPollerOptions {
  telegramStateStore?: TelegramStateStore;
}

interface TelegramCardInput {
  chatId: number;
  telegramMessageId: string;
}

type SessionResolution =
  | { kind: 'none' }
  | { kind: 'active'; activeSession: ActiveSession; sessionInfo: TelegramSessionSummary }
  | { kind: 'invalid'; sessionId: string; agentRuntime?: AgentRuntime; cardId?: string };

export class TelegramPoller {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private polling = false;
  private offset: number | undefined = undefined;
  private commandsRegistered = false;
  private readonly activeSessions = new Map<number, ActiveSession>();

  constructor(
    private readonly store: KanbanStore,
    private readonly settingsStore: SettingsStore,
    private readonly dispatchFn: (cardId: string) => Promise<DispatchResult | { sessionId: string }>,
    private readonly followUpFn?: FollowUpFn,
    private readonly options: TelegramPollerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.ensureTelegramCommandsRegistered();
    this.started = true;
    this.scheduleNextPoll();
  }

  stop(): void {
    this.started = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  async clearSessionBySessionId(sessionId: string): Promise<void> {
    for (const [chatId, active] of this.activeSessions) {
      if (active.sessionId === sessionId) {
        this.activeSessions.delete(chatId);
      }
    }

    if (this.options.telegramStateStore) {
      await this.clearSelectedSessionState(sessionId);
    }
  }

  async getSessionsForChat(chatId: number): Promise<TelegramSessionSummary[]> {
    const cards = await this.store.getCards({ includeArchived: true });
    const relevant = cards
      .filter(card => card.telegramChatId === chatId && card.sessionId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const bySession = new Map<string, typeof relevant[number]>();
    const projectDirBySession = new Map<string, string>();
    for (const card of relevant) {
      if (!card.sessionId) continue;
      const key = this.sessionKey(resolveAgentRuntime(card), card.sessionId);
      if (!bySession.has(key)) {
        bySession.set(key, card);
      }
      if (card.projectDir && !projectDirBySession.has(key)) {
        projectDirBySession.set(key, card.projectDir);
      }
    }

    return Array.from(bySession.entries()).map(([key, card], index) => ({
      index: index + 1,
      sessionId: card.sessionId!,
      cardId: card.id,
      title: card.sessionTitle ?? card.title,
      status: card.status,
      agentRuntime: resolveAgentRuntime(card),
      agentType: card.agentType,
      model: card.model,
      projectDir: projectDirBySession.get(key),
      updatedAt: card.updatedAt,
    }));
  }

  private scheduleNextPoll(): void {
    if (!this.started) return;
    this.timeoutId = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll();
    }, POLL_INTERVAL_MS);
    if (this.timeoutId && typeof this.timeoutId === 'object' && 'unref' in this.timeoutId) {
      (this.timeoutId as NodeJS.Timeout).unref();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const token = await this.getSettingValue('TELEGRAM_BOT_TOKEN');
      if (!token) return;

      await this.ensureTelegramCommandsRegistered(token);

      const updates = await getTelegramUpdates(token, this.offset, 0);
      if (updates.length === 0) return;

      for (const update of updates) {
        this.offset = update.update_id + 1;
        if (!update.message?.text) continue;

        const chatId = update.message.chat.id;
        const telegramMessageId = String(update.message.message_id);
        const text = update.message.text.trim();
        const from = update.message.from;

        const allowed = await this.isAllowedChat(chatId);
        if (!allowed) continue;

        const commandHandled = await this.tryHandleExplicitCommand(token, chatId, telegramMessageId, text);
        if (commandHandled) continue;

        const senderName = from
          ? [from.first_name, from.last_name].filter(Boolean).join(' ')
          : 'Unknown';
        const senderId = from ? String(from.id) : undefined;
        const messageTimestamp = update.message.date
          ? new Date(update.message.date * 1000).toISOString()
          : undefined;

        const modifier = extractTrailingAgentCommand(text);
        const bodyText = modifier.bodyText.trim();
        if (!bodyText) {
          await sendTelegramMessage(
            token,
            chatId,
            '사용법: 작업 내용을 함께 보내세요. 예) 로그인 버그를 수정해줘 /헤파이스토',
          );
          continue;
        }

        const stickyDefaults = await this.getStickyDispatchDefaults(chatId);
        const resolvedAgentRuntime = modifier.agentType ? 'opencode' : stickyDefaults.agentRuntime;
        const resolvedAgentType = resolvedAgentRuntime === 'opencode'
          ? modifier.agentType ?? stickyDefaults.agentType
          : undefined;
        const resolvedModel = this.resolveModelForRuntime(
          resolvedAgentRuntime,
          modifier.model ?? stickyDefaults.model,
          resolvedAgentType,
        );

        const sessionResolution = modifier.agentType
          ? undefined
          : await this.resolveSessionForChat(chatId);

        if (sessionResolution?.kind === 'invalid') {
          await sendTelegramMessage(token, chatId, this.buildInvalidSelectedSessionAck(sessionResolution));
          continue;
        }

        if (sessionResolution?.kind === 'active') {
          const followUpHandled = await this.tryHandleFollowUp(
            token,
            chatId,
            telegramMessageId,
            bodyText,
            sessionResolution.activeSession,
            sessionResolution.sessionInfo,
          );
          if (followUpHandled) continue;
        }

        if (modifier.agentType) {
          await this.clearSelectedSession(chatId);
        }

        await this.createAndDispatchCard(token, {
          chatId,
          telegramMessageId,
          senderName,
          senderId,
          messageTimestamp,
          text: bodyText,
          agentRuntime: resolvedAgentRuntime,
          agentType: resolvedAgentType,
          model: resolvedModel,
          persistDefaultSelection: Boolean(modifier.agentType),
          projectDir: stickyDefaults.projectDir,
          claudeOptions: stickyDefaults.claudeOptions,
          codexOptions: stickyDefaults.codexOptions,
          sourceContext: `Telegram message from ${senderName} (chat: ${chatId})`,
        });
      }
    } catch {
    } finally {
      this.polling = false;
    }
  }

  private async tryHandleExplicitCommand(token: string, chatId: number, telegramMessageId: string, text: string): Promise<boolean> {
    const { command } = extractTelegramCommand(text);
    if (!command) return false;

    const state = this.options.telegramStateStore
      ? await this.options.telegramStateStore.getChatState(chatId)
      : null;
    const sessions = await this.getSessionsForChat(chatId);
    const context = {
      chatId,
      sessions,
      selectedSessionId: state?.selectedSessionId ?? this.activeSessions.get(chatId)?.sessionId,
      selectedCardId: state?.selectedCardId ?? this.activeSessions.get(chatId)?.cardId,
      defaultAgentRuntime: state?.defaultAgentRuntime,
      defaultAgentType: state?.defaultAgentType,
      defaultModel: state?.defaultModel,
      defaultProjectDir: state?.defaultProjectDir,
      defaultClaudePermissionMode: state?.defaultClaudePermissionMode,
      defaultClaudeDangerouslySkipPermissions: state?.defaultClaudeDangerouslySkipPermissions,
      defaultCodexSandbox: state?.defaultCodexSandbox,
    };
    const result = resolveTelegramCommand(text, context, state?.mode === 'pinned');
    if (!result) return false;

    if (command === '/new_session') {
      await this.resetChatSession(chatId);
      await sendTelegramMessage(token, chatId, result.text);
      return true;
    }

    if (result.type === 'reply') {
      await sendTelegramMessage(token, chatId, result.text);
      return true;
    }

    if (result.type === 'set-defaults') {
      await this.clearSelectedSession(chatId);
      await this.persistStickyDefaults(chatId, {
        agentRuntime: result.agentRuntime,
        agentType: result.agentType,
        model: result.model,
        projectDir: result.projectDir,
        claudePermissionMode: result.claudePermissionMode,
        claudeDangerouslySkipPermissions: result.claudeDangerouslySkipPermissions,
        codexSandbox: result.codexSandbox,
      });
      await sendTelegramMessage(token, chatId, result.text);
      return true;
    }

    if (result.type === 'select-session') {
      this.activeSessions.set(chatId, {
        sessionId: result.sessionId,
        cardId: result.cardId,
        agentRuntime: result.agentRuntime,
        consecutiveFailures: 0,
      });
      if (this.options.telegramStateStore) {
        await this.options.telegramStateStore.upsertChatState(chatId, {
          selectedSessionId: result.sessionId,
          selectedCardId: result.cardId,
          selectedAgentRuntime: result.agentRuntime,
          mode: 'pinned',
          lastReminderAt: new Date().toISOString(),
          lastAcknowledgedAt: new Date().toISOString(),
        });
      }
      await sendTelegramMessage(token, chatId, result.text);
      return true;
    }

    if (result.forceNewSession) {
      await this.clearSelectedSession(chatId);
    }

    await this.createAndDispatchCard(token, {
      chatId,
      telegramMessageId,
      senderName: 'Telegram User',
      text: result.text,
      agentRuntime: result.agentRuntime,
      agentType: result.agentType,
      model: result.model,
      projectDir: result.projectDir,
      claudeOptions: this.buildClaudeOptions(result.claudePermissionMode, result.claudeDangerouslySkipPermissions),
      codexOptions: this.buildCodexOptions(result.codexSandbox),
      persistDefaultSelection: Boolean(result.agentType),
      sourceContext: `Telegram command dispatch from chat ${chatId}`,
    });
    return true;
  }

  private async tryHandleFollowUp(
    token: string,
    chatId: number,
    telegramMessageId: string,
    text: string,
    activeSession: ActiveSession,
    sessionInfo?: TelegramSessionSummary,
  ): Promise<boolean> {
    if (await this.hasTelegramCard(chatId, telegramMessageId)) {
      return true;
    }

    const previousCardId = activeSession.cardId;
    const followUpTitle = this.buildTitle(text);
    const runtime = activeSession.agentRuntime;
    const newCard = await this.store.createCard({
      title: followUpTitle,
      description: text,
      sourceContext: `Telegram follow-up from chat ${chatId}`,
      dispatchType: 'instant',
      originChannel: 'telegram',
      telegramChatId: chatId,
      telegramMessageId,
      telegramReplyStatus: 'pending',
      telegramReplyUpdatedAt: new Date().toISOString(),
      agentRuntime: runtime,
      agentType: runtime === 'opencode' ? sessionInfo?.agentType : undefined,
      model: sessionInfo?.model,
      projectDir: sessionInfo?.projectDir,
      resumeSessionId: activeSession.sessionId,
    });

    activeSession.cardId = newCard.id;

    try {
      if (runtime === 'opencode' && this.followUpFn) {
        await this.store.updateCard(newCard.id, {
          status: 'in_progress',
          sessionId: activeSession.sessionId,
          sessionTitle: sessionInfo?.title,
        });
        trackDispatch(activeSession.sessionId, newCard.id, text);
        await this.followUpFn(activeSession.sessionId, text, {
          agentType: sessionInfo?.agentType,
          model: sessionInfo?.model,
        });
      } else {
        const result = await this.dispatchFn(newCard.id);
        activeSession.sessionId = result.sessionId;
      }
      activeSession.consecutiveFailures = 0;

      if (this.options.telegramStateStore) {
        await this.options.telegramStateStore.upsertChatState(chatId, {
          selectedSessionId: activeSession.sessionId,
          selectedCardId: newCard.id,
          selectedAgentRuntime: activeSession.agentRuntime,
          mode: (await this.options.telegramStateStore.getChatState(chatId))?.mode ?? 'auto',
          lastReminderAt: new Date().toISOString(),
          lastAcknowledgedAt: new Date().toISOString(),
        });
      }

      const summaries = await this.getSessionsForChat(chatId);
      const current = this.findSessionSummary(summaries, activeSession.sessionId, activeSession.agentRuntime);
      await sendTelegramMessage(token, chatId, this.buildFollowUpAck(newCard.id, current, sessionInfo));
      return true;
    } catch {
      clearDispatch(activeSession.sessionId);
      activeSession.cardId = previousCardId;
      activeSession.consecutiveFailures += 1;
      await this.store.deleteCard(newCard.id);
      if (this.options.telegramStateStore) {
        const state = await this.options.telegramStateStore.getChatState(chatId);
        await this.options.telegramStateStore.upsertChatState(chatId, {
          selectedSessionId: activeSession.sessionId,
          selectedCardId: previousCardId,
          selectedAgentRuntime: activeSession.agentRuntime,
          mode: state?.mode ?? 'auto',
          lastAcknowledgedAt: new Date().toISOString(),
        });
      }

      await sendTelegramMessage(token, chatId, this.buildFollowUpFailureAck(sessionInfo, activeSession));
      return true;
    }
  }

  private async createAndDispatchCard(
    token: string,
    input: {
      chatId: number;
      telegramMessageId: string;
      senderName: string;
      senderId?: string;
      messageTimestamp?: string;
      text: string;
      agentRuntime?: AgentRuntime;
      agentType?: string;
      model?: string;
      projectDir?: string;
      claudeOptions?: ClaudeOptions;
      codexOptions?: CodexOptions;
      persistDefaultSelection?: boolean;
      sourceContext: string;
    },
  ): Promise<void> {
    if (await this.hasTelegramCard(input.chatId, input.telegramMessageId)) {
      return;
    }

    const title = this.buildTitle(input.text);
    const resolvedRuntime = input.agentRuntime ?? 'opencode';
    const resolvedModel = this.resolveModelForRuntime(resolvedRuntime, input.model, input.agentType);

    if (input.persistDefaultSelection) {
      await this.persistStickyDefaults(input.chatId, {
        agentRuntime: resolvedRuntime,
        agentType: input.agentType,
        model: resolvedModel,
      });
    }

    const card = await this.store.createCard({
      title,
      description: input.text,
      sourceContext: input.sourceContext,
      dispatchType: 'instant',
      projectDir: input.projectDir,
      originChannel: 'telegram',
      telegramChatId: input.chatId,
      telegramMessageId: input.telegramMessageId,
      telegramSenderId: input.senderId,
      telegramMessageTimestamp: input.messageTimestamp,
      telegramReplyStatus: 'pending',
      telegramReplyUpdatedAt: new Date().toISOString(),
      agentRuntime: resolvedRuntime,
      agentType: resolvedRuntime === 'opencode' ? input.agentType : undefined,
      model: resolvedModel,
      claudeOptions: resolvedRuntime === 'claude' ? input.claudeOptions : undefined,
      codexOptions: resolvedRuntime === 'codex' ? input.codexOptions : undefined,
    });

    try {
      const result = await this.dispatchFn(card.id);
      this.activeSessions.set(input.chatId, {
        sessionId: result.sessionId,
        cardId: card.id,
        agentRuntime: resolvedRuntime,
        consecutiveFailures: 0,
      });

      if (this.options.telegramStateStore) {
        await this.options.telegramStateStore.upsertChatState(input.chatId, {
          selectedSessionId: result.sessionId,
          selectedCardId: card.id,
          selectedAgentRuntime: resolvedRuntime,
          mode: 'auto',
          lastReminderAt: new Date().toISOString(),
          lastAcknowledgedAt: new Date().toISOString(),
        });
      }

      const updatedCard = await this.store.getCard(card.id);
      const summaries = await this.getSessionsForChat(input.chatId);
      const session = this.findSessionSummary(summaries, result.sessionId, resolvedRuntime);
      await sendTelegramMessage(token, input.chatId, this.buildDispatchAck(updatedCard ?? card, result.sessionId, session));
    } catch (dispatchError) {
      await sendTelegramMessage(
        token,
        input.chatId,
        `⚠️ 카드가 등록되었지만 자동 실행에 실패했습니다: ${card.title}\n📋 ID: ${card.id}\nError: ${dispatchError instanceof Error ? dispatchError.message : 'Unknown error'}`,
      );
    }
  }

  private buildDispatchAck(card: { id: string; title: string; agentType?: string; agentRuntime?: AgentRuntime; model?: string; projectDir?: string }, sessionId: string, session?: TelegramSessionSummary): string {
    return [
      '✅ 카드 등록 및 작업 시작',
      `- 카드: ${card.title} (${card.id})`,
      `- 세션: ${session?.index ? `${session.index}. ` : ''}${sessionId}`,
      `- 런타임: ${this.formatRuntime(session?.agentRuntime ?? card.agentRuntime)}`,
      `- 에이전트: ${getPrimaryAgentDisplayLabel(card.agentType) ?? card.agentType ?? 'Default'}`,
      `- 모델: ${card.model ?? 'default'}`,
      `- 경로: ${session?.projectDir ?? card.projectDir ?? 'not set'}`,
      '- 방식: 새 세션 시작',
    ].join('\n');
  }

  private buildFollowUpAck(cardId: string, session?: TelegramSessionSummary, fallback?: TelegramSessionSummary): string {
    const target = session ?? fallback;
    return [
      '✅ 기존 세션에 전달됨',
      `- 카드: ${cardId}`,
      `- 세션: ${target?.index ? `${target.index}. ` : ''}${target?.sessionId ?? 'unknown'}`,
      `- 런타임: ${this.formatRuntime(target?.agentRuntime)}`,
      `- 에이전트: ${getPrimaryAgentDisplayLabel(target?.agentType) ?? target?.agentType ?? 'Default'}`,
      `- 모델: ${target?.model ?? 'default'}`,
      `- 경로: ${target?.projectDir ?? 'not set'}`,
      '- 방식: 후속 메시지',
    ].join('\n');
  }

  private buildFollowUpFailureAck(session: TelegramSessionSummary | undefined, activeSession: ActiveSession): string {
    const target = session ?? {
      sessionId: activeSession.sessionId,
      cardId: activeSession.cardId,
      agentRuntime: activeSession.agentRuntime,
      index: 0,
      title: activeSession.sessionId,
      status: 'in_progress' as const,
      updatedAt: new Date().toISOString(),
    };

    return [
      '⚠️ 현재 세션에 전달하지 못했습니다.',
      `- 세션: ${target.index ? `${target.index}. ` : ''}${target.sessionId}`,
      `- 런타임: ${this.formatRuntime(target.agentRuntime)}`,
      `- 최근 카드: ${target.cardId}`,
      '- 현재 세션 선택은 유지됩니다.',
      '- 필요하면 /new_session 또는 /switch_session 을 사용하세요.',
    ].join('\n');
  }

  private async hasTelegramCard(chatId: number, telegramMessageId: string): Promise<boolean> {
    const cards = await this.store.getCards({ includeArchived: true });
    return cards.some((card) =>
      card.originChannel === 'telegram'
      && card.telegramChatId === chatId
      && card.telegramMessageId === telegramMessageId,
    );
  }

  private buildTitle(text: string): string {
    return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }

  private async getSettingValue(key: string): Promise<string | undefined> {
    const entries = await this.settingsStore.getEntries();
    const entry = entries.find(e => e.key === key);
    return entry?.value;
  }

  private async ensureTelegramCommandsRegistered(token?: string): Promise<void> {
    if (this.commandsRegistered) return;

    const resolvedToken = token ?? await this.getSettingValue('TELEGRAM_BOT_TOKEN');
    if (!resolvedToken) return;

    const commandResult = await setTelegramCommands(resolvedToken, getTelegramRegisteredCommands(), {
      scope: { type: 'all_private_chats' },
      languageCode: 'ko',
    });
    if (!commandResult.ok) {
      return;
    }

    const menuResult = await setTelegramChatMenuButton(resolvedToken, {
      menuButton: { type: 'commands' },
    });
    if (!menuResult.ok) {
      return;
    }

    this.commandsRegistered = true;
  }

  private async isAllowedChat(chatId: number): Promise<boolean> {
    const channelIdsStr = await this.getSettingValue('TELEGRAM_CHANNEL_IDS');
    if (!channelIdsStr) return true;

    const allowedIds = channelIdsStr
      .split(',')
      .map(id => Number.parseInt(id.trim(), 10))
      .filter(id => !Number.isNaN(id));
    if (allowedIds.length === 0) return true;
    return allowedIds.includes(chatId);
  }

  private async resolveSessionForChat(chatId: number): Promise<SessionResolution> {
    const active = this.activeSessions.get(chatId);
    const sessions = await this.getSessionsForChat(chatId);
    if (active) {
      const sessionInfo = this.findSessionSummary(sessions, active.sessionId, active.agentRuntime);
      if (sessionInfo) {
        return { kind: 'active', activeSession: active, sessionInfo };
      }
      const activeCard = await this.store.getCard(active.cardId);
      if (activeCard) {
        return {
          kind: 'active',
          activeSession: active,
          sessionInfo: this.buildFallbackSessionSummary(activeCard, active.sessionId, active.agentRuntime),
        };
      }
      if (!activeCard) {
        return {
          kind: 'invalid',
          sessionId: active.sessionId,
          agentRuntime: active.agentRuntime,
          cardId: active.cardId,
        };
      }
    }
    if (!this.options.telegramStateStore) return { kind: 'none' };

    const state = await this.options.telegramStateStore.getChatState(chatId);
    if (!state?.selectedSessionId) return { kind: 'none' };
    const selected = this.findSessionSummary(sessions, state.selectedSessionId, state.selectedAgentRuntime);
    if (!selected) {
      if (state.selectedCardId) {
        const selectedCard = await this.store.getCard(state.selectedCardId);
        if (selectedCard) {
          const runtime = state.selectedAgentRuntime ?? resolveAgentRuntime(selectedCard);
          const restored: ActiveSession = {
            sessionId: state.selectedSessionId,
            cardId: selectedCard.id,
            agentRuntime: runtime,
            consecutiveFailures: 0,
          };
          this.activeSessions.set(chatId, restored);
          return {
            kind: 'active',
            activeSession: restored,
            sessionInfo: this.buildFallbackSessionSummary(selectedCard, state.selectedSessionId, runtime),
          };
        }
      }
      return {
        kind: 'invalid',
        sessionId: state.selectedSessionId,
        agentRuntime: state.selectedAgentRuntime,
        cardId: state.selectedCardId,
      };
    }

    const restored: ActiveSession = {
      sessionId: selected.sessionId,
      cardId: selected.cardId,
      agentRuntime: selected.agentRuntime,
      consecutiveFailures: 0,
    };
    this.activeSessions.set(chatId, restored);
    return { kind: 'active', activeSession: restored, sessionInfo: selected };
  }

  private async getSessionSummaryBySessionId(
    chatId: number,
    sessionId: string,
    agentRuntime?: AgentRuntime,
  ): Promise<TelegramSessionSummary | undefined> {
    const sessions = await this.getSessionsForChat(chatId);
    return this.findSessionSummary(sessions, sessionId, agentRuntime);
  }

  private async resetChatSession(chatId: number): Promise<void> {
    await this.clearSelectedSession(chatId);
    if (!this.options.telegramStateStore) return;
    await this.options.telegramStateStore.upsertChatState(chatId, {
      lastAcknowledgedAt: new Date().toISOString(),
    });
  }

  private async getStickyDispatchDefaults(chatId: number): Promise<{
    agentRuntime: AgentRuntime;
    agentType?: string;
    model?: string;
    projectDir?: string;
    claudeOptions?: ClaudeOptions;
    codexOptions?: CodexOptions;
  }> {
    const state = this.options.telegramStateStore
      ? await this.options.telegramStateStore.getChatState(chatId)
      : null;
    const agentRuntime = state?.defaultAgentRuntime ?? 'opencode';
    const agentType = state?.defaultAgentType;
    const model = this.resolveModelForRuntime(agentRuntime, state?.defaultModel, agentType);
    return {
      agentRuntime,
      agentType: agentRuntime === 'opencode' ? agentType : undefined,
      model,
      projectDir: state?.defaultProjectDir,
      claudeOptions: this.buildClaudeOptions(
        state?.defaultClaudePermissionMode,
        state?.defaultClaudeDangerouslySkipPermissions,
      ),
      codexOptions: this.buildCodexOptions(state?.defaultCodexSandbox),
    };
  }

  private resolveModelForRuntime(runtime: AgentRuntime, model?: string, agentType?: string): string {
    if (runtime === 'codex') return model && isCodexModelValid(model) ? model : DEFAULT_CODEX_MODEL;
    if (runtime === 'claude') return model && isClaudeModelValid(model) ? model : DEFAULT_CLAUDE_MODEL;
    return getDefaultModelForAgent(agentType) ?? model ?? DEFAULT_PRIMARY_MODEL;
  }

  private buildClaudeOptions(
    permissionMode?: ClaudeOptions['permissionMode'] | null,
    dangerouslySkipPermissions?: boolean | null,
  ): ClaudeOptions | undefined {
    if (permissionMode === undefined && dangerouslySkipPermissions === undefined) return undefined;
    return {
      ...(permissionMode ? { permissionMode } : {}),
      ...(dangerouslySkipPermissions !== undefined && dangerouslySkipPermissions !== null
        ? { dangerouslySkipPermissions }
        : {}),
    };
  }

  private buildCodexOptions(sandbox?: CodexOptions['sandbox'] | null): CodexOptions | undefined {
    if (!sandbox) return undefined;
    return { sandbox };
  }

  private async persistStickyDefaults(
    chatId: number,
    input: {
      agentRuntime?: AgentRuntime;
      agentType?: string | null;
      model?: string | null;
      projectDir?: string | null;
      claudePermissionMode?: ClaudeOptions['permissionMode'] | null;
      claudeDangerouslySkipPermissions?: boolean | null;
      codexSandbox?: CodexOptions['sandbox'] | null;
    },
  ): Promise<void> {
    if (!this.options.telegramStateStore) return;
    await this.options.telegramStateStore.upsertChatState(chatId, {
      ...(input.agentRuntime !== undefined ? { defaultAgentRuntime: input.agentRuntime } : {}),
      ...(input.agentType !== undefined ? { defaultAgentType: input.agentType } : {}),
      ...(input.model !== undefined ? { defaultModel: input.model } : {}),
      ...(input.projectDir !== undefined ? { defaultProjectDir: input.projectDir } : {}),
      ...(input.claudePermissionMode !== undefined ? { defaultClaudePermissionMode: input.claudePermissionMode } : {}),
      ...(input.claudeDangerouslySkipPermissions !== undefined
        ? { defaultClaudeDangerouslySkipPermissions: input.claudeDangerouslySkipPermissions }
        : {}),
      ...(input.codexSandbox !== undefined ? { defaultCodexSandbox: input.codexSandbox } : {}),
      lastAcknowledgedAt: new Date().toISOString(),
    });
  }

  private async clearSelectedSession(chatId: number): Promise<void> {
    this.activeSessions.delete(chatId);
    if (!this.options.telegramStateStore) return;
    await this.options.telegramStateStore.upsertChatState(chatId, {
      selectedSessionId: null,
      selectedCardId: null,
      selectedAgentRuntime: null,
      mode: 'auto',
      lastReminderAt: null,
    });
  }

  private async clearSelectedSessionState(sessionId: string): Promise<void> {
    const states = await this.options.telegramStateStore!.getChatStates();
    for (const state of states) {
      if (state.selectedSessionId !== sessionId) continue;
      await this.options.telegramStateStore!.upsertChatState(state.chatId, {
        selectedSessionId: null,
        selectedCardId: null,
        selectedAgentRuntime: null,
        mode: 'auto',
      });
    }
  }

  private sessionKey(runtime: AgentRuntime, sessionId: string): string {
    return `${runtime}:${sessionId}`;
  }

  private findSessionSummary(
    sessions: TelegramSessionSummary[],
    sessionId: string,
    agentRuntime?: AgentRuntime,
  ): TelegramSessionSummary | undefined {
    if (agentRuntime) {
      return sessions.find(session => session.sessionId === sessionId && session.agentRuntime === agentRuntime);
    }
    return sessions.find(session => session.sessionId === sessionId);
  }

  private buildFallbackSessionSummary(
    card: KanbanCard,
    sessionId: string,
    agentRuntime: AgentRuntime,
  ): TelegramSessionSummary {
    const hasStoredSession = card.sessionId === sessionId && resolveAgentRuntime(card) === agentRuntime;
    return {
      index: 0,
      sessionId,
      cardId: card.id,
      title: card.sessionTitle ?? card.title,
      status: card.status,
      agentRuntime,
      agentType: hasStoredSession ? card.agentType : undefined,
      model: hasStoredSession ? card.model : undefined,
      projectDir: card.projectDir,
      updatedAt: card.updatedAt,
    };
  }

  private buildInvalidSelectedSessionAck(selection: { sessionId: string; agentRuntime?: AgentRuntime; cardId?: string }): string {
    return [
      '⚠️ 선택된 세션을 찾지 못해 후속 메시지를 전달하지 않았습니다.',
      `- 세션: ${selection.sessionId}`,
      `- 런타임: ${this.formatRuntime(selection.agentRuntime)}`,
      selection.cardId ? `- 최근 카드: ${selection.cardId}` : undefined,
      '- 새 세션을 몰래 만들지 않았습니다.',
      '- /new_session 후 다시 보내거나 /sessions 로 세션을 다시 선택하세요.',
    ].filter(Boolean).join('\n');
  }

  private formatRuntime(runtime: AgentRuntime | undefined): string {
    if (runtime === 'codex') return 'Codex';
    if (runtime === 'claude') return 'Claude';
    return 'Opencode';
  }
}
