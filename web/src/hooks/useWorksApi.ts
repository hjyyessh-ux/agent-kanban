import type {
  Work,
  CreateWorkInput,
  AddWorkSessionInput,
  WorkInboxSession,
  WorkStatus,
  WorkPatchInput,
  WorksConfigDto,
  WorksConfigInput,
  WorkSummaryResponse,
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

export async function fetchWorkInbox(): Promise<WorkInboxSession[]> {
  const res = await fetch(`${BASE_URL}/works/inbox`);
  return handleResponse<WorkInboxSession[]>(res);
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
export async function updateWork(id: string, input: WorkPatchInput): Promise<Work> {
  const res = await fetch(`${BASE_URL}/works/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<Work>(res);
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

export async function removeWorkSession(id: string, sessionId: string): Promise<Work> {
  const res = await fetch(
    `${BASE_URL}/works/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  return handleResponse<Work>(res);
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
