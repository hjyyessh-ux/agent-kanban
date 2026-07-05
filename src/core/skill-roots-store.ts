import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import type { SkillRoot, SkillRootsStoreState } from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** Well-known roots seeded on first boot. */
function defaultRoots(): SkillRoot[] {
  return [
    { id: 'claude-user',    dir: expandHome('~/.claude/skills'),        agent: 'claude',   source: 'claude-user',   enabled: true },
    { id: 'codex-user',     dir: expandHome('~/.codex/skills'),         agent: 'codex',    source: 'codex-user',    enabled: true },
    { id: 'codex-system',   dir: expandHome('~/.codex/skills/.system'), agent: 'codex',    source: 'codex-system',  enabled: true },
    { id: 'opencode-user',  dir: expandHome('~/.agents/skills'),        agent: 'opencode', source: 'opencode-user', enabled: true },
  ];
}

/**
 * Persists user-configurable skill root directories to
 * `~/.agent-kanban/skill-roots.json`. Mirrors the dual-locking + atomic-write
 * conventions of SettingsStore.
 */
export class SkillRootsStore {
  private readonly dataDir: string;
  private readonly rootsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.rootsPath = join(this.dataDir, 'skill-roots.json');
    this.tmpPath = join(this.dataDir, '.skill-roots.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.skill-roots.json.lock'));
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

  async load(): Promise<SkillRootsStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    if (existsSync(this.rootsPath)) {
      try {
        const content = await Bun.file(this.rootsPath).text();
        return JSON.parse(content) as SkillRootsStoreState;
      } catch {
        return this.defaultState();
      }
    }
    return this.defaultState();
  }

  private async save(state: SkillRootsStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.rootsPath);
  }

  async getRoots(): Promise<SkillRoot[]> {
    const state = await this.load();
    return state.roots;
  }

  async addRoot(input: Omit<SkillRoot, 'id'>): Promise<SkillRoot> {
    const root: SkillRoot = { id: nanoid(), ...input };
    await this.withDualLock(async () => {
      const state = await this.load();
      state.roots.push(root);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
    return root;
  }

  async removeRoot(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const before = state.roots.length;
      state.roots = state.roots.filter((r) => r.id !== id);
      if (state.roots.length === before) {
        throw new Error(`Skill root not found: ${id}`);
      }
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async updateRoot(id: string, patch: Partial<Omit<SkillRoot, 'id'>>): Promise<SkillRoot> {
    let updated: SkillRoot | undefined;
    await this.withDualLock(async () => {
      const state = await this.load();
      const idx = state.roots.findIndex((r) => r.id === id);
      if (idx === -1) throw new Error(`Skill root not found: ${id}`);
      state.roots[idx] = { ...state.roots[idx], ...patch };
      updated = state.roots[idx];
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
    return updated!;
  }

  private defaultState(): SkillRootsStoreState {
    return {
      version: 1,
      roots: defaultRoots(),
      lastModified: new Date().toISOString(),
    };
  }
}
