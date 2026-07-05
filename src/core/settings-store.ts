import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  SettingsEntry,
  SettingsStoreState,
  CreateSettingsInput,
  UpdateSettingsInput,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

export class SettingsStore {
  private readonly dataDir: string;
  private readonly settingsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.tmpPath = join(this.dataDir, '.settings.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.settings.json.lock'));
  }

  /**
   * Dual locking: in-process mutex + cross-process FileLock.
   */
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

  async load(): Promise<SettingsStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    if (existsSync(this.settingsPath)) {
      const content = await Bun.file(this.settingsPath).text();
      return JSON.parse(content) as SettingsStoreState;
    }

    return this.defaultState();
  }

  async save(state: SettingsStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.settingsPath);
  }

  async createEntry(input: CreateSettingsInput): Promise<SettingsEntry> {
    const now = new Date().toISOString();
    const entry: SettingsEntry = {
      id: nanoid(),
      key: input.key,
      value: input.value,
      description: input.description,
      category: input.category,
      masked: input.masked ?? true,
      createdAt: now,
      updatedAt: now,
    };

    await this.withDualLock(async () => {
      const state = await this.load();
      state.entries.push(entry);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });

    return entry;
  }

  async updateEntry(id: string, input: UpdateSettingsInput): Promise<SettingsEntry> {
    const now = new Date().toISOString();
    let updatedEntry: SettingsEntry | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Settings entry not found: ${id}`);
      }
      state.entries[index] = {
        ...state.entries[index],
        ...input,
        updatedAt: now,
      };
      state.lastModified = now;
      await this.save(state);
      updatedEntry = state.entries[index];
    });

    return updatedEntry!;
  }

  async upsertByKey(
    key: string,
    value: string,
    opts?: { description?: string; category?: string; masked?: boolean },
  ): Promise<SettingsEntry> {
    const now = new Date().toISOString();
    let upsertedEntry: SettingsEntry | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const existing = state.entries.find(entry => entry.key === key);

      if (existing) {
        existing.value = value;
        existing.description = opts?.description ?? existing.description;
        existing.category = opts?.category ?? existing.category;
        existing.masked = opts?.masked ?? existing.masked;
        existing.updatedAt = now;
        upsertedEntry = existing;
      } else {
        upsertedEntry = {
          id: nanoid(),
          key,
          value,
          description: opts?.description ?? key,
          category: opts?.category,
          masked: opts?.masked ?? false,
          createdAt: now,
          updatedAt: now,
        };
        state.entries.push(upsertedEntry);
      }

      state.lastModified = now;
      await this.save(state);
    });

    return upsertedEntry!;
  }

  async deleteEntry(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Settings entry not found: ${id}`);
      }
      state.entries = state.entries.filter(e => e.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async getEntry(id: string): Promise<SettingsEntry | null> {
    const state = await this.load();
    return state.entries.find(e => e.id === id) ?? null;
  }

  async getEntries(): Promise<SettingsEntry[]> {
    const state = await this.load();
    return state.entries;
  }

  private defaultState(): SettingsStoreState {
    return {
      version: 1,
      entries: [],
      lastModified: new Date().toISOString(),
    };
  }
}

export async function getSettingValueOrDefault(
  settingsStore: SettingsStore,
  key: string,
  defaultValue: string,
): Promise<string> {
  const entries = await settingsStore.getEntries();
  return entries.find(entry => entry.key === key)?.value ?? defaultValue;
}
