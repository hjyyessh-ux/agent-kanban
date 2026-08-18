import type {
  CreateQuickActionInput,
  QuickActionView,
  RunQuickActionInput,
  RunQuickActionResponse,
  UpdateQuickActionInput,
} from '../../../src/core/types';

const BASE_URL = '/api';

export class QuickActionsApiError extends Error {
  status: number;
  body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'QuickActionsApiError';
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText;
    let body: unknown;
    try {
      body = await response.json();
      if (
        typeof body === 'object'
        && body !== null
        && 'error' in body
        && typeof body.error === 'string'
      ) {
        message = body.error;
      }
    } catch {
      // Ignore malformed error bodies and keep the HTTP status text.
    }
    throw new QuickActionsApiError(response.status, message, body);
  }
  return response.json() as Promise<T>;
}

export async function fetchQuickActions(): Promise<QuickActionView[]> {
  const response = await fetch(`${BASE_URL}/quick-actions`);
  return handleResponse<QuickActionView[]>(response);
}

export async function fetchQuickAction(id: string): Promise<QuickActionView> {
  const response = await fetch(`${BASE_URL}/quick-actions/${encodeURIComponent(id)}`);
  return handleResponse<QuickActionView>(response);
}

export async function createQuickAction(input: CreateQuickActionInput): Promise<QuickActionView> {
  const response = await fetch(`${BASE_URL}/quick-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<QuickActionView>(response);
}

export async function updateQuickAction(
  id: string,
  input: UpdateQuickActionInput,
): Promise<QuickActionView> {
  const response = await fetch(`${BASE_URL}/quick-actions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<QuickActionView>(response);
}

export async function deleteQuickAction(id: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/quick-actions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    await handleResponse<never>(response);
  }
}

export async function runQuickAction(
  id: string,
  input: RunQuickActionInput,
): Promise<RunQuickActionResponse> {
  const response = await fetch(`${BASE_URL}/quick-actions/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<RunQuickActionResponse>(response);
}
