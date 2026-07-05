import type {
  ScriptEntry,
  ScriptSyncResult,
  CreateScriptInput,
  UpdateScriptInput,
  ScriptRun,
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
    } catch { /* ignore */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export async function fetchScripts(): Promise<ScriptEntry[]> {
  const res = await fetch(`${BASE_URL}/scripts`);
  return handleResponse<ScriptEntry[]>(res);
}

export async function fetchScript(id: string): Promise<ScriptEntry> {
  const res = await fetch(`${BASE_URL}/scripts/${encodeURIComponent(id)}`);
  return handleResponse<ScriptEntry>(res);
}

export async function createScript(input: CreateScriptInput): Promise<ScriptEntry> {
  const res = await fetch(`${BASE_URL}/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<ScriptEntry>(res);
}

export async function updateScript(id: string, input: UpdateScriptInput): Promise<ScriptEntry> {
  const res = await fetch(`${BASE_URL}/scripts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<ScriptEntry>(res);
}

export async function deleteScript(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/scripts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new ApiError(res.status, message);
  }
}

export async function runScript(id: string): Promise<ScriptRun> {
  const res = await fetch(`${BASE_URL}/scripts/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<ScriptRun>(res);
}

export async function fetchScriptHistory(id: string): Promise<ScriptRun[]> {
  const res = await fetch(`${BASE_URL}/scripts/${encodeURIComponent(id)}/history`);
  return handleResponse<ScriptRun[]>(res);
}

export async function syncScripts(): Promise<ScriptSyncResult> {
  const res = await fetch(`${BASE_URL}/scripts/sync`, {
    method: 'POST',
  });
  return handleResponse<ScriptSyncResult>(res);
}
