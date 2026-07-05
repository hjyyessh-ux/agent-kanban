import type { AgentRuntime, KanbanCard, CreateCardInput, UpdateCardInput, Screenshot, DispatchResult } from '../../../src/core/types';
import type { RuntimeCatalogEntry } from '../../../src/core/runtime-config';
import type { QuestionOption, QuestionInfo, QuestionRequest } from '../../../src/plugin/question-monitor';

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

export interface SessionInfo {
  sessionId: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  cardTitle: string;
  cardId: string;
  cardStatus: string;
  agentRuntime?: AgentRuntime;
  agentType?: string;
  model?: string;
  linkState?: 'none' | 'single' | 'multiple';
  relatedCardCount?: number;
  isSubagentOnly?: boolean;
  hasTopLevelLinkedCard?: boolean;
  hasSubagentLinkedCard?: boolean;
  visiblePeerCount?: number;
  primaryPeerInstanceId?: string;
  primaryPeerPort?: number;
  primaryPeerIsLocal?: boolean;
  primaryPeerCwd?: string;
  updatedAt: string;
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${BASE_URL}/sessions`);
  return handleResponse<SessionInfo[]>(res);
}

export async function fetchCards(status?: string): Promise<KanbanCard[]> {
  const url = status ? `${BASE_URL}/cards?status=${encodeURIComponent(status)}` : `${BASE_URL}/cards`;
  const res = await fetch(url);
  return handleResponse<KanbanCard[]>(res);
}

export async function fetchRuntimes(): Promise<RuntimeCatalogEntry[]> {
  const res = await fetch(`${BASE_URL}/runtimes`);
  const body = await handleResponse<{ runtimes: RuntimeCatalogEntry[] }>(res);
  return body.runtimes;
}

export async function fetchCard(id: string): Promise<KanbanCard> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(id)}`);
  return handleResponse<KanbanCard>(res);
}

export async function createCard(input: CreateCardInput): Promise<KanbanCard> {
  const res = await fetch(`${BASE_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<KanbanCard>(res);
}

export async function updateCard(id: string, input: UpdateCardInput): Promise<KanbanCard> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<KanbanCard>(res);
}

export async function markCompletionSeen(id: string): Promise<KanbanCard> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(id)}/completion-seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<KanbanCard>(res);
}

export async function deleteCard(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(id)}`, {
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

export async function archiveCards(cardIds?: string[]): Promise<{ archivedCount: number; archiveMonth: string }> {
  const res = await fetch(`${BASE_URL}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardIds }),
  });
  return handleResponse<{ archivedCount: number; archiveMonth: string }>(res);
}

export async function dispatchCard(id: string): Promise<DispatchResult> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(id)}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<DispatchResult>(res);
}

export async function fetchQueuedCards(cardId: string): Promise<KanbanCard[]> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(cardId)}/queue`);
  return handleResponse<KanbanCard[]>(res);
}

export async function fetchNextQueuePosition(cardId: string): Promise<number> {
  const queued = await fetchQueuedCards(cardId);
  if (queued.length === 0) return 1;
  return Math.max(...queued.map(c => c.queuePosition ?? 0)) + 1;
}

export async function uploadScreenshot(cardId: string, file: File): Promise<Screenshot> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(cardId)}/screenshots`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse<Screenshot>(res);
}

export async function deleteScreenshot(cardId: string, screenshotId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(cardId)}/screenshots/${encodeURIComponent(screenshotId)}`, {
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

export function getScreenshotUrl(filename: string): string {
  return `${BASE_URL}/screenshots/${encodeURIComponent(filename)}`;
}

export interface ModelInfo {
  id: string;
  name: string;
  providerID: string;
  providerName: string;
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE_URL}/models`);
  return handleResponse<ModelInfo[]>(res);
}

export type { QuestionOption, QuestionInfo, QuestionRequest };

export async function fetchQuestions(): Promise<QuestionRequest[]> {
  const res = await fetch(`${BASE_URL}/questions`);
  return handleResponse<QuestionRequest[]>(res);
}

export async function answerQuestion(
  id: string,
  answers: string[][],
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/questions/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  return handleResponse<{ ok: boolean }>(res);
}

export async function rejectQuestion(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/questions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<{ ok: boolean }>(res);
}
