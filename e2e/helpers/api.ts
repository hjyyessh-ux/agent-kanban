const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:24681';

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
  if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  return res.json() as Promise<Card>;
}

export async function apiUpdateCard(id: string, data: Record<string, unknown>): Promise<Card> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  return res.json() as Promise<Card>;
}

export async function apiDeleteCard(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.status}`);
}

export async function apiGetCards(): Promise<Card[]> {
  const res = await fetch(`${BASE}/api/cards`);
  if (!res.ok) throw new Error(`Get cards failed: ${res.status}`);
  return res.json() as Promise<Card[]>;
}

export async function apiArchiveCards(cardIds?: string[]): Promise<{ archivedCount: number; archiveMonth: string }> {
  const res = await fetch(`${BASE}/api/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cardIds ? { cardIds } : {}),
  });
  if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
  return res.json() as Promise<{ archivedCount: number; archiveMonth: string }>;
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
  if (!res.ok) throw new Error(`Upload screenshot failed: ${res.status}`);
  return res.json() as Promise<Screenshot>;
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
  if (!res.ok) throw new Error(`Create script failed: ${res.status}`);
  return res.json() as Promise<ScriptEntry>;
}

export async function apiDeleteScript(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/scripts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete script failed: ${res.status}`);
}

export async function apiGetScripts(): Promise<ScriptEntry[]> {
  const res = await fetch(`${BASE}/api/scripts`);
  if (!res.ok) throw new Error(`Get scripts failed: ${res.status}`);
  return res.json() as Promise<ScriptEntry[]>;
}

export type { ScriptEntry };
