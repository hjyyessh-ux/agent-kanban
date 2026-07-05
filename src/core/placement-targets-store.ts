import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import type {
  PlacementTarget,
  PlacementTargetsStoreState,
  CreatePlacementTargetInput,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const BUILTIN_USER_ID = 'builtin-user';
const BUILTIN_COLD_ID = 'builtin-cold';

function builtinTargets(): PlacementTarget[] {
  const now = new Date().toISOString();
  return [
    {
      id: BUILTIN_USER_ID,
      label: 'Global (user)',
      dir: expandHome('~/.claude/skills'),
      kind: 'user',
      teamShared: false,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: BUILTIN_COLD_ID,
      label: 'Cold Storage',
      dir: expandHome('~/.agent-kanban/cold-storage'),
      kind: 'cold',
      teamShared: false,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export class PlacementTargetsStore {
  private readonly dataDir: string;
  private readonly targetsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.targetsPath = join(this.dataDir, 'placement-targets.json');
    this.tmpPath = join(this.dataDir, '.placement-targets.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.placement-targets.json.lock'));
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

  async load(): Promise<PlacementTargetsStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    if (existsSync(this.targetsPath)) {
      try {
        const content = await Bun.file(this.targetsPath).text();
        const state = JSON.parse(content) as PlacementTargetsStoreState;
        // Ensure builtins are always present (idempotent seed)
        state.targets = this.ensureBuiltins(state.targets);
        return state;
      } catch {
        return this.defaultState();
      }
    }
    return this.defaultState();
  }

  private async save(state: PlacementTargetsStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.targetsPath);
  }

  private ensureBuiltins(targets: PlacementTarget[]): PlacementTarget[] {
    const builtins = builtinTargets();
    const result = [...targets];
    for (const b of builtins) {
      if (!result.find((t) => t.id === b.id)) {
        result.unshift(b);
      }
    }
    return result;
  }

  async getTargets(): Promise<PlacementTarget[]> {
    const state = await this.load();
    return state.targets;
  }

  async addTarget(input: CreatePlacementTargetInput): Promise<PlacementTarget> {
    const now = new Date().toISOString();
    const target: PlacementTarget = {
      id: nanoid(),
      label: input.label,
      dir: input.dir,
      kind: input.kind,
      teamShared: input.teamShared,
      createdAt: now,
      updatedAt: now,
    };

    await this.withDualLock(async () => {
      const state = await this.load();
      // Deduplicate by dir
      if (state.targets.find((t) => t.dir === input.dir)) {
        throw new Error(`A placement target with dir "${input.dir}" already exists`);
      }
      state.targets.push(target);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });

    return target;
  }

  async removeTarget(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const target = state.targets.find((t) => t.id === id);
      if (!target) throw new Error(`Placement target not found: ${id}`);
      if (target.builtin) throw new Error('Cannot delete a builtin placement target');
      state.targets = state.targets.filter((t) => t.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  private defaultState(): PlacementTargetsStoreState {
    return {
      version: 1,
      targets: builtinTargets(),
      lastModified: new Date().toISOString(),
    };
  }
}
