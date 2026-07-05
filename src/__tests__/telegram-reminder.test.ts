import { describe, expect, mock, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { TelegramStateStore } from '../core/telegram-state-store';
import { TelegramReminderService } from '../plugin/telegram-reminder';
import { withTempDir } from './setup';

async function runReminderTick(service: TelegramReminderService): Promise<void> {
  await service.runOnce();
}

describe('TelegramReminderService', () => {
  const originalFetch = globalThis.fetch;

  test('sends reminder for stale in-progress selected session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const telegramStateStore = new TelegramStateStore(dir);

      const card = await store.createCard({
        title: 'Reminder task',
        description: 'Reminder task',
        telegramChatId: 12345,
        sessionId: 'ses-1',
        sessionTitle: 'Reminder session',
        agentType: 'hephaestus',
        model: 'github-copilot/gpt-5.4',
      });
      await store.updateCard(card.id, {
        status: 'in_progress',
        progressSummary: 'Still working on it',
      });

      await telegramStateStore.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: card.id,
        mode: 'pinned',
        lastReminderAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      });

      const sentMessages: string[] = [];
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        if (init?.body) {
          const body = JSON.parse(init.body as string);
          sentMessages.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const service = new TelegramReminderService(
        store,
        telegramStateStore,
        async () => 'test-token',
        async () => [{
          index: 1,
          sessionId: 'ses-1',
          cardId: card.id,
          title: 'Reminder session',
          status: 'in_progress',
          agentRuntime: 'opencode',
          agentType: 'hephaestus',
          model: 'github-copilot/gpt-5.4',
          updatedAt: new Date().toISOString(),
        }],
      );

      await runReminderTick(service);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('작업 진행 중 리마인드');
      expect(sentMessages[0]).toContain('Hephaestus');
      expect(sentMessages[0]).toContain('github-copilot/gpt-5.4');

      const updated = await telegramStateStore.getChatState(12345);
      expect(updated?.lastReminderAt).toBeTruthy();
    });
  });

  test('does not send reminder before interval elapses', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const telegramStateStore = new TelegramStateStore(dir);

      const card = await store.createCard({
        title: 'Fresh task',
        description: 'Fresh task',
        telegramChatId: 12345,
        sessionId: 'ses-1',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      await telegramStateStore.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: card.id,
        mode: 'pinned',
        lastReminderAt: new Date().toISOString(),
      });

      const sentMessages: string[] = [];
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        if (init?.body) {
          const body = JSON.parse(init.body as string);
          sentMessages.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const service = new TelegramReminderService(
        store,
        telegramStateStore,
        async () => 'test-token',
        async () => [{
          index: 1,
          sessionId: 'ses-1',
          cardId: card.id,
          title: 'Fresh task',
          status: 'in_progress',
          agentRuntime: 'opencode',
          updatedAt: new Date().toISOString(),
        }],
      );

      await runReminderTick(service);
      expect(sentMessages).toHaveLength(0);
    });
  });

  test('notifies failure reason once and stops tracking a failed card reverted to todo', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const telegramStateStore = new TelegramStateStore(dir);

      const card = await store.createCard({
        title: 'Failed task',
        description: 'Failed task',
        telegramChatId: 12345,
        sessionId: 'ses-1',
      });
      await store.updateCard(card.id, {
        status: 'todo',
        progressSummary: '[failed] runId=claude-x exit=1 401',
      });

      await telegramStateStore.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: card.id,
        mode: 'pinned',
        lastReminderAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      });

      const sentMessages: string[] = [];
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        if (init?.body) {
          const body = JSON.parse(init.body as string);
          sentMessages.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const session = {
        index: 1,
        sessionId: 'ses-1',
        cardId: card.id,
        title: 'Failed task',
        status: 'todo' as const,
        agentRuntime: 'claude' as const,
        updatedAt: new Date().toISOString(),
      };

      const service = new TelegramReminderService(
        store,
        telegramStateStore,
        async () => 'test-token',
        async () => [session],
      );

      // 1st tick: failure reason is sent once and tracking is cleared.
      await runReminderTick(service);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('리마인드 트래킹을 중단');
      expect(sentMessages[0]).toContain('[failed] runId=claude-x exit=1 401');

      const afterStop = await telegramStateStore.getChatState(12345);
      expect(afterStop?.selectedSessionId).toBeUndefined();
      expect(afterStop?.lastReminderAt).toBeUndefined();

      // 2nd tick: tracking is already stopped, so nothing more is sent.
      await runReminderTick(service);
      expect(sentMessages).toHaveLength(1);
    });
  });

  test('does not notify or stop tracking for a not-yet-started todo card (no failure marker)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const telegramStateStore = new TelegramStateStore(dir);

      const card = await store.createCard({
        title: 'Queued task',
        description: 'Queued task',
        telegramChatId: 12345,
        sessionId: 'ses-1',
      });
      // todo 상태지만 실패 마커가 없는(아직 시작 전) 카드.

      await telegramStateStore.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: card.id,
        mode: 'pinned',
        lastReminderAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      });

      const sentMessages: string[] = [];
      globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
        if (init?.body) {
          const body = JSON.parse(init.body as string);
          sentMessages.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;

      const service = new TelegramReminderService(
        store,
        telegramStateStore,
        async () => 'test-token',
        async () => [{
          index: 1,
          sessionId: 'ses-1',
          cardId: card.id,
          title: 'Queued task',
          status: 'todo',
          agentRuntime: 'claude',
          updatedAt: new Date().toISOString(),
        }],
      );

      await runReminderTick(service);
      expect(sentMessages).toHaveLength(0);

      // 선택(pinned)은 보존되어야 한다 — 시작되면 다시 추적할 수 있도록.
      const after = await telegramStateStore.getChatState(12345);
      expect(after?.selectedSessionId).toBe('ses-1');
    });
  });

  test('restores global fetch after each test', () => {
    globalThis.fetch = originalFetch;
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
