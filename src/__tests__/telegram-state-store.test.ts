import { describe, expect, test } from 'bun:test';
import { TelegramStateStore } from '../core/telegram-state-store';
import { withTempDir } from './setup';

describe('TelegramStateStore', () => {
  test('upsertChatState creates and persists chat state', async () => {
    await withTempDir(async (dir) => {
      const store = new TelegramStateStore(dir);

      await store.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: 'card-1',
        selectedAgentRuntime: 'claude',
        mode: 'pinned',
      });

      const loaded = await store.getChatState(12345);
      expect(loaded).not.toBeNull();
      expect(loaded!.selectedSessionId).toBe('ses-1');
      expect(loaded!.selectedCardId).toBe('card-1');
      expect(loaded!.selectedAgentRuntime).toBe('claude');
      expect(loaded!.mode).toBe('pinned');
    });
  });

  test('upsertChatState clears nullable fields with null', async () => {
    await withTempDir(async (dir) => {
      const store = new TelegramStateStore(dir);

      await store.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: 'card-1',
        selectedAgentRuntime: 'codex',
        mode: 'pinned',
        lastReminderAt: new Date().toISOString(),
      });

      await store.upsertChatState(12345, {
        selectedSessionId: null,
        selectedCardId: null,
        selectedAgentRuntime: null,
        lastReminderAt: null,
        mode: 'auto',
      });

      const loaded = await store.getChatState(12345);
      expect(loaded).not.toBeNull();
      expect(loaded!.selectedSessionId).toBeUndefined();
      expect(loaded!.selectedCardId).toBeUndefined();
      expect(loaded!.selectedAgentRuntime).toBeUndefined();
      expect(loaded!.lastReminderAt).toBeUndefined();
      expect(loaded!.mode).toBe('auto');
    });
  });

  test('upsertChatState persists and clears sticky default agent fields', async () => {
    await withTempDir(async (dir) => {
      const store = new TelegramStateStore(dir);

      await store.upsertChatState(12345, {
        defaultAgentType: 'hephaestus',
        defaultModel: 'github-copilot/gpt-5.4',
        defaultAgentRuntime: 'claude',
      });

      let loaded = await store.getChatState(12345);
      expect(loaded).not.toBeNull();
      expect(loaded!.defaultAgentType).toBe('hephaestus');
      expect(loaded!.defaultModel).toBe('github-copilot/gpt-5.4');
      expect(loaded!.defaultAgentRuntime).toBe('claude');

      await store.upsertChatState(12345, {
        defaultAgentType: null,
        defaultModel: null,
        defaultAgentRuntime: null,
      });

      loaded = await store.getChatState(12345);
      expect(loaded).not.toBeNull();
      expect(loaded!.defaultAgentType).toBeUndefined();
      expect(loaded!.defaultModel).toBeUndefined();
      expect(loaded!.defaultAgentRuntime).toBeUndefined();
    });
  });

  test('clearing selected session preserves sticky default agent fields across reload', async () => {
    await withTempDir(async (dir) => {
      const store = new TelegramStateStore(dir);

      await store.upsertChatState(12345, {
        selectedSessionId: 'ses-1',
        selectedCardId: 'card-1',
        mode: 'pinned',
        defaultAgentType: 'hephaestus',
        defaultModel: 'github-copilot/gpt-5.4',
        defaultAgentRuntime: 'claude',
      });

      await store.upsertChatState(12345, {
        selectedSessionId: null,
        selectedCardId: null,
        selectedAgentRuntime: null,
        mode: 'auto',
      });

      const reloadedStore = new TelegramStateStore(dir);
      const loaded = await reloadedStore.getChatState(12345);

      expect(loaded).not.toBeNull();
      expect(loaded!.selectedSessionId).toBeUndefined();
      expect(loaded!.selectedCardId).toBeUndefined();
      expect(loaded!.mode).toBe('auto');
      expect(loaded!.defaultAgentType).toBe('hephaestus');
      expect(loaded!.defaultModel).toBe('github-copilot/gpt-5.4');
      expect(loaded!.defaultAgentRuntime).toBe('claude');
    });
  });
});
