import type { KanbanStore } from '../core/store';
import type { TelegramStateStore } from '../core/telegram-state-store';
import { sendTelegramMessage } from './telegram-notifier';
import type { TelegramSessionSummary } from './telegram-commands';
import { getPrimaryAgentDisplayLabel } from '../core/agent-config';

const CHECK_INTERVAL_MS = 60_000;
const REMINDER_INTERVAL_MS = 3 * 60_000;

export class TelegramReminderService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: KanbanStore,
    private readonly telegramStateStore: TelegramStateStore,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly getSessionsForChat: (chatId: number) => Promise<TelegramSessionSummary[]>,
  ) {}

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.runOnce().catch(() => {});
    }, CHECK_INTERVAL_MS);

    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async runOnce(): Promise<void> {
    const token = await this.getToken();
    if (!token) return;

    const states = await this.telegramStateStore.getChatStates();
    const now = Date.now();

    for (const state of states) {
      if (!state.selectedSessionId) continue;

      const sessions = await this.getSessionsForChat(state.chatId);
      const session = sessions.find(item => item.sessionId === state.selectedSessionId);
      if (!session) continue;

      const card = await this.store.getCard(session.cardId);
      if (!card) continue;

      // 진행 중 리마인드는 실제로 실행 중인(`in_progress`) 세션만 대상으로 한다.
      if (card.status !== 'in_progress') {
        // 실패해서 `todo`로 되돌아간 카드는 사유를 한 번 알리고 트래킹을 중단한다.
        // `complete`/`done`/아직 시작 안 한 카드는 조용히 넘어가 선택(pinned)을 보존한다.
        if (this.isFailedRevert(card)) {
          await this.notifyTrackingStopped(token, state.chatId, card);
        }
        continue;
      }

      const lastReminder = state.lastReminderAt ? new Date(state.lastReminderAt).getTime() : 0;
      if (lastReminder && now - lastReminder < REMINDER_INTERVAL_MS) continue;

      const lines = [
        '⏳ 작업 진행 중 리마인드',
        `- 카드: ${card.title} (${card.id})`,
        `- 세션: ${session.index}. ${session.title}`,
        `- 에이전트: ${getPrimaryAgentDisplayLabel(card.agentType) ?? card.agentType ?? 'Default'}`,
        `- 모델: ${card.model ?? 'default'}`,
        `- 상태: ${card.status}`,
      ];

      if (card.progressSummary) {
        lines.push('', `최근 진행:\n${card.progressSummary.slice(0, 500)}`);
      }

      const result = await sendTelegramMessage(token, state.chatId, lines.join('\n'));
      if (!result.ok) continue;

      await this.telegramStateStore.upsertChatState(state.chatId, {
        selectedSessionId: state.selectedSessionId,
        selectedCardId: state.selectedCardId ?? null,
        mode: state.mode,
        lastReminderAt: new Date().toISOString(),
      });
    }
  }

  // 런타임 어댑터는 실행 실패/중단 시 카드를 `todo`로 되돌리고 progressSummary에
  // `[failed] ...` 또는 `[aborted] ...` 마커를 남긴다(claude/codex/opencode adapter 공통).
  private isFailedRevert(card: { status: string; progressSummary?: string }): boolean {
    if (card.status !== 'todo') return false;
    const summary = card.progressSummary?.trim() ?? '';
    return /^\[(failed|aborted)\]/i.test(summary);
  }

  private async notifyTrackingStopped(
    token: string,
    chatId: number,
    card: { id: string; title: string; status: string; progressSummary?: string },
  ): Promise<void> {
    const reason = card.progressSummary?.trim() || '실행이 실패로 종료되었습니다.';
    const lines = [
      '🛑 작업이 진행 중이 아니어서 리마인드 트래킹을 중단합니다',
      `- 카드: ${card.title} (${card.id})`,
      `- 상태: ${card.status}`,
      '',
      `실패/중단 사유:\n${reason.slice(0, 500)}`,
      '',
      '다시 추적하려면 새 작업을 보내거나 /switch_session 으로 진행 중 세션을 선택하세요.',
    ];

    const result = await sendTelegramMessage(token, chatId, lines.join('\n'));
    if (!result.ok) return;

    // 트래킹 중단: 선택된 세션/카드와 리마인드 타임스탬프를 비운다.
    // 전송이 성공한 뒤에만 비워서, 실패하면 다음 tick에 재시도되도록 한다.
    await this.telegramStateStore.upsertChatState(chatId, {
      selectedSessionId: null,
      selectedCardId: null,
      lastReminderAt: null,
    });
  }
}
