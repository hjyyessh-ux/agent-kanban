import type {
  Work,
  CreateWorkInput,
  AddWorkSessionInput,
  MergeWorkResponse,
  MoveWorkSessionInput,
  MoveWorkSessionResponse,
  WorkReopenResponse,
  WorkIgnoredSession,
  WorkInboxSession,
  WorkStatus,
  WorkSessionRole,
  WorkPatchInput,
  WorksConfigDto,
  WorksConfigInput,
  WorkSummaryResponse,
  WorkSessionsResponse,
  WorkCompletionPreview,
  WorkPatchResponse,
  WorkBatchAddSessionsResponse,
  WorkPruneSessionsResponse,
  WorkLinkReconcileReport,
  TimelineSnapshot,
} from '../../../src/core/types';

const BASE_URL = '/api';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore JSON parse errors
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore JSON parse errors
    }
    throw new ApiError(res.status, message);
  }
}

export async function fetchWorks(status?: WorkStatus): Promise<Work[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${BASE_URL}/works${query}`);
  return handleResponse<Work[]>(res);
}

/**
 * A Work's linked sessions, summarized server-side over live *and* archived
 * cards. Separate from `fetchWorks` for the same reason `fetchTimeline` is: the
 * detail dialog has to describe work whose cards the board no longer holds.
 */
export async function fetchWorkSessions(id: string): Promise<WorkSessionsResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/sessions`);
  return handleResponse<WorkSessionsResponse>(res);
}

/**
 * What completing a Work would destroy — card counts (archive included) and any
 * card still running an agent. Read before the confirmation dialog commits, so
 * the user sees the scope of the sweep rather than a bare "계속하시겠습니까?".
 */
export async function fetchWorkCompletionPreview(id: string): Promise<WorkCompletionPreview> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/completion-preview`);
  return handleResponse<WorkCompletionPreview>(res);
}

export async function fetchWorkInbox(): Promise<WorkInboxSession[]> {
  const res = await fetch(`${BASE_URL}/works/inbox`);
  return handleResponse<WorkInboxSession[]>(res);
}

/**
 * Executed sessions inside a day window, for the Timeline view. Separate from
 * `fetchWorks` because it reads the card archive: the window is what keeps that
 * bounded, so both ends are required.
 */
export async function fetchTimeline(
  window: { from: string; to: string },
  includeSubagents: boolean,
): Promise<TimelineSnapshot> {
  const query = new URLSearchParams({ from: window.from, to: window.to });
  if (includeSubagents) query.set('subagents', '1');
  const res = await fetch(`${BASE_URL}/timeline?${query.toString()}`);
  return handleResponse<TimelineSnapshot>(res);
}

export async function createWork(input: CreateWorkInput): Promise<Work> {
  const res = await fetch(`${BASE_URL}/works`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<Work>(res);
}

/**
 * PATCH a Work. `status: 'done'` carries the server-side bulk done→archive
 * sweep; when `works.done_confirm` is on the server defers that sweep until the
 * body also carries `confirmArchive: true` (see `WorkPatchInput`).
 */
export async function updateWork(id: string, input: WorkPatchInput): Promise<WorkPatchResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<WorkPatchResponse>(res);
}

/**
 * Put a terminal Work back to `active` and lift its bulk-archived cards back
 * onto the board. `409` when it is already active.
 *
 * The one route out of a completed Work that keeps the record: `DELETE` was the
 * only escape before, and it took the Work's Summary and Timeline history with
 * it.
 */
export async function reopenWork(id: string): Promise<WorkReopenResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/reopen`, {
    method: 'POST',
  });
  return handleResponse<WorkReopenResponse>(res);
}

/**
 * Fold this Work's sessions into another one. The source survives as
 * `discarded` / `superseded` with a pointer at the target — unlike moving its
 * last session out, which deletes it.
 */
export async function mergeWork(id: string, intoWorkId: string): Promise<MergeWorkResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intoWorkId }),
  });
  return handleResponse<MergeWorkResponse>(res);
}

export async function deleteWork(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await expectOk(res);
}

export async function addWorkSession(id: string, input: AddWorkSessionInput): Promise<Work> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<Work>(res);
}

/**
 * Link a whole triage selection in one request.
 *
 * The client used to POST one session at a time, and each of those calls read
 * the entire card archive server-side — 20 selected sessions meant 20+ full
 * scans for one click. The batch verb shares a single snapshot. Partial success
 * is reported in `failed[]` rather than thrown: the sessions that linked stay
 * linked and the rest stay selected for a retry.
 */
export async function addWorkSessionsBatch(
  id: string,
  sessions: AddWorkSessionInput[],
  role?: WorkSessionRole,
): Promise<WorkBatchAddSessionsResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/sessions/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions, role }),
  });
  return handleResponse<WorkBatchAddSessionsResponse>(res);
}

/**
 * Drop every link whose session has no cards left (`cardsMissingAt`). The
 * server stamps those links when a card delete empties a session; this is the
 * explicit cleanup, never automatic — card deletion is reversible.
 */
export async function pruneWorkSessions(id: string): Promise<WorkPruneSessionsResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/prune-sessions`, {
    method: 'POST',
  });
  return handleResponse<WorkPruneSessionsResponse>(res);
}

/** Whole-store dangling-link repair. Idempotent; also runs once at server boot. */
export async function reconcileWorkLinks(): Promise<WorkLinkReconcileReport> {
  const res = await fetch(`${BASE_URL}/works/reconcile-links`, { method: 'POST' });
  return handleResponse<WorkLinkReconcileReport>(res);
}

export async function removeWorkSession(id: string, sessionId: string): Promise<Work> {
  const res = await fetch(
    `${BASE_URL}/works/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  return handleResponse<Work>(res);
}

/**
 * Move a session's link to another Work. The server re-parents the link,
 * recalculates both Works' `startedAt`, and deletes a source Work left with no
 * sessions (reported as `from: null`). Rejects `409` when either side has
 * already been bulk-archived — the caller shows that message verbatim.
 */
export async function moveWorkSession(
  sessionId: string,
  input: Omit<MoveWorkSessionInput, 'sessionId'>,
): Promise<MoveWorkSessionResponse> {
  const res = await fetch(`${BASE_URL}/works/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<MoveWorkSessionResponse>(res);
}

export async function ignoreWorkSession(sessionId: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/works/ignore-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const body = await handleResponse<{ ignoredSessionIds: string[] }>(res);
  return body.ignoredSessionIds;
}

/**
 * The Inbox ignore list, with each row's session summary. The read side of
 * `ignoreWorkSession`: without it, 폐기 removed a session from every screen and
 * `works.json` was the only place left to look.
 */
export async function fetchIgnoredSessions(): Promise<WorkIgnoredSession[]> {
  const res = await fetch(`${BASE_URL}/works/ignored-sessions`);
  return handleResponse<WorkIgnoredSession[]>(res);
}

/** Take a session off the ignore list. `404` when it was not on it. */
export async function restoreIgnoredSession(sessionId: string): Promise<string[]> {
  const res = await fetch(
    `${BASE_URL}/works/ignore-session/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  const body = await handleResponse<{ ignoredSessionIds: string[] }>(res);
  return body.ignoredSessionIds;
}

export async function fetchWorksConfig(): Promise<WorksConfigDto> {
  const res = await fetch(`${BASE_URL}/works/config`);
  return handleResponse<WorksConfigDto>(res);
}

export async function saveWorksConfig(input: WorksConfigInput): Promise<WorksConfigDto> {
  const res = await fetch(`${BASE_URL}/works/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<WorksConfigDto>(res);
}

export async function generateWorkSummary(id: string): Promise<WorkSummaryResponse> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<WorkSummaryResponse>(res);
}
