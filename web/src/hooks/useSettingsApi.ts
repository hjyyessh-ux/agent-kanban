import type {
  SettingsEntry,
  CreateSettingsInput,
  UpdateSettingsInput,
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

export type MaintenanceState = 'idle' | 'running' | 'success' | 'fail';

export interface MaintenanceStatus {
  state: MaintenanceState;
  logPath: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  message?: string;
  repoRoot?: string;
  updatedAt: string;
}

export interface MaintenanceStartResponse {
  started: true;
  pid: number;
  logPath: string;
  statusPath: string;
  repoRoot: string;
}

export interface MaintenanceLogResponse {
  log: string;
  logPath: string;
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

export async function fetchSettings(): Promise<SettingsEntry[]> {
  const res = await fetch(`${BASE_URL}/settings`);
  return handleResponse<SettingsEntry[]>(res);
}

export async function fetchSetting(id: string): Promise<SettingsEntry> {
  const res = await fetch(`${BASE_URL}/settings/${encodeURIComponent(id)}`);
  return handleResponse<SettingsEntry>(res);
}

export async function createSetting(input: CreateSettingsInput): Promise<SettingsEntry> {
  const res = await fetch(`${BASE_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SettingsEntry>(res);
}

export async function updateSetting(id: string, input: UpdateSettingsInput): Promise<SettingsEntry> {
  const res = await fetch(`${BASE_URL}/settings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SettingsEntry>(res);
}

export async function deleteSetting(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/settings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
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

export async function applyUpdateAndRestart(): Promise<MaintenanceStartResponse> {
  const res = await fetch(`${BASE_URL}/maintenance/apply-update-restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<MaintenanceStartResponse>(res);
}

export async function fetchMaintenanceStatus(): Promise<MaintenanceStatus> {
  const res = await fetch(`${BASE_URL}/maintenance/status`, {
    cache: 'no-store',
  });
  return handleResponse<MaintenanceStatus>(res);
}

export async function fetchMaintenanceLog(): Promise<MaintenanceLogResponse> {
  const res = await fetch(`${BASE_URL}/maintenance/restart-log`, {
    cache: 'no-store',
  });
  return handleResponse<MaintenanceLogResponse>(res);
}
