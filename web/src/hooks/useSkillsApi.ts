import type { AgentRuntime, DiscoveredSkill, SkillSyncResult } from '../../../src/core/types';

const BASE_URL = '/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function handleEmptyOk(res: Response): Promise<void> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
}

export async function fetchSkills(): Promise<DiscoveredSkill[]> {
  const res = await fetch(`${BASE_URL}/skills`);
  return handleResponse<DiscoveredSkill[]>(res);
}

export async function syncSkills(): Promise<SkillSyncResult> {
  const res = await fetch(`${BASE_URL}/skills/sync`, { method: 'POST' });
  return handleResponse<SkillSyncResult>(res);
}

export async function fetchSkillContent(id: string): Promise<{ id: string; filePath: string; content: string }> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(id)}/content`);
  return handleResponse(res);
}

export async function saveSkillContent(id: string, content: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(id)}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return handleEmptyOk(res);
}

export async function createSkill(input: {
  name: string;
  targetRootId: string;
  description?: string;
  instructions?: string;
}): Promise<SkillSyncResult> {
  const res = await fetch(`${BASE_URL}/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SkillSyncResult>(res);
}

export async function importSkill(
  file: File,
  targetRootId: string,
  name?: string,
): Promise<SkillSyncResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('targetRootId', targetRootId);
  if (name) form.append('name', name);
  const res = await fetch(`${BASE_URL}/skills/import`, { method: 'POST', body: form });
  return handleResponse<SkillSyncResult>(res);
}

export async function duplicateSkill(
  id: string,
  targetRootId: string,
): Promise<SkillSyncResult> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetRootId }),
  });
  return handleResponse<SkillSyncResult>(res);
}

export async function createSkillCard(input: {
  title: string;
  description: string;
  agentRuntime: AgentRuntime;
}): Promise<{ id: string }> {
  const res = await fetch(`${BASE_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<{ id: string }>(res);
}
