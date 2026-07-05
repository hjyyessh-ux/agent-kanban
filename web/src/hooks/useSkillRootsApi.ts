import type { SkillRoot } from '../../../src/core/types';

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

export async function fetchSkillRoots(): Promise<SkillRoot[]> {
  const res = await fetch(`${BASE_URL}/skill-roots`);
  return handleResponse<SkillRoot[]>(res);
}

export async function addSkillRoot(input: Omit<SkillRoot, 'id'>): Promise<SkillRoot> {
  const res = await fetch(`${BASE_URL}/skill-roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<SkillRoot>(res);
}

export async function updateSkillRoot(
  id: string,
  patch: Partial<Omit<SkillRoot, 'id'>>,
): Promise<SkillRoot> {
  const res = await fetch(`${BASE_URL}/skill-roots/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handleResponse<SkillRoot>(res);
}

export async function removeSkillRoot(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/skill-roots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
}
