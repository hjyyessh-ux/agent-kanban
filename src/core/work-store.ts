import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  Work,
  WorkResolution,
  WorkStatus,
  WorkStoreState,
  WorkSessionLink,
  CreateWorkInput,
  UpdateWorkInput,
  AddWorkSessionInput,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';

/** Terminal statuses stamp `resolvedAt` (the end of a Timeline bar). */
const TERMINAL_STATUSES = new Set<WorkStatus>(['done', 'discarded']);

/**
 * Resolution stamped on a terminal transition when the caller does not supply
 * one. `discarded` means the user abandoned the work — the Timeline renders that
 * bar as cut off and greyed out, and the wiki pipeline skips its cards.
 */
const DEFAULT_RESOLUTION: Record<'done' | 'discarded', WorkResolution> = {
  done: 'completed',
  discarded: 'abandoned',
};

/**
 * Persists `Work` entities and the Inbox `ignoredSessionIds` list to
 * `~/.agent-kanban/works.json`. Mirrors `SchedulerStore`: temp-file atomic
 * writes + dual (in-process mutex + cross-process FileLock) locking.
 *
 * Invariant: a session is linked to at most one Work (1:N). Linking a session
 * that already belongs to a *different* Work throws.
 */
export class WorkStore {
  private readonly dataDir: string;
  private readonly worksPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.worksPath = join(this.dataDir, 'works.json');
    this.tmpPath = join(this.dataDir, '.works.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.works.json.lock'));
  }

  /** Dual locking: in-process mutex + cross-process FileLock. */
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

  async load(): Promise<WorkStoreState> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    if (existsSync(this.worksPath)) {
      const content = await Bun.file(this.worksPath).text();
      return this.normalizeState(JSON.parse(content) as WorkStoreState);
    }

    return this.defaultState();
  }

  async save(state: WorkStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.worksPath);
  }

  async getWorks(status?: WorkStatus): Promise<Work[]> {
    const state = await this.load();
    const works = status ? state.works.filter(w => w.status === status) : state.works;
    // Most recently updated first — matches board/session ordering conventions.
    return [...works].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getWork(id: string): Promise<Work | null> {
    const state = await this.load();
    return state.works.find(w => w.id === id) ?? null;
  }

  async createWork(input: CreateWorkInput): Promise<Work> {
    const title = input.title?.trim();
    if (!title) {
      throw new Error('Work title is required');
    }
    const now = new Date().toISOString();
    const sessionLinks = (input.sessionLinks ?? []).map(link => this.normalizeLink(link));

    let created: Work | undefined;
    await this.withDualLock(async () => {
      const state = await this.load();
      // Enforce 1:N across all Works for every initial link.
      for (const link of sessionLinks) {
        this.assertSessionUnlinked(state, link.sessionId, null);
      }
      const work: Work = {
        id: nanoid(),
        title,
        status: 'active',
        sessionLinks,
        projectDir: input.projectDir,
        startedAt: input.startedAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      state.works.push(work);
      state.lastModified = now;
      await this.save(state);
      created = work;
    });

    return created!;
  }

  async updateWork(id: string, input: UpdateWorkInput): Promise<Work> {
    const now = new Date().toISOString();
    let updated: Work | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === id);
      if (index === -1) {
        throw new Error(`Work not found: ${id}`);
      }
      const current = state.works[index];
      const next: Work = { ...current };

      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new Error('Work title is required');
        next.title = title;
      }
      if (input.status !== undefined) next.status = input.status;
      this.applyOptional(next, 'resolution', input.resolution);
      this.applyOptional(next, 'projectDir', input.projectDir);
      if (input.startedAt !== undefined) next.startedAt = input.startedAt;
      this.applyOptional(next, 'resolvedAt', input.resolvedAt);
      this.applyOptional(next, 'summary', input.summary);
      this.applyOptional(next, 'archivedAt', input.archivedAt);

      // Auto-stamp resolvedAt/resolution when moving to a terminal status
      // without explicit values, so the Timeline bar always has an end and the
      // reason a Work closed is always recorded. The card-level side effects
      // (bulk done→archive, wiki grouping) live in `plugin/works/work-lifecycle.ts`.
      if (input.status !== undefined && TERMINAL_STATUSES.has(input.status)) {
        if (input.resolvedAt === undefined && !next.resolvedAt) {
          next.resolvedAt = now;
        }
        if (input.resolution === undefined && !next.resolution) {
          next.resolution = DEFAULT_RESOLUTION[input.status === 'done' ? 'done' : 'discarded'];
        }
      }

      // Re-opening a Work clears the terminal stamps unless the caller set them
      // explicitly — a live bar must not keep an end date in the past.
      if (input.status === 'active') {
        if (input.resolvedAt === undefined) delete next.resolvedAt;
        if (input.resolution === undefined) delete next.resolution;
      }

      // Manual re-dating (Timeline bar-edge drag / detail-dialog date inputs)
      // must not invert the bar. Only checked when the caller actually touched a
      // date, so pre-existing inverted records stay editable back into shape.
      if ((input.startedAt !== undefined || input.resolvedAt !== undefined)
        && next.resolvedAt
        && Date.parse(next.resolvedAt) < Date.parse(next.startedAt)) {
        throw new Error('Work resolvedAt must not precede startedAt');
      }

      next.updatedAt = now;
      state.works[index] = next;
      state.lastModified = now;
      await this.save(state);
      updated = next;
    });

    return updated!;
  }

  async deleteWork(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === id);
      if (index === -1) {
        throw new Error(`Work not found: ${id}`);
      }
      state.works = state.works.filter(w => w.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  /**
   * Links a session to a Work. Idempotent for the same Work (updates
   * role/projectDir). Throws if the session already belongs to another Work
   * (the 1:N invariant).
   */
  async addSession(workId: string, input: AddWorkSessionInput): Promise<Work> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    const now = new Date().toISOString();
    let updated: Work | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === workId);
      if (index === -1) {
        throw new Error(`Work not found: ${workId}`);
      }
      this.assertSessionUnlinked(state, sessionId, workId);

      const work = state.works[index];
      const isFirstLink = work.sessionLinks.length === 0;
      const existing = work.sessionLinks.find(l => l.sessionId === sessionId);
      if (existing) {
        // Same-Work re-link: refresh role/projectDir instead of duplicating.
        existing.role = input.role ?? existing.role;
        existing.projectDir = input.projectDir ?? existing.projectDir;
      } else {
        work.sessionLinks.push(this.normalizeLink({
          sessionId,
          projectDir: input.projectDir,
          role: input.role,
          linkedAt: now,
        }));
      }
      // The first link defines when the Work began: back-date to the session's
      // earliest card `startedAt` when the caller resolved one, otherwise to the
      // link time. Later links never move the Timeline bar's start.
      if (isFirstLink && existing === undefined) {
        work.startedAt = input.startedAt ?? now;
      }
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
      updated = work;
    });

    return updated!;
  }

  async removeSession(workId: string, sessionId: string): Promise<Work> {
    const now = new Date().toISOString();
    let updated: Work | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === workId);
      if (index === -1) {
        throw new Error(`Work not found: ${workId}`);
      }
      const work = state.works[index];
      work.sessionLinks = work.sessionLinks.filter(l => l.sessionId !== sessionId);
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
      updated = work;
    });

    return updated!;
  }

  /** Adds a session to the Inbox ignore list (idempotent). */
  async ignoreSession(sessionId: string): Promise<string[]> {
    const id = sessionId?.trim();
    if (!id) {
      throw new Error('sessionId is required');
    }
    let ignored: string[] = [];

    await this.withDualLock(async () => {
      const state = await this.load();
      if (!state.ignoredSessionIds.includes(id)) {
        state.ignoredSessionIds.push(id);
      }
      state.lastModified = new Date().toISOString();
      await this.save(state);
      ignored = state.ignoredSessionIds;
    });

    return ignored;
  }

  async getIgnoredSessionIds(): Promise<string[]> {
    const state = await this.load();
    return state.ignoredSessionIds;
  }

  /** Throws if `sessionId` is linked to a Work other than `exceptWorkId`. */
  private assertSessionUnlinked(
    state: WorkStoreState,
    sessionId: string,
    exceptWorkId: string | null,
  ): void {
    const owner = state.works.find(
      w => w.id !== exceptWorkId && w.sessionLinks.some(l => l.sessionId === sessionId),
    );
    if (owner) {
      throw new Error(`Session already linked to another work: ${owner.id}`);
    }
  }

  private normalizeLink(link: WorkSessionLink): WorkSessionLink {
    return {
      sessionId: link.sessionId,
      projectDir: link.projectDir,
      linkedAt: link.linkedAt ?? new Date().toISOString(),
      role: link.role,
    };
  }

  /**
   * Applies a nullable optional field with the shared update convention:
   * `undefined` leaves it untouched, `null` clears it, any other value sets it.
   */
  private applyOptional<K extends keyof Work>(
    target: Work,
    key: K,
    value: Work[K] | null | undefined,
  ): void {
    if (value === undefined) return;
    if (value === null) {
      delete target[key];
      return;
    }
    target[key] = value;
  }

  private defaultState(): WorkStoreState {
    return {
      version: 1,
      works: [],
      ignoredSessionIds: [],
      lastModified: new Date().toISOString(),
    };
  }

  private normalizeState(state: WorkStoreState): WorkStoreState {
    return {
      version: 1,
      works: Array.isArray(state.works) ? state.works : [],
      ignoredSessionIds: Array.isArray(state.ignoredSessionIds) ? state.ignoredSessionIds : [],
      lastModified: typeof state.lastModified === 'string'
        ? state.lastModified
        : new Date().toISOString(),
    };
  }
}
