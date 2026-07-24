const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:24681';

async function parseJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(`${label}: ${res.status}`);
  return res.json() as Promise<T>;
}

interface Screenshot {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

interface Card {
  id: string;
  title: string;
  description: string;
  status: string;
  agentType?: string;
  sessionId?: string;
  progressSummary?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  projectDir?: string;
  screenshots?: Screenshot[];
  [key: string]: unknown;
}

export async function apiCreateCard(data: { title: string; description: string } & Record<string, unknown>): Promise<Card> {
  const res = await fetch(`${BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return parseJson<Card>(res, 'Create failed');
}

export async function apiUpdateCard(id: string, data: Record<string, unknown>): Promise<Card> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return parseJson<Card>(res, 'Update failed');
}

export async function apiDeleteCard(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.status}`);
}

export async function apiGetCards(): Promise<Card[]> {
  const res = await fetch(`${BASE}/api/cards`);
  return parseJson<Card[]>(res, 'Get cards failed');
}

export async function apiArchiveCards(cardIds?: string[]): Promise<{ archivedCount: number; archiveMonth: string }> {
  const res = await fetch(`${BASE}/api/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cardIds ? { cardIds } : {}),
  });
  return parseJson<{ archivedCount: number; archiveMonth: string }>(res, 'Archive failed');
}

export async function apiDispatchCard(id: string): Promise<{ sessionId: string; runId: string; startedAt: string }> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}/dispatch`, {
    method: 'POST',
  });
  return parseJson<{ sessionId: string; runId: string; startedAt: string }>(res, 'Dispatch failed');
}

export async function apiScheduleCard(id: string, scheduledAt: string): Promise<Card> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}/schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledAt }),
  });
  return parseJson<Card>(res, 'Schedule failed');
}

export async function apiCancelCardSchedule(id: string): Promise<Card> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}/schedule`, {
    method: 'DELETE',
  });
  return parseJson<Card>(res, 'Cancel schedule failed');
}

export async function apiUploadScreenshot(cardId: string, filePath: string): Promise<Screenshot> {
  const { readFileSync } = await import('node:fs');
  const { basename } = await import('node:path');
  const content = readFileSync(filePath);
  const name = basename(filePath);
  const blob = new Blob([content], { type: 'image/png' });
  const form = new FormData();
  form.append('file', blob, name);
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(cardId)}/screenshots`, {
    method: 'POST',
    body: form,
  });
  return parseJson<Screenshot>(res, 'Upload screenshot failed');
}

export function apiGetScreenshotUrl(filename: string): string {
  return `${BASE}/api/screenshots/${encodeURIComponent(filename)}`;
}

export type { Card, Screenshot };

// ── Scripts ──────────────────────────────────────────────────────────────────

interface ScriptEntry {
  id: string;
  name: string;
  description: string;
  content: string;
  language?: string;
  history: unknown[];
  [key: string]: unknown;
}

export async function apiCreateScript(data: {
  name: string;
  content: string;
  description?: string;
  language?: string;
}): Promise<ScriptEntry> {
  const res = await fetch(`${BASE}/api/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return parseJson<ScriptEntry>(res, 'Create script failed');
}

export async function apiDeleteScript(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/scripts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete script failed: ${res.status}`);
}

export async function apiGetScripts(): Promise<ScriptEntry[]> {
  const res = await fetch(`${BASE}/api/scripts`);
  return parseJson<ScriptEntry[]>(res, 'Get scripts failed');
}

export type { ScriptEntry };

// ── Scheduler / E2E controls ────────────────────────────────────────────────

interface SchedulerEntry {
  id: string;
  name: string;
  status: string;
  cron: string;
  history: SchedulerRun[];
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  action: Record<string, unknown>;
}

interface SchedulerRun {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  cardId?: string;
  dispatched?: boolean;
  dispatchAcceptedAt?: string;
}

export async function apiCreateScheduler(data: Record<string, unknown>): Promise<SchedulerEntry> {
  const res = await fetch(`${BASE}/api/schedulers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return parseJson<SchedulerEntry>(res, 'Create scheduler failed');
}

export async function apiGetSchedulers(): Promise<SchedulerEntry[]> {
  const res = await fetch(`${BASE}/api/schedulers`);
  return parseJson<SchedulerEntry[]>(res, 'Get schedulers failed');
}

export async function apiGetSchedulerHistory(id: string): Promise<SchedulerRun[]> {
  const res = await fetch(`${BASE}/api/schedulers/${encodeURIComponent(id)}/history`);
  return parseJson<SchedulerRun[]>(res, 'Get scheduler history failed');
}

export async function apiE2ESetClock(now: string, kickScheduledDispatch = false): Promise<{ now: string }> {
  const res = await fetch(`${BASE}/api/e2e/clock`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ now, kickScheduledDispatch }),
  });
  return parseJson<{ now: string }>(res, 'Set fake clock failed');
}

export async function apiE2EAdvanceClock(ms: number, kickScheduledDispatch = false): Promise<{ now: string }> {
  const res = await fetch(`${BASE}/api/e2e/clock/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ms, kickScheduledDispatch }),
  });
  return parseJson<{ now: string }>(res, 'Advance fake clock failed');
}

export async function apiE2EKickScheduledDispatch(): Promise<void> {
  const res = await fetch(`${BASE}/api/e2e/scheduled-dispatch/kick`, {
    method: 'POST',
  });
  await parseJson<{ ok: boolean }>(res, 'Kick scheduled dispatch failed');
}

export async function apiE2ERestartServices(): Promise<void> {
  const res = await fetch(`${BASE}/api/e2e/services/restart`, {
    method: 'POST',
  });
  await parseJson<{ ok: boolean }>(res, 'Restart background services failed');
}

export async function apiE2EGetDispatchAttempts(cardId: string): Promise<number> {
  const res = await fetch(`${BASE}/api/e2e/dispatch-attempts/${encodeURIComponent(cardId)}`);
  const body = await parseJson<{ attempts: number }>(res, 'Get dispatch attempts failed');
  return body.attempts;
}

export type { SchedulerEntry, SchedulerRun };
