import type { QuestionRequest, QuestionInfo, QuestionOption } from '../../../src/plugin/question-monitor';

const BASE_URL = '/api';

export type { QuestionRequest, QuestionInfo, QuestionOption };

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

export async function fetchQuestions(): Promise<QuestionRequest[]> {
  const res = await fetch(`${BASE_URL}/questions`);
  return handleResponse<QuestionRequest[]>(res);
}

export async function replyToQuestion(id: string, answers: string[][]): Promise<{ ok: boolean }> {
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
