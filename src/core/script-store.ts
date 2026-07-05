import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  ScriptEntry,
  ScriptStoreState,
  ScriptRun,
  ScriptSyncResult,
  CreateScriptInput,
  UpdateScriptInput,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

const MAX_HISTORY = 20;
const MAX_OUTPUT_BYTES = 8192; // 8KB cap for stdout/stderr

function capOutput(output: string | undefined): string | undefined {
  if (!output) return output;
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return output.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)';
}

const LANGUAGE_MAP: Record<string, string> = {
  '.sh': 'bash',
  '.bash': 'bash',
  '.ts': 'typescript',
  '.js': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.zsh': 'bash',
};

export class ScriptStore {
  private readonly dataDir: string;
  private readonly scriptsPath: string;
  private readonly sourceScriptsDir: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.scriptsPath = join(this.dataDir, 'scripts.json');
    this.sourceScriptsDir = join(this.dataDir, 'scripts');
    this.tmpPath = join(this.dataDir, '.scripts.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.scripts.json.lock'));
  }

  get scriptsDir(): string | undefined {
    return this.sourceScriptsDir;
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

  async load(): Promise<ScriptStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    if (existsSync(this.scriptsPath)) {
      const content = await Bun.file(this.scriptsPath).text();
      return JSON.parse(content) as ScriptStoreState;
    }

    return this.defaultState();
  }

  async save(state: ScriptStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.scriptsPath);
  }

  async createEntry(input: CreateScriptInput): Promise<ScriptEntry> {
    const now = new Date().toISOString();
    const entry: ScriptEntry = {
      id: nanoid(),
      name: input.name,
      description: input.description,
      content: input.content,
      language: input.language ?? 'bash',
      projectDir: input.projectDir,
      history: [],
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

  async updateEntry(id: string, input: UpdateScriptInput): Promise<ScriptEntry> {
    const now = new Date().toISOString();
    let updatedEntry: ScriptEntry | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Script entry not found: ${id}`);
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

  async deleteEntry(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === id);
      if (index === -1) {
        throw new Error(`Script entry not found: ${id}`);
      }
      state.entries = state.entries.filter(e => e.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async getEntry(id: string): Promise<ScriptEntry | null> {
    const state = await this.load();
    return state.entries.find(e => e.id === id) ?? null;
  }

  async getEntries(): Promise<ScriptEntry[]> {
    const state = await this.load();
    return state.entries;
  }

  async addRun(scriptId: string, run: ScriptRun): Promise<void> {
    // Cap stdout/stderr
    const cappedRun: ScriptRun = {
      ...run,
      stdout: capOutput(run.stdout),
      stderr: capOutput(run.stderr),
    };

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex(e => e.id === scriptId);
      if (index === -1) return; // silently skip if entry was deleted

      const entry = state.entries[index];
      // Prepend (most recent first), cap at MAX_HISTORY
      entry.history = [cappedRun, ...entry.history].slice(0, MAX_HISTORY);
      entry.lastRunAt = cappedRun.startedAt;
      if (cappedRun.status !== 'running') {
        entry.lastRunStatus = cappedRun.status;
      }
      entry.updatedAt = new Date().toISOString();
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async getHistory(id: string): Promise<ScriptRun[]> {
    const state = await this.load();
    const entry = state.entries.find(e => e.id === id);
    return entry?.history ?? [];
  }

  private defaultState(): ScriptStoreState {
    return {
      version: 1,
      entries: [],
      lastModified: new Date().toISOString(),
    };
  }

  /**
   * Sync script files from a directory into the store.
   * Creates new entries for files not yet tracked, updates content for changed files.
   * Removes file-synced entries whose backing files no longer exist.
   * File-synced entries are identified by description matching "Synced from scripts/".
   */
  async syncFromDirectory(_scriptsDir?: string): Promise<ScriptSyncResult> {
    const scriptsDir = this.sourceScriptsDir;
    if (!existsSync(scriptsDir)) {
      mkdirSync(scriptsDir, { recursive: true });
      return { created: 0, updated: 0, removed: 0 };
    }

    const files = readdirSync(scriptsDir).filter(f => {
      const ext = extname(f).toLowerCase();
      return ext in LANGUAGE_MAP;
    });

    let created = 0;
    let updated = 0;
    let removed = 0;

    await this.withDualLock(async () => {
      const state = await this.load();
      const now = new Date().toISOString();
      const fileNames = new Set(files.map(f => basename(f, extname(f).toLowerCase())));

      // Remove file-synced entries whose backing files are gone
      const toRemove = state.entries.filter(e =>
        e.description.startsWith('Synced from data scripts/') && !fileNames.has(e.name)
      );
      if (toRemove.length > 0) {
        const removeIds = new Set(toRemove.map(e => e.id));
        state.entries = state.entries.filter(e => !removeIds.has(e.id));
        removed = toRemove.length;
      }

      // Create new / update changed entries
      for (const filename of files) {
        const filePath = join(scriptsDir, filename);
        const content = await Bun.file(filePath).text();
        const ext = extname(filename).toLowerCase();
        const name = basename(filename, ext);
        const language = LANGUAGE_MAP[ext] ?? 'bash';

        // Match by name (filename without extension)
        const existing = state.entries.find(e => e.name === name);

        if (existing) {
          // Update only if content changed
          if (existing.content !== content) {
            existing.content = content;
            existing.language = language;
            existing.description = `Synced from data scripts/${filename}`;
            existing.updatedAt = now;
            updated++;
          }
        } else {
          state.entries.push({
            id: nanoid(),
            name,
            description: `Synced from data scripts/${filename}`,
            content,
            language,
            history: [],
            createdAt: now,
            updatedAt: now,
          });
          created++;
        }
      }

      if (created > 0 || updated > 0 || removed > 0) {
        state.lastModified = now;
        await this.save(state);
      }
    });

    return { created, updated, removed };
  }
}
