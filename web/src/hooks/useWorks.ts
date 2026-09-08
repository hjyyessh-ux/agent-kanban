import { useCallback, useEffect, useState } from 'react';
import type {
  Work,
  WorkListEntry,
  CreateWorkInput,
  MergeWorkResponse,
  MoveWorkSessionResponse,
  WorkPatchInput,
  WorkPatchResponse,
  WorkIgnoredSession,
  WorkInboxSession,
  WorkSessionRole,
  WorksConfigDto,
  WorksConfigInput,
  WorkSummaryResponse,
} from '../../../src/core/types';
import {
  fetchWorks,
  fetchWorkInbox,
  createWork as apiCreateWork,
  updateWork as apiUpdateWork,
  deleteWork as apiDeleteWork,
  addWorkSession as apiAddWorkSession,
  addWorkSessionsBatch as apiAddWorkSessionsBatch,
  pruneWorkSessions as apiPruneWorkSessions,
  removeWorkSession as apiRemoveWorkSession,
  moveWorkSession as apiMoveWorkSession,
  mergeWork as apiMergeWork,
  reopenWork as apiReopenWork,
  ignoreWorkSession as apiIgnoreWorkSession,
  fetchIgnoredSessions as apiFetchIgnoredSessions,
  restoreIgnoredSession as apiRestoreIgnoredSession,
  fetchWorksConfig,
  saveWorksConfig as apiSaveWorksConfig,
  generateWorkSummary as apiGenerateWorkSummary,
} from './useWorksApi';
import { useCrudResource } from './useCrudResource';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';
import { requiresDoneConfirm } from '../components/Works/worksAssign';
import { ApiError } from './useWorksApi';

const ERROR_TITLES: Record<string, string> = {
  fetch: 'Works 목록을 불러오지 못했습니다',
  create: 'Work을 만들지 못했습니다',
  update: 'Work 업데이트에 실패했습니다',
  delete: 'Work을 삭제하지 못했습니다',
  assign: '세션 배정에 실패했습니다',
  move: '세션을 옮기지 못했습니다',
  merge: 'Work를 병합하지 못했습니다',
  reopen: 'Work를 다시 열지 못했습니다',
  unlink: '세션 연결을 해제하지 못했습니다',
  ignore: '세션 무시에 실패했습니다',
  restore: '무시한 세션을 복원하지 못했습니다',
};

/**
 * Outcome of a complete/discard request.
 *
 * - `done` — the transition was recorded (the caller may close its dialog).
 * - `declined` — nothing was sent, because the destructive path needs a
 *   confirmation the caller has not obtained.
 * - `blocked` — the server refused (`409`), e.g. a card is still running an
 *   agent. The reason is on the shared Works error alert.
 *
 * A tri-state instead of `void` because the previous contract could not tell
 * "completed" from "declined": the detail dialog chained `.then(() => onClose())`
 * onto it and closed itself on a *cancelled* confirmation, which read exactly
 * like a successful bulk archive.
 */
export type WorkResolveOutcome = 'done' | 'declined' | 'blocked';

/** One session that could not be linked during a bulk assignment. */
export interface BulkAssignFailure {
  sessionId: string;
  message: string;
}

/**
 * Outcome of a multi-session assignment. Partial success is a normal result, not
 * an error: the sessions that linked stay linked and the ones that failed remain
 * in the Inbox, so the caller can keep exactly those selected for a retry.
 */
export interface BulkAssignResult {
  /** The target Work after the last successful link; null if none succeeded. */
  work: Work | null;
  assigned: number;
  failed: BulkAssignFailure[];
}

/**
 * One-line reason for a partly failed bulk assignment. The alert has room for a
 * single sentence, so it leads with the first server message (they are almost
 * always the same cause) and counts the rest.
 */
function describeAssignFailures(failed: BulkAssignFailure[]): string {
  const [first, ...rest] = failed;
  const reason = first?.message ?? 'Failed to assign session';
  return rest.length > 0 ? `${reason} (외 ${rest.length}개 세션도 실패)` : reason;
}

export interface UseWorksResult {
  works: WorkListEntry[];
  loading: boolean;
  error: UiAlert | null;
  /** Unassigned, non-ignored sessions — polled continuously for the tab badge. */
  inbox: WorkInboxSession[];
  inboxCount: number;
  /** Create a new Work seeded from an Inbox session, then link that session. */
  createWorkFromSession: (
    session: WorkInboxSession,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  /**
   * Link a session onto an existing Work (1:N; the server rejects a session that
   * already belongs to a *different* Work). Only `sessionId`/`projectDir` are
   * needed, so this also serves the same-Work re-link that changes a link's role
   * and the "undo" of an unlink — the server's `addSession` refreshes the role
   * instead of duplicating the link.
   */
  linkSessionToWork: (
    workId: string,
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  /**
   * Link several Inbox sessions onto one existing Work, in sequence. Each link
   * is its own request (the server has no batch verb) so a rejected session
   * cannot roll back the ones that already succeeded — the result reports what
   * got through and the shared error alert carries the first failure's reason.
   */
  assignSessionsToWork: (
    workId: string,
    sessions: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>[],
    role?: WorkSessionRole,
  ) => Promise<BulkAssignResult>;
  /**
   * Create one Work for a whole selection: create, then link every session.
   * `projectDir` is the caller's merged view of the selection (unset when the
   * sessions disagree). If not a single session links, the empty Work is rolled
   * back and this rejects — a Work with no sessions only shows up as an empty
   * Timeline bar.
   */
  createWorkFromSessions: (input: {
    sessions: WorkInboxSession[];
    title: string;
    role?: WorkSessionRole;
    projectDir?: string;
  }) => Promise<BulkAssignResult>;
  /**
   * Re-parent a session's link to another Work. Both the source and the target
   * are swapped into the list; when the source lost its last session the server
   * deletes it (`from: null`) and it is dropped from the list too. Rejects with
   * the server's message on `409` (either side already bulk-archived).
   */
  moveSession: (
    sessionId: string,
    input: { toWorkId: string; role?: WorkSessionRole },
  ) => Promise<MoveWorkSessionResponse>;
  /**
   * Split a session out into a brand-new Work: create, then move. There is no
   * single server verb for it, so a failed move rolls the empty Work back
   * (`deleteWork`) rather than leaving a session-less Work behind.
   */
  moveSessionToNewWork: (
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<MoveWorkSessionResponse>;
  /** Unlink a session — non-destructive: the session returns to the Inbox. */
  unlinkSession: (workId: string, sessionId: string) => Promise<Work>;
  /**
   * Drop every link the server has stamped `cardsMissingAt` — its session has no
   * cards left anywhere. Resolves with the removed session ids so the caller can
   * say what went. Never automatic: card deletion is a soft delete.
   */
  pruneWorkSessions: (workId: string) => Promise<string[]>;
  /**
   * Delete a Work outright. Cards stay on the board (and stay archived, if the
   * Work was completed) and its sessions return to the Inbox — which makes this
   * the only way to get a `done` Work's sessions back out for re-triage. The
   * caller confirms first; this only performs the delete. Rejects on failure so
   * the caller can keep its dialog open.
   */
  deleteWork: (workId: string) => Promise<void>;
  /** Persist an Inbox "무시"/"폐기" — the session drops out of the Inbox. */
  ignoreSession: (sessionId: string) => Promise<void>;
  /**
   * The ignore list, with each row's session summary. Read when the tab
   * activates and after every ignore/restore — never polled, because it only
   * changes in response to something the user just did here.
   */
  ignoredSessions: WorkIgnoredSession[];
  /** Take a session off the ignore list; it returns to the Inbox. */
  restoreIgnoredSession: (sessionId: string) => Promise<void>;
  refreshIgnoredSessions: () => Promise<void>;
  /**
   * Mark a Work done. The server flips every card of every linked session to
   * `done` and archives them (which hands them to the wiki pipeline) — an
   * irreversible mass mutation, so it is **only** sent with `confirmed: true`.
   * Called without it while `works.done_confirm` is on (or before the config has
   * loaded), it sends nothing and answers `declined`: a caller that forgot the
   * confirmation dialog gets a no-op, never a silent bulk archive.
   */
  completeWork: (workId: string, options?: { confirmed?: boolean }) => Promise<WorkResolveOutcome>;
  /**
   * Discard a Work — status/resolution only; cards stay on the board. Terminal
   * and un-undoable all the same, so it takes the same confirmation contract as
   * `completeWork`.
   */
  discardWork: (workId: string, options?: { confirmed?: boolean }) => Promise<WorkResolveOutcome>;
  /**
   * Put a terminal Work back to `active`, restoring the cards its completion
   * archived. The one escape from a completed Work that keeps the record —
   * `deleteWork` was the only other way out, and it threw the Work away.
   *
   * Answers the same tri-state as `completeWork`: `'blocked'` is the server's
   * `409` for a Work that is already active (a stale dialog), so the caller
   * keeps its dialog open on the reason instead of closing on a no-op.
   */
  reopenWork: (workId: string) => Promise<WorkResolveOutcome>;
  /**
   * Fold one Work's sessions into another. The source is **kept** as
   * `discarded` / `resolution: 'superseded'` with `supersededByWorkId` pointing
   * at the target, so both are swapped into the list rather than one dropped.
   * Rejects with the server's message on `409` (either side already archived).
   */
  mergeWork: (workId: string, intoWorkId: string) => Promise<MergeWorkResponse>;
  /**
   * Save a Work's human notes. Separate from `summary`, which the Summary LLM
   * overwrites wholesale — that is why a note could not live there. An empty
   * string clears the field.
   */
  updateWorkNotes: (workId: string, notes: string) => Promise<void>;
  /**
   * Re-date a Work (`startedAt` / `resolvedAt`) — what the Timeline's bar-edge
   * drag and the detail dialog's date inputs both call. `resolvedAt: null`
   * clears a planned end. Rejects on a server rejection (e.g. an end before the
   * start) so the caller can show it inline.
   */
  updateWorkDates: (
    workId: string,
    patch: { startedAt?: string; resolvedAt?: string | null },
  ) => Promise<void>;
  /**
   * Rename a Work / re-point its `projectDir` — the detail dialog's inline
   * title and directory edits. Both were only settable at creation time, so a
   * Work seeded from a session's first prompt kept whatever that prompt said
   * forever. Rejects on a server rejection so the caller can show it inline.
   */
  updateWorkMeta: (
    workId: string,
    patch: { title?: string; projectDir?: string },
  ) => Promise<void>;
  /** Works-scoped settings (Summary model, line count, stale_days…); null until loaded. */
  config: WorksConfigDto | null;
  /** Persist a partial works settings update and refresh the local config. */
  saveConfig: (input: WorksConfigInput) => Promise<void>;
  /**
   * Generate/regenerate a Work's Summary via the works.summary_model LLM, then
   * swap the updated Work into the list. Throws on failure so the caller can
   * surface an inline error (the detail dialog does).
   */
  generateSummary: (workId: string) => Promise<WorkSummaryResponse>;
  refreshWorks: () => Promise<void>;
  refreshInbox: () => Promise<void>;
  clearError: () => void;
}

/**
 * Works tab data flow: the Work list uses the shared CRUD resource (polled only
 * while the tab is active), while the Inbox is polled continuously regardless of
 * `active` so the tab badge stays fresh even when another tab is showing. The
 * assign helpers wrap create+link so both the inline panel (card 2) and the
 * assign-all modal (card 3) share one implementation.
 */
export function useWorks(active: boolean): UseWorksResult {
  const resource = useCrudResource<WorkListEntry, CreateWorkInput, WorkPatchInput, UiAlert>({
    enabled: active,
    fetchAll: () => fetchWorks(),
    create: apiCreateWork,
    update: apiUpdateWork,
    remove: apiDeleteWork,
    fallbackMessages: {
      fetch: 'Failed to fetch works',
      create: 'Failed to create work',
      update: 'Failed to update work',
      delete: 'Failed to delete work',
    },
    makeError: (action, message) =>
      createUiAlert(ERROR_TITLES[action] ?? 'Works 오류', message, 'Works 새로고침'),
  });

  const { applyUpdate, reportError, refreshEntries, createEntry, updateEntry, deleteEntry } = resource;

  // Inbox is intentionally not tab-gated: the tab badge needs a live count even
  // when the Works tab is inactive.
  const [inbox, setInbox] = useState<WorkInboxSession[]>([]);
  const refreshInbox = useCallback(async () => {
    try {
      setInbox(await fetchWorkInbox());
    } catch {
      // Keep the last good Inbox on a transient failure; the list poller retries.
    }
  }, []);

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);
  usePolling(refreshInbox, 10000, true);

  const createWorkFromSession = useCallback(async (
    session: WorkInboxSession,
    title: string,
    role?: WorkSessionRole,
  ): Promise<Work> => {
    // createEntry already dispatches CREATE; addSession returns the Work with the
    // link attached, and applyUpdate swaps it in place.
    const created = await createEntry({ title, projectDir: session.projectDir });
    try {
      const linked = await apiAddWorkSession(created.id, {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        role,
      });
      applyUpdate(linked);
      await refreshInbox();
      return linked;
    } catch (err: unknown) {
      reportError('assign', err, 'Failed to assign session');
      throw err;
    }
  }, [createEntry, applyUpdate, reportError, refreshInbox]);

  const linkSessionToWork = useCallback(async (
    workId: string,
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    role?: WorkSessionRole,
  ): Promise<Work> => {
    try {
      const work = await apiAddWorkSession(workId, {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        role,
      });
      applyUpdate(work);
      await refreshInbox();
      return work;
    } catch (err: unknown) {
      reportError('assign', err, 'Failed to assign session');
      throw err;
    }
  }, [applyUpdate, reportError, refreshInbox]);

  const assignSessionsToWork = useCallback(async (
    workId: string,
    sessions: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>[],
    role?: WorkSessionRole,
  ): Promise<BulkAssignResult> => {
    if (sessions.length === 0) return { work: null, assigned: 0, failed: [] };
    // One request for the whole selection. It used to be N sequential POSTs,
    // and every one of them re-read the entire card archive server-side; the
    // batch verb shares a single snapshot. The partial-failure contract is
    // unchanged — that is the server's response shape now, not this loop's.
    try {
      const result = await apiAddWorkSessionsBatch(
        workId,
        sessions.map((session) => ({
          sessionId: session.sessionId,
          projectDir: session.projectDir,
        })),
        role,
      );
      // Only swap the Work in when at least one link landed: on a total failure
      // the server echoes the untouched record, and applying it would bump the
      // list for a change that never happened.
      if (result.linkedSessionIds.length > 0) applyUpdate(result.work);
      await refreshInbox();
      if (result.failed.length > 0) {
        reportError('assign', new Error(describeAssignFailures(result.failed)), 'Failed to assign session');
      }
      return {
        work: result.linkedSessionIds.length > 0 ? result.work : null,
        assigned: result.linkedSessionIds.length,
        failed: result.failed,
      };
    } catch (err: unknown) {
      // The request itself failed (404/503/network) — no session linked.
      const message = err instanceof Error ? err.message : 'Failed to assign session';
      reportError('assign', err, 'Failed to assign session');
      await refreshInbox();
      return {
        work: null,
        assigned: 0,
        failed: sessions.map((session) => ({ sessionId: session.sessionId, message })),
      };
    }
  }, [applyUpdate, refreshInbox, reportError]);

  const pruneWorkSessions = useCallback(async (workId: string): Promise<string[]> => {
    try {
      const result = await apiPruneWorkSessions(workId);
      applyUpdate(result.work);
      return result.removedSessionIds;
    } catch (err: unknown) {
      reportError('unlink', err, 'Failed to prune work sessions');
      throw err;
    }
  }, [applyUpdate, reportError]);

  const createWorkFromSessions = useCallback(async ({
    sessions,
    title,
    role,
    projectDir,
  }: {
    sessions: WorkInboxSession[];
    title: string;
    role?: WorkSessionRole;
    projectDir?: string;
  }): Promise<BulkAssignResult> => {
    const created = await createEntry({ title, projectDir });
    const result = await assignSessionsToWork(created.id, sessions, role);
    if (result.assigned === 0) {
      // Nothing linked — the new Work would linger with no sessions at all.
      await apiDeleteWork(created.id).catch(() => {});
      await refreshEntries();
      throw new Error(result.failed[0]?.message ?? 'Failed to assign sessions');
    }
    return result.work ? result : { ...result, work: created };
  }, [createEntry, assignSessionsToWork, refreshEntries]);

  const moveSession = useCallback(async (
    sessionId: string,
    input: { toWorkId: string; role?: WorkSessionRole },
  ): Promise<MoveWorkSessionResponse> => {
    try {
      const result = await apiMoveWorkSession(sessionId, input);
      applyUpdate(result.to);
      // `from: null` means the source lost its last session and the server
      // deleted it — drop it here too so the list does not show a ghost Work
      // until the next poll.
      if (result.from) applyUpdate(result.from);
      else await refreshEntries();
      // A move never changes Inbox membership, but the undo of an unlink lands
      // here too — keep the Inbox in step either way.
      await refreshInbox();
      return result;
    } catch (err: unknown) {
      reportError('move', err, 'Failed to move session');
      throw err;
    }
  }, [applyUpdate, refreshEntries, refreshInbox, reportError]);

  const moveSessionToNewWork = useCallback(async (
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    title: string,
    role?: WorkSessionRole,
  ): Promise<MoveWorkSessionResponse> => {
    const created = await createEntry({ title, projectDir: session.projectDir });
    try {
      return await moveSession(session.sessionId, { toWorkId: created.id, role });
    } catch (err: unknown) {
      // The new Work would otherwise linger with no sessions at all.
      await apiDeleteWork(created.id).catch(() => {});
      await refreshEntries();
      throw err;
    }
  }, [createEntry, moveSession, refreshEntries]);

  const unlinkSession = useCallback(async (
    workId: string,
    sessionId: string,
  ): Promise<Work> => {
    try {
      const work = await apiRemoveWorkSession(workId, sessionId);
      applyUpdate(work);
      // The session reappears in the Inbox as soon as it belongs to no Work.
      await refreshInbox();
      return work;
    } catch (err: unknown) {
      reportError('unlink', err, 'Failed to unlink session');
      throw err;
    }
  }, [applyUpdate, refreshInbox, reportError]);

  const deleteWork = useCallback(async (workId: string): Promise<void> => {
    // `deleteEntry` reports the failure through the shared error alert and
    // rethrows, so a failed delete leaves the caller's dialog open.
    await deleteEntry(workId);
    // Every session the Work held is unassigned again the moment it is gone.
    await refreshInbox();
  }, [deleteEntry, refreshInbox]);

  // The ignore list is the recovery path for 폐기, so it is kept in step with
  // every ignore/restore rather than polled: the count is shown in the Inbox
  // header and it must not lag behind the action that changed it.
  const [ignoredSessions, setIgnoredSessions] = useState<WorkIgnoredSession[]>([]);
  const refreshIgnoredSessions = useCallback(async () => {
    try {
      setIgnoredSessions(await apiFetchIgnoredSessions());
    } catch {
      // Keep the last good list; the next ignore/restore retries.
    }
  }, []);
  useEffect(() => {
    if (active) void refreshIgnoredSessions();
  }, [active, refreshIgnoredSessions]);

  const ignoreSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await apiIgnoreWorkSession(sessionId);
      await refreshInbox();
      await refreshIgnoredSessions();
    } catch (err: unknown) {
      reportError('ignore', err, 'Failed to ignore session');
      throw err;
    }
  }, [reportError, refreshInbox, refreshIgnoredSessions]);

  const restoreIgnoredSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await apiRestoreIgnoredSession(sessionId);
      await refreshInbox();
      await refreshIgnoredSessions();
    } catch (err: unknown) {
      reportError('restore', err, 'Failed to restore session');
      throw err;
    }
  }, [reportError, refreshInbox, refreshIgnoredSessions]);

  // Works settings — loaded when the tab activates and refreshed after a save.
  const [config, setConfig] = useState<WorksConfigDto | null>(null);
  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await fetchWorksConfig());
    } catch {
      // Keep the last good config; the settings panel stays hidden until loaded.
    }
  }, []);
  useEffect(() => {
    if (active) void refreshConfig();
  }, [active, refreshConfig]);

  /**
   * Send a terminal transition, translating the server's refusal into
   * `blocked`. Everything else (including a transport failure) still rejects, so
   * a caller's dialog stays open on an error it should show.
   */
  const sendResolve = useCallback(async (
    workId: string,
    patch: WorkPatchInput,
  ): Promise<WorkResolveOutcome> => {
    try {
      const result: WorkPatchResponse = await apiUpdateWork(workId, patch);
      applyUpdate(result);
      if (result.sweep?.failed.length) {
        const failure = new Error(`카드 ${result.sweep.archivedCount}개 보관 · ${result.sweep.failed.length}개 실패. ${result.sweep.failed[0].message}`);
        throw failure;
      }
      return 'done';
    } catch (err: unknown) {
      reportError('update', err, 'Work 상태를 변경하지 못했습니다');
      // 409 = the server re-checked and refused (a card is still running, or
      // the Work moved on under an open dialog). The reason is already on the
      // shared error alert; the caller only needs to keep its dialog open.
      if (err instanceof ApiError && err.status === 409) return 'blocked';
      throw err;
    }
  }, [applyUpdate, reportError]);

  const completeWork = useCallback(async (
    workId: string,
    options?: { confirmed?: boolean },
  ): Promise<WorkResolveOutcome> => {
    // The bulk done→archive sweep needs explicit scope confirmation before sending it
    // on the caller's behalf: the confirmation dialog is the only way to get
    // `confirmed`. An unloaded config counts as "confirmation required"
    // (`requiresDoneConfirm`) — reading `config?.doneConfirm` directly used to
    // treat "not loaded yet" as "no prompt needed".
    if (!options?.confirmed && requiresDoneConfirm(config)) return 'declined';
    return sendResolve(workId, { status: 'done', confirmArchive: true });
  }, [sendResolve, config]);

  const discardWork = useCallback(async (
    workId: string,
    options?: { confirmed?: boolean },
  ): Promise<WorkResolveOutcome> => {
    if (!options?.confirmed && requiresDoneConfirm(config)) return 'declined';
    return sendResolve(workId, { status: 'discarded' });
  }, [sendResolve, config]);

  const reopenWork = useCallback(async (workId: string): Promise<WorkResolveOutcome> => {
    try {
      const result = await apiReopenWork(workId);
      applyUpdate(result.work);
      return 'done';
    } catch (err: unknown) {
      // 409 = already active (a stale dialog). Reported like the other terminal
      // transitions so the caller can keep its dialog open on the reason.
      reportError('reopen', err, 'Failed to reopen work');
      if (err instanceof ApiError && err.status === 409) return 'blocked';
      throw err;
    }
  }, [applyUpdate, reportError]);

  const mergeWork = useCallback(async (
    workId: string,
    intoWorkId: string,
  ): Promise<MergeWorkResponse> => {
    try {
      const result = await apiMergeWork(workId, intoWorkId);
      // Both sides changed: the target took the links, the source became
      // `superseded`. It is kept, not deleted, so neither is dropped here.
      applyUpdate(result.to);
      applyUpdate(result.from);
      return result;
    } catch (err: unknown) {
      reportError('merge', err, 'Failed to merge work');
      throw err;
    }
  }, [applyUpdate, reportError]);

  const updateWorkNotes = useCallback(async (
    workId: string,
    notes: string,
  ): Promise<void> => {
    // Notes-only patch: no status change, so a resolved Work can still be
    // annotated. An emptied note clears the field (the server treats `''` and
    // `null` the same way).
    await updateEntry(workId, { notes: notes.length > 0 ? notes : null });
  }, [updateEntry]);

  const updateWorkDates = useCallback(async (
    workId: string,
    patch: { startedAt?: string; resolvedAt?: string | null },
  ): Promise<void> => {
    // Date-only patch: no status change, so none of the completion side effects
    // (bulk done→archive, resolvedAt auto-stamp) are in play. An `active` Work
    // may carry a resolvedAt this way as a *planned* end — completing it later
    // keeps that date instead of stamping the completion moment.
    await updateEntry(workId, patch);
  }, [updateEntry]);

  const updateWorkMeta = useCallback(async (
    workId: string,
    patch: { title?: string; projectDir?: string },
  ): Promise<void> => {
    // Metadata-only patch: no status change, so none of the completion side
    // effects are in play and a resolved Work can still be renamed.
    await updateEntry(workId, patch);
  }, [updateEntry]);

  const saveConfig = useCallback(async (input: WorksConfigInput): Promise<void> => {
    try {
      setConfig(await apiSaveWorksConfig(input));
    } catch (err: unknown) {
      reportError('update', err, 'Failed to save works settings');
      throw err;
    }
  }, [reportError]);

  const generateSummary = useCallback(async (workId: string): Promise<WorkSummaryResponse> => {
    const res = await apiGenerateWorkSummary(workId);
    applyUpdate(res.work);
    return res;
  }, [applyUpdate]);

  return {
    works: resource.entries,
    loading: resource.loading,
    error: resource.error,
    inbox,
    inboxCount: inbox.length,
    createWorkFromSession,
    linkSessionToWork,
    assignSessionsToWork,
    pruneWorkSessions,
    createWorkFromSessions,
    moveSession,
    moveSessionToNewWork,
    unlinkSession,
    deleteWork,
    ignoreSession,
    ignoredSessions,
    restoreIgnoredSession,
    refreshIgnoredSessions,
    completeWork,
    discardWork,
    reopenWork,
    mergeWork,
    updateWorkNotes,
    updateWorkDates,
    updateWorkMeta,
    config,
    saveConfig,
    generateSummary,
    refreshWorks: refreshEntries,
    refreshInbox,
    clearError: resource.clearError,
  };
}
