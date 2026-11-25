import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';
import { readPromptModelRef, type PromptModelRef } from './prompt-proposal';

/**
 * Local refinement preference: only the default refinement `{provider, model}`.
 * Lives in `<data dir>/prompt-refinement-prefs.json`, separate from the card
 * Model Visibility filter and from SettingsStore (so it never shows up as an
 * editable raw setting). No credential, endpoint or prompt text is stored here.
 * The value is re-validated against the live server catalog on every read, so a
 * stale entry can never make an unavailable model selectable.
 */
export interface PromptRefinementPrefs {
  getDefault(): Promise<PromptModelRef | null>;
  setDefault(ref: PromptModelRef | null): Promise<void>;
}

export class PromptRefinementPrefsStore implements PromptRefinementPrefs {
  private readonly dataDir: string;
  private readonly path: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.path = join(this.dataDir, 'prompt-refinement-prefs.json');
    this.tmpPath = join(this.dataDir, '.prompt-refinement-prefs.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.prompt-refinement-prefs.json.lock'));
  }

  private async withDualLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this.lockPromise;
    this.lockPromise = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try { return await this.fileLock.withLock(fn); } finally { release!(); }
  }

  async getDefault(): Promise<PromptModelRef | null> {
    if (!existsSync(this.path)) return null;
    try {
      const data = JSON.parse(await Bun.file(this.path).text()) as { defaultModel?: unknown };
      return data.defaultModel == null ? null : readPromptModelRef(data.defaultModel);
    } catch {
      return null; // corrupt/foreign content is ignored, never trusted
    }
  }

  async setDefault(ref: PromptModelRef | null): Promise<void> {
    const value = ref === null ? null : readPromptModelRef(ref);
    await this.withDualLock(async () => {
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      await Bun.write(this.tmpPath, JSON.stringify({ version: 1, defaultModel: value, updatedAt: new Date().toISOString() }, null, 2));
      chmodSync(this.tmpPath, 0o600);
      renameSync(this.tmpPath, this.path);
    });
  }
}
