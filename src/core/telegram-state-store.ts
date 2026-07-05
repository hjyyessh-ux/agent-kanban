import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { TelegramChatState, TelegramStateStoreState, UpdateTelegramChatStateInput } from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

export class TelegramStateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.statePath = join(this.dataDir, 'telegram-state.json');
    this.tmpPath = join(this.dataDir, '.telegram-state.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.telegram-state.json.lock'));
  }

  private async withDualLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this.lockPromise;
    this.lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;

    try {
      return await this.fileLock.withLock(fn);
    } finally {
      release!();
    }
  }

  async load(): Promise<TelegramStateStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    if (existsSync(this.statePath)) {
      const content = await Bun.file(this.statePath).text();
      return JSON.parse(content) as TelegramStateStoreState;
    }

    return this.defaultState();
  }

  async save(state: TelegramStateStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.statePath);
  }

  async getChatState(chatId: number): Promise<TelegramChatState | null> {
    const state = await this.load();
    return state.entries.find(entry => entry.chatId === chatId) ?? null;
  }

  async getChatStates(): Promise<TelegramChatState[]> {
    const state = await this.load();
    return state.entries;
  }

  async upsertChatState(chatId: number, input: UpdateTelegramChatStateInput): Promise<TelegramChatState> {
    const now = new Date().toISOString();
    let updatedEntry: TelegramChatState | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(entry => entry.chatId === chatId);
      const base: TelegramChatState = index >= 0
        ? state.entries[index]
        : {
            chatId,
            mode: 'auto',
            updatedAt: now,
          };

      const next: TelegramChatState = {
        ...base,
        updatedAt: now,
      };

      if (input.mode !== undefined) next.mode = input.mode;
      if (input.selectedSessionId === null) delete next.selectedSessionId;
      else if (input.selectedSessionId !== undefined) next.selectedSessionId = input.selectedSessionId;

      if (input.selectedCardId === null) delete next.selectedCardId;
      else if (input.selectedCardId !== undefined) next.selectedCardId = input.selectedCardId;

      if (input.selectedAgentRuntime === null) delete next.selectedAgentRuntime;
      else if (input.selectedAgentRuntime !== undefined) next.selectedAgentRuntime = input.selectedAgentRuntime;

      if (input.defaultAgentType === null) delete next.defaultAgentType;
      else if (input.defaultAgentType !== undefined) next.defaultAgentType = input.defaultAgentType;

      if (input.defaultModel === null) delete next.defaultModel;
      else if (input.defaultModel !== undefined) next.defaultModel = input.defaultModel;

      if (input.defaultAgentRuntime === null) delete next.defaultAgentRuntime;
      else if (input.defaultAgentRuntime !== undefined) next.defaultAgentRuntime = input.defaultAgentRuntime;

      if (input.defaultProjectDir === null) delete next.defaultProjectDir;
      else if (input.defaultProjectDir !== undefined) next.defaultProjectDir = input.defaultProjectDir;

      if (input.defaultClaudePermissionMode === null) delete next.defaultClaudePermissionMode;
      else if (input.defaultClaudePermissionMode !== undefined) next.defaultClaudePermissionMode = input.defaultClaudePermissionMode;

      if (input.defaultClaudeDangerouslySkipPermissions === null) delete next.defaultClaudeDangerouslySkipPermissions;
      else if (input.defaultClaudeDangerouslySkipPermissions !== undefined) {
        next.defaultClaudeDangerouslySkipPermissions = input.defaultClaudeDangerouslySkipPermissions;
      }

      if (input.defaultCodexSandbox === null) delete next.defaultCodexSandbox;
      else if (input.defaultCodexSandbox !== undefined) next.defaultCodexSandbox = input.defaultCodexSandbox;

      if (input.lastReminderAt === null) delete next.lastReminderAt;
      else if (input.lastReminderAt !== undefined) next.lastReminderAt = input.lastReminderAt;

      if (input.lastAcknowledgedAt === null) delete next.lastAcknowledgedAt;
      else if (input.lastAcknowledgedAt !== undefined) next.lastAcknowledgedAt = input.lastAcknowledgedAt;

      if (index >= 0) state.entries[index] = next;
      else state.entries.push(next);

      state.lastModified = now;
      await this.save(state);
      updatedEntry = next;
    });

    return updatedEntry!;
  }

  async clearChatState(chatId: number): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      state.entries = state.entries.filter(entry => entry.chatId !== chatId);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  private defaultState(): TelegramStateStoreState {
    return {
      version: 1,
      entries: [],
      lastModified: new Date().toISOString(),
    };
  }
}
