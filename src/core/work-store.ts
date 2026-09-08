import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  MergeWorkResponse,
  Work,
  WorkListQuery,
  WorkResolution,
  WorkStatus,
  WorkStoreState,
  WorkSessionLink,
  CreateWorkInput,
  UpdateWorkInput,
  AddWorkSessionInput,
  MoveWorkSessionInput,
  MoveWorkSessionResponse,
  WorkPruneSessionsResponse,
} from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';
import { selectWorks } from './work-list';
import {
  WorkDateOrderError,
  WorkMergeTargetError,
  WorkNotFoundError,
  WorkNotMovableError,
  WorkSessionAlreadyLinkedError,
  WorkSessionNotIgnoredError,
  WorkSessionNotLinkedError,
} from './work-errors';

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
 * Resolves a Work's link-derived `startedAt` from its (already updated) link
 * set. Injected by the caller because the store never reads cards, and **run
 * inside the store's lock** by every link-set writer (`addSession`,
 * `removeSession`, `moveSession`, `pruneMissingSessions`) so concurrent link
 * changes cannot each answer `min()` from a link set the other has not made yet.
 * The one implementation is `createWorkStartedAtResolver(cards)` in
 * `plugin/works/work-lifecycle.ts`.
 */
export type WorkStartedAtResolver = (work: Work) => Promise<string> | string;

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

  /**
   * The Work list, filtered and ordered by `selectWorks` (`core/work-list.ts`).
   * An omitted query is "everything, most recently updated first" — the
   * board/session ordering convention this method has always used.
   */
  async getWorks(query?: WorkListQuery): Promise<Work[]> {
    const state = await this.load();
    return selectWorks(state.works, query);
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
    let updated: Work | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === id);
      if (index === -1) {
        throw new WorkNotFoundError(id);
      }
      updated = this.writeUpdate(state, index, input);
      await this.save(state);
    });

    return updated!;
  }

  /**
   * Atomically claim the bulk done→archive sweep for a Work, applying `input`
   * (the `done` transition) and stamping `archivedAt` in the same locked write.
   * Returns `null` when the Work is already stamped — i.e. another caller owns
   * (or already finished) the sweep.
   *
   * This exists because the idempotence guard used to be a `getWork()` read and
   * an `updateWork()` write in **two different lock sections**: two concurrent
   * `done` patches both read "no `archivedAt`", both swept, and the second one's
   * card flips then failed against a board the first had already emptied. The
   * decision and the stamp have to happen under one lock, so the claim *is* the
   * stamp.
   *
   * The consequence is that the stamp now precedes the card sweep rather than
   * following it. `applyWorkPatch` keeps the invariant that a Work never
   * advertises an archive that did not happen by rolling the stamp back
   * (`archivedAt: null`) when the sweep archives nothing — which leaves exactly
   * the retryable Work the old ordering left.
   */
  async claimArchiveSweep(id: string, input: UpdateWorkInput): Promise<Work | null> {
    let claimed: Work | null = null;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === id);
      if (index === -1) {
        throw new WorkNotFoundError(id);
      }
      if (state.works[index].archivedAt) {
        claimed = null;
        return;
      }
      claimed = this.writeUpdate(state, index, {
        ...input,
        archivedAt: new Date().toISOString(),
      });
      await this.save(state);
    });

    return claimed;
  }

  /**
   * Applies an `UpdateWorkInput` onto `state.works[index]` in place and returns
   * the result. Caller must hold the lock and persist afterwards; shared by
   * `updateWork` and `claimArchiveSweep` so the terminal-stamp and date-order
   * rules cannot drift between the two writers.
   */
  private writeUpdate(state: WorkStoreState, index: number, input: UpdateWorkInput): Work {
    const now = new Date().toISOString();
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
    // An emptied note is no note: storing `''` would keep a field in
    // `works.json` that every reader has to treat as absent anyway.
    if (input.notes !== undefined) {
      this.applyOptional(next, 'notes', input.notes === null || input.notes === '' ? null : input.notes);
    }
    this.applyOptional(next, 'supersededByWorkId', input.supersededByWorkId);
    this.applyOptional(next, 'archivedAt', input.archivedAt);
    this.applyOptional(next, 'wikiDocPath', input.wikiDocPath);

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
      throw new WorkDateOrderError();
    }

    next.updatedAt = now;
    state.works[index] = next;
    state.lastModified = now;
    return next;
  }

  async deleteWork(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === id);
      if (index === -1) {
        throw new WorkNotFoundError(id);
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
  async addSession(
    workId: string,
    input: AddWorkSessionInput,
    resolveStartedAt?: WorkStartedAtResolver,
  ): Promise<Work> {
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
        throw new WorkNotFoundError(workId);
      }
      this.assertSessionUnlinked(state, sessionId, workId);

      const work = state.works[index];
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
      // `startedAt` is min() over every linked session's earliest card, so any
      // link can move the Timeline bar's start — linking an older session pulls
      // it left. The store never reads cards, so the caller injects the rule as
      // a resolver; it runs **here, inside the lock**, against the link set this
      // write just produced. Resolving it in the route instead was a TOCTOU:
      // two concurrent links each computed min() over the links they had read
      // before the lock, and the second write clobbered the first's answer.
      if (resolveStartedAt) {
        this.applyRecalculatedStartedAt(work, await resolveStartedAt(work));
      }
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
      updated = work;
    });

    return updated!;
  }

  /**
   * Unlinks a session and recalculates `startedAt` over what remains, through
   * the same in-lock resolver `addSession` takes — dropping the oldest session
   * legitimately pushes the Timeline bar's start later. Omit the resolver to
   * leave the date untouched.
   *
   * Unlinking a session this Work never held is a **no-op that writes nothing**:
   * no date recalculation, no `updatedAt` bump. It used to recalculate anyway,
   * so a `DELETE` aimed at an already-unlinked session overwrote a manually
   * re-dated Work with a derived value it had not asked for.
   */
  async removeSession(
    workId: string,
    sessionId: string,
    resolveStartedAt?: WorkStartedAtResolver,
  ): Promise<Work> {
    const now = new Date().toISOString();
    let updated: Work | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.works.findIndex(w => w.id === workId);
      if (index === -1) {
        throw new WorkNotFoundError(workId);
      }
      const work = state.works[index];
      if (!work.sessionLinks.some(l => l.sessionId === sessionId)) {
        updated = work;
        return;
      }
      work.sessionLinks = work.sessionLinks.filter(l => l.sessionId !== sessionId);
      if (resolveStartedAt) {
        this.applyRecalculatedStartedAt(work, await resolveStartedAt(work));
      }
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
      updated = work;
    });

    return updated!;
  }

  /**
   * Stamps / clears `WorkSessionLink.cardsMissingAt` for one Work in a single
   * locked write. The verdict itself is the caller's — the store never reads
   * cards — and comes from `reconcileWorkSessionLinks`
   * (`plugin/works/work-links.ts`).
   *
   * Returns which links actually changed, so an idempotent re-run reports
   * nothing instead of a full list. A Work whose links are all already correct
   * is not written at all.
   */
  async applyLinkCardPresence(
    workId: string,
    presence: { missing: readonly string[]; present: readonly string[] },
  ): Promise<{ marked: string[]; cleared: string[] }> {
    const missing = new Set(presence.missing);
    const present = new Set(presence.present);
    const marked: string[] = [];
    const cleared: string[] = [];

    await this.withDualLock(async () => {
      const state = await this.load();
      const work = state.works.find(w => w.id === workId);
      if (!work) throw new WorkNotFoundError(workId);
      const now = new Date().toISOString();
      for (const link of work.sessionLinks) {
        if (missing.has(link.sessionId) && !link.cardsMissingAt) {
          link.cardsMissingAt = now;
          marked.push(link.sessionId);
        } else if (present.has(link.sessionId) && link.cardsMissingAt) {
          delete link.cardsMissingAt;
          cleared.push(link.sessionId);
        }
      }
      if (marked.length === 0 && cleared.length === 0) return;
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
    });

    return { marked, cleared };
  }

  /**
   * Drops every link stamped `cardsMissingAt` — the user-driven cleanup behind
   * `POST /api/works/:id/prune-sessions`.
   *
   * The Work is **kept even when this empties it**. `moveSession` deletes a Work
   * it empties because that move is a merge into another Work, with an explicit
   * destination; pruning has no destination, and deleting the record (with its
   * Summary and its Timeline history) as a side effect of a cleanup button
   * would be a bigger action than the one the user pressed. An emptied Work is
   * visible and deletable on its own.
   */
  async pruneMissingSessions(
    workId: string,
    resolveStartedAt?: WorkStartedAtResolver,
  ): Promise<WorkPruneSessionsResponse> {
    let result: WorkPruneSessionsResponse | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const work = state.works.find(w => w.id === workId);
      if (!work) throw new WorkNotFoundError(workId);
      const removedSessionIds = work.sessionLinks
        .filter(l => l.cardsMissingAt)
        .map(l => l.sessionId);
      if (removedSessionIds.length === 0) {
        result = { work, removedSessionIds };
        return;
      }
      const now = new Date().toISOString();
      work.sessionLinks = work.sessionLinks.filter(l => !l.cardsMissingAt);
      if (resolveStartedAt) {
        this.applyRecalculatedStartedAt(work, await resolveStartedAt(work));
      }
      work.updatedAt = now;
      state.lastModified = now;
      await this.save(state);
      result = { work, removedSessionIds };
    });

    return result!;
  }

  /**
   * Re-parents a session's link to `toWorkId`, in one dual-lock transaction:
   * move the link, recalculate both sides' `startedAt`, and delete the source
   * Work when the move took its last session. That last step treats an emptying
   * move as a merge — the response reports `from: null` — because a Work with no
   * sessions is only a bar on the Timeline with nothing under it. The deletion is
   * inlined rather than delegated to `deleteWork`, which would re-enter the lock.
   *
   * Both sides must be un-archived (`archivedAt == null`). A `done` Work's cards
   * have already been swept into the wiki pipeline, so moving a session in or out
   * of it would regroup history that has shipped; `active` ↔ `active` and
   * `discarded` → `active` are fine. The gate is re-checked here instead of
   * trusted from the client because the move dialog can sit open across a status
   * change (Works polls every 10s).
   *
   * `resolveStartedAt` runs inside the lock against each side's post-move link
   * set; omit it to leave both dates untouched.
   */
  async moveSession(
    input: MoveWorkSessionInput,
    resolveStartedAt?: WorkStartedAtResolver,
  ): Promise<MoveWorkSessionResponse> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    const toWorkId = input.toWorkId?.trim();
    if (!toWorkId) {
      throw new Error('toWorkId is required');
    }
    const now = new Date().toISOString();
    let result: MoveWorkSessionResponse | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const target = state.works.find(w => w.id === toWorkId);
      if (!target) {
        throw new WorkNotFoundError(toWorkId);
      }
      const source = state.works.find(w => w.sessionLinks.some(l => l.sessionId === sessionId));
      if (!source) {
        throw new WorkSessionNotLinkedError(sessionId);
      }
      this.assertMovable(source, 'out of');
      this.assertMovable(target, 'into');

      const existing = source.sessionLinks.find(l => l.sessionId === sessionId)!;
      // The link travels rather than being recreated, so `linkedAt` (the
      // `startedAt` fallback for a session with no cards) stays put.
      const moved: WorkSessionLink = { ...existing, role: input.role ?? existing.role };
      const sameWork = source.id === target.id;

      source.sessionLinks = source.sessionLinks.filter(l => l.sessionId !== sessionId);
      // When source and target are the same Work this is the already-filtered
      // array, so re-pushing is just a role refresh — a stale dialog aiming at
      // the current Work must not fail on a no-op.
      target.sessionLinks = target.sessionLinks.filter(l => l.sessionId !== sessionId);
      target.sessionLinks.push(moved);

      if (resolveStartedAt) {
        this.applyRecalculatedStartedAt(target, await resolveStartedAt(target));
        if (!sameWork && source.sessionLinks.length > 0) {
          this.applyRecalculatedStartedAt(source, await resolveStartedAt(source));
        }
      }
      target.updatedAt = now;

      let from: Work | null = target;
      if (!sameWork) {
        from = source;
        if (source.sessionLinks.length === 0) {
          state.works = state.works.filter(w => w.id !== source.id);
          from = null;
        } else {
          source.updatedAt = now;
        }
      }

      state.lastModified = now;
      await this.save(state);
      result = { from, to: target };
    });

    return result!;
  }

  /**
   * Merge `fromWorkId` into `intoWorkId` in one dual-lock transaction: every
   * session link travels to the target, the target's `startedAt` is recomputed
   * against its post-merge link set, and the source is closed as
   * `discarded` / `resolution: 'superseded'` / `supersededByWorkId`.
   *
   * The source is **kept**, unlike the Work `moveSession` empties. That deletion
   * is right for a move — the user aimed one session somewhere and the shell it
   * left behind has nothing under it — but a merge is a statement about the
   * *Work*: its title, its Summary, its notes and its place on the Timeline are
   * the record of a real piece of work, and "these two were the same thing" must
   * not destroy one of them. `supersededByWorkId` is what makes the surviving
   * row point at where the sessions went.
   *
   * A session the target already holds is **skipped, not overwritten**: the
   * target's link (and its role) is the one that survives the merge, so
   * re-parenting the source's copy over it would silently change the record
   * that is being kept. Reported as `skippedSessionIds`.
   *
   * Both sides go through the same `assertMovable` gate as a session move — an
   * archived (or mid-completion) Work has already handed its cards to the wiki
   * pipeline, and regrouping them afterwards rewrites history that shipped.
   */
  async mergeWork(
    fromWorkId: string,
    intoWorkId: string,
    resolveStartedAt?: WorkStartedAtResolver,
  ): Promise<MergeWorkResponse> {
    const sourceId = fromWorkId?.trim();
    const targetId = intoWorkId?.trim();
    if (!sourceId) throw new Error('workId is required');
    if (!targetId) throw new Error('intoWorkId is required');
    if (sourceId === targetId) {
      throw new WorkMergeTargetError('Cannot merge a work into itself');
    }

    const now = new Date().toISOString();
    let result: MergeWorkResponse | undefined;

    await this.withDualLock(async () => {
      const state = await this.load();
      const source = state.works.find(w => w.id === sourceId);
      if (!source) throw new WorkNotFoundError(sourceId);
      const target = state.works.find(w => w.id === targetId);
      if (!target) throw new WorkNotFoundError(targetId);
      this.assertMovable(source, 'out of');
      this.assertMovable(target, 'into');

      const held = new Set(target.sessionLinks.map(link => link.sessionId));
      const movedSessionIds: string[] = [];
      const skippedSessionIds: string[] = [];
      for (const link of source.sessionLinks) {
        if (held.has(link.sessionId)) {
          skippedSessionIds.push(link.sessionId);
          continue;
        }
        // The link travels rather than being recreated, so `linkedAt` (the
        // `startedAt` fallback for a session with no cards) stays put.
        target.sessionLinks.push({ ...link });
        held.add(link.sessionId);
        movedSessionIds.push(link.sessionId);
      }

      source.sessionLinks = [];
      source.status = 'discarded';
      source.resolution = 'superseded';
      source.supersededByWorkId = target.id;
      if (!source.resolvedAt) source.resolvedAt = now;
      source.updatedAt = now;

      if (resolveStartedAt) {
        this.applyRecalculatedStartedAt(target, await resolveStartedAt(target));
      }
      target.updatedAt = now;

      state.lastModified = now;
      await this.save(state);
      result = { from: source, to: target, movedSessionIds, skippedSessionIds };
    });

    return result!;
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

  /**
   * Takes a session back off the Inbox ignore list.
   *
   * The list used to be append-only, which made the Inbox's `폐기` the one
   * action in this domain with no way back: a mistyped shortcut in the assign
   * modal removed a session from every screen for good, recoverable only by
   * hand-editing `works.json`. Restoring is deliberately *not* idempotent —
   * an id that was never ignored throws rather than reporting success, so a
   * stale list in the UI cannot claim to have restored something.
   */
  async unignoreSession(sessionId: string): Promise<string[]> {
    const id = sessionId?.trim();
    if (!id) {
      throw new Error('sessionId is required');
    }
    let ignored: string[] = [];

    await this.withDualLock(async () => {
      const state = await this.load();
      if (!state.ignoredSessionIds.includes(id)) {
        throw new WorkSessionNotIgnoredError(id);
      }
      state.ignoredSessionIds = state.ignoredSessionIds.filter(entry => entry !== id);
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

  /**
   * Writes a link-derived `startedAt`, clamped to `resolvedAt` when the Work has
   * already ended. A recalculation that ran past the end date would invert the
   * Timeline bar, which `updateWork` rejects outright — but a link edit must not
   * fail over a date it merely derives, so the bar collapses to zero width
   * instead. `undefined` (no value resolved) leaves the date untouched.
   */
  private applyRecalculatedStartedAt(work: Work, startedAt: string | undefined): void {
    if (startedAt === undefined) return;
    // Instants are compared as instants, never as strings. Every stored date is
    // normalized to UTC `Z` on the way in, but a lexical `>` would still be the
    // wrong test the moment one is not — `2026-09-01T00:00:00+09:00` sorts after
    // `2026-09-01T00:00:00.000Z` as text while being *earlier* in time, which
    // clamps a start that never needed clamping.
    const clamp = work.resolvedAt !== undefined
      && Date.parse(startedAt) > Date.parse(work.resolvedAt);
    work.startedAt = clamp ? work.resolvedAt! : startedAt;
  }

  /**
   * Throws if a Work has already had its cards bulk-archived — neither end of a
   * move may be archived (see `moveSession`). The message names the Work so the
   * route can hand it to the user verbatim.
   */
  private assertMovable(work: Work, direction: 'out of' | 'into'): void {
    if (work.archivedAt) {
      throw new WorkNotMovableError('archived', direction, work.title);
    }
    // A `done` Work with no `archivedAt` is mid-completion: `works.done_confirm`
    // only *deferred* its sweep, so the archive is still pending and a session
    // moved in or out now would be regrouped against a decision already made.
    // Only reachable through the deferred-confirmation state, which used to slip
    // through this gate entirely because it looks un-archived.
    if (work.status === 'done') {
      throw new WorkNotMovableError('completing', direction, work.title);
    }
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
      throw new WorkSessionAlreadyLinkedError(owner.id);
    }
  }

  private normalizeLink(link: WorkSessionLink): WorkSessionLink {
    return {
      sessionId: link.sessionId,
      projectDir: link.projectDir,
      linkedAt: link.linkedAt ?? new Date().toISOString(),
      role: link.role,
      cardsMissingAt: link.cardsMissingAt,
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
