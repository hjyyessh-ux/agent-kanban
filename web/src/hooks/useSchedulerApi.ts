import type {
  SchedulerEntry,
  CreateSchedulerInput,
  UpdateSchedulerInput,
  SchedulerRun,
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

export async function fetchSchedulers(): Promise<SchedulerEntry[]> {
  const res = await fetch(`${BASE_URL}/schedulers`);
  return handleResponse<SchedulerEntry[]>(res);
}

export async function fetchScheduler(id: string): Promise<SchedulerEntry> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}`);
  return handleResponse<SchedulerEntry>(res);
}

export async function createScheduler(input: CreateSchedulerInput): Promise<SchedulerEntry> {
  const res = await fetch(`${BASE_URL}/schedulers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SchedulerEntry>(res);
}

export async function updateScheduler(id: string, input: UpdateSchedulerInput): Promise<SchedulerEntry> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SchedulerEntry>(res);
}

export async function deleteScheduler(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}`, {
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

export async function toggleScheduler(id: string): Promise<SchedulerEntry> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<SchedulerEntry>(res);
}

export async function runScheduler(id: string): Promise<SchedulerRun> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<SchedulerRun>(res);
}

export async function fetchSchedulerHistory(id: string): Promise<SchedulerRun[]> {
  const res = await fetch(`${BASE_URL}/schedulers/${encodeURIComponent(id)}/history`);
  return handleResponse<SchedulerRun[]>(res);
}

export interface CronParseResponse {
  cron: string;
  description: string;
  valid: true;
}

export interface CronParseError {
  valid: false;
  error: string;
}

export type CronParseResult = CronParseResponse | CronParseError;

export async function parseCron(input: string): Promise<CronParseResult> {
  const res = await fetch(`${BASE_URL}/schedulers/parse-cron`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return handleResponse<CronParseResult>(res);
}
