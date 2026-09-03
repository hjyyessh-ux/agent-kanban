import { useCallback, useEffect, useState } from 'react';
import type {
  Work,
  CreateWorkInput,
  WorkPatchInput,
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
  ignoreWorkSession as apiIgnoreWorkSession,
  fetchWorksConfig,
  saveWorksConfig as apiSaveWorksConfig,
  generateWorkSummary as apiGenerateWorkSummary,
} from './useWorksApi';
import { useCrudResource } from './useCrudResource';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';

const ERROR_TITLES: Record<string, string> = {
  fetch: 'Works 목록을 불러오지 못했습니다',
  create: 'Work을 만들지 못했습니다',
  update: 'Work 업데이트에 실패했습니다',
  delete: 'Work을 삭제하지 못했습니다',
  assign: '세션 배정에 실패했습니다',
  ignore: '세션 무시에 실패했습니다',
};

export interface UseWorksResult {
  works: Work[];
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
  /** Link an Inbox session onto an existing Work (1:N; server rejects re-links). */
  linkSessionToWork: (
    workId: string,
    session: WorkInboxSession,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  /** Persist an Inbox "무시"/"폐기" — the session drops out of the Inbox. */
  ignoreSession: (sessionId: string) => Promise<void>;
  /**
   * Mark a Work done. The server flips every card of every linked session to
   * `done` and archives them (which hands them to the wiki pipeline). Resolves
   * without a PATCH when `works.done_confirm` is on and the user declines.
   */
  completeWork: (workId: string) => Promise<void>;
  /** Discard a Work — status/resolution only; cards stay on the board. */
  discardWork: (workId: string) => Promise<void>;
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
  const resource = useCrudResource<Work, CreateWorkInput, WorkPatchInput, UiAlert>({
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

  const { applyUpdate, reportError, refreshEntries, createEntry, updateEntry } = resource;

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
    session: WorkInboxSession,
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

  const ignoreSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await apiIgnoreWorkSession(sessionId);
      await refreshInbox();
    } catch (err: unknown) {
      reportError('ignore', err, 'Failed to ignore session');
      throw err;
    }
  }, [reportError, refreshInbox]);

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

  const completeWork = useCallback(async (workId: string): Promise<void> => {
    // The bulk done→archive sweep is destructive, so the server runs it only
    // for a client that says it confirmed. `works.done_confirm` turns that into
    // a real prompt; confirming here (rather than in each component) keeps the
    // list row and the detail dialog on one implementation.
    if (config?.doneConfirm
      && !window.confirm('이 Work의 산하 카드를 일괄 done 처리한 뒤 archive합니다. 계속하시겠습니까?')) {
      return;
    }
    await updateEntry(workId, { status: 'done', confirmArchive: true });
  }, [updateEntry, config]);

  const discardWork = useCallback(async (workId: string): Promise<void> => {
    await updateEntry(workId, { status: 'discarded' });
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
    ignoreSession,
    completeWork,
    discardWork,
    updateWorkDates,
    config,
    saveConfig,
    generateSummary,
    refreshWorks: refreshEntries,
    refreshInbox,
    clearError: resource.clearError,
  };
}
