import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DiscoveredSkill, SkillRoot, SkillStoreState, SkillSyncResult } from './types';
import { FileLock } from './filelock';
import { scanSkills } from './skill-scanner';

function resolveDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(homedir(), dir.slice(1));
  }
  return dir;
}

/**
 * Persists skills discovered from disk to `~/.agent-kanban/skills.json`. Mirrors
 * the dual-locking + atomic-write conventions of ScriptStore. The board reads
 * this list to augment the runtime command registry with user-authored skills.
 */
export class SkillStore {
  private readonly dataDir: string;
  private readonly skillsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.skillsPath = join(this.dataDir, 'skills.json');
    this.tmpPath = join(this.dataDir, '.skills.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.skills.json.lock'));
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

  async load(): Promise<SkillStoreState> {
    if (existsSync(this.skillsPath)) {
      try {
        const content = await Bun.file(this.skillsPath).text();
        return JSON.parse(content) as SkillStoreState;
      } catch {
        return this.defaultState();
      }
    }
    return this.defaultState();
  }

  private async save(state: SkillStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.skillsPath);
  }

  async getSkills(): Promise<DiscoveredSkill[]> {
    const state = await this.load();
    return state.skills;
  }

  /**
   * Re-scan the skill directories on disk and replace the persisted list.
   * Pass `roots` (from SkillRootsStore) to scan only enabled user-configured
   * directories; omit to fall back to the built-in defaults.
   */
  async sync(roots?: SkillRoot[]): Promise<SkillSyncResult> {
    const scannerRoots = roots
      ?.filter((r) => r.enabled)
      .map((r) => ({ dir: r.dir, runtime: r.agent, source: r.source }));
    const skills = scanSkills(scannerRoots);
    const lastSyncedAt = new Date().toISOString();

    await this.withDualLock(async () => {
      await this.save({ version: 1, skills, lastSyncedAt });
    });

    return {
      claude: skills.filter((s) => s.runtime === 'claude').length,
      codex: skills.filter((s) => s.runtime === 'codex').length,
      opencode: skills.filter((s) => s.runtime === 'opencode').length,
      total: skills.length,
      lastSyncedAt,
    };
  }

  private defaultState(): SkillStoreState {
    return {
      version: 1,
      skills: [],
      lastSyncedAt: new Date(0).toISOString(),
    };
  }
}
