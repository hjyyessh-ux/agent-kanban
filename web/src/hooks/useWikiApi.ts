import type {
  KanbanCard,
  WikiArchiveCardsResponse,
  WikiArchiveCardStatusFilter,
  WikiConfigDto,
  WikiConfigInput,
  WikiWorkerStatus,
} from '../../../src/core/types';
import { ApiError } from './useSettingsApi';

const BASE_URL = '/api';

export interface WikiArchiveResponse {
  months: string[];
  month: string | null;
  cards: KanbanCard[];
}

interface LegacyArchiveCursor {
  month: string;
  offset: number;
}

const LEGACY_ARCHIVE_CURSOR_PREFIX = 'legacy:';

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

function encodeLegacyArchiveCursor(cursor: LegacyArchiveCursor): string {
  return `${LEGACY_ARCHIVE_CURSOR_PREFIX}${btoa(JSON.stringify(cursor))}`;
}

function decodeLegacyArchiveCursor(value: string): LegacyArchiveCursor | null {
  if (!value.startsWith(LEGACY_ARCHIVE_CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(atob(value.slice(LEGACY_ARCHIVE_CURSOR_PREFIX.length))) as Partial<LegacyArchiveCursor>;
    if (
      typeof parsed.month !== 'string'
      || !/^\d{4}-\d{2}$/.test(parsed.month)
      || typeof parsed.offset !== 'number'
      || !Number.isInteger(parsed.offset)
      || parsed.offset < 0
    ) {
      throw new Error('Invalid legacy archive cursor');
    }
    return { month: parsed.month, offset: parsed.offset };
  } catch {
    throw new ApiError(400, 'Invalid legacy archive cursor');
  }
}

function matchesArchiveStatus(card: KanbanCard, status: WikiArchiveCardStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'unprocessed') return !card.wiki;
  if (!card.wiki) return false;
  if (status === 'kept') return card.wiki.decision === 'kept';
  if (status === 'skipped') return card.wiki.decision === 'skipped';
  if (status === 'failed') return card.wiki.status === 'failed';
  if (status === 'pending') return card.wiki.status === 'pending';
  return true;
}

function matchesArchiveQuery(card: KanbanCard, q: string): boolean {
  const normalized = q.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    card.title,
    card.wiki?.docTitle,
    card.wiki?.docPath,
    ...(card.wiki?.topics ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(normalized);
}

export async function fetchWikiStatus(): Promise<WikiWorkerStatus> {
  const res = await fetch(`${BASE_URL}/wiki/status`, { cache: 'no-store' });
  return handleResponse<WikiWorkerStatus>(res);
}

export async function fetchWikiArchive(month?: string): Promise<WikiArchiveResponse> {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  const res = await fetch(`${BASE_URL}/wiki/archive${query}`, { cache: 'no-store' });
  return handleResponse<WikiArchiveResponse>(res);
}

export async function fetchWikiArchiveCards(input: {
  limit?: number;
  cursor?: string | null;
  status?: WikiArchiveCardStatusFilter;
  q?: string;
} = {}): Promise<WikiArchiveCardsResponse> {
  if (input.cursor?.startsWith(LEGACY_ARCHIVE_CURSOR_PREFIX)) {
    return fetchWikiArchiveCardsLegacy(input);
  }

  const params = new URLSearchParams();
  if (input.limit) params.set('limit', String(input.limit));
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.status) params.set('status', input.status);
  if (input.q?.trim()) params.set('q', input.q.trim());
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${BASE_URL}/wiki/archive/cards${query}`, { cache: 'no-store' });
  try {
    return await handleResponse<WikiArchiveCardsResponse>(res);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return fetchWikiArchiveCardsLegacy(input);
    }
    throw err;
  }
}

async function fetchWikiArchiveCardsLegacy(input: {
  limit?: number;
  cursor?: string | null;
  status?: WikiArchiveCardStatusFilter;
  q?: string;
}): Promise<WikiArchiveCardsResponse> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 200));
  const status = input.status ?? 'all';
  const query = input.q ?? '';
  const cursor = input.cursor ? decodeLegacyArchiveCursor(input.cursor) : null;
  const firstArchive = await fetchWikiArchive(cursor?.month);
  const months = firstArchive.months;
  const startMonth = firstArchive.month;
  if (!startMonth) return { cards: [], nextCursor: null };

  const startIndex = months.indexOf(startMonth);
  const cards: KanbanCard[] = [];
  let nextCursor: string | null = null;

  for (let monthIndex = startIndex >= 0 ? startIndex : 0; monthIndex < months.length; monthIndex++) {
    const month = months[monthIndex];
    const archive = month === firstArchive.month ? firstArchive : await fetchWikiArchive(month);
    const monthCards = archive.cards
      .filter((card) => !card.deletedAt)
      .filter((card) => matchesArchiveStatus(card, status))
      .filter((card) => matchesArchiveQuery(card, query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = cursor && month === cursor.month ? cursor.offset : 0;
    if (offset >= monthCards.length) continue;

    const page = monthCards.slice(offset, offset + (limit - cards.length));
    cards.push(...page);

    if (cards.length >= limit) {
      const nextOffset = offset + page.length;
      if (nextOffset < monthCards.length) {
        nextCursor = encodeLegacyArchiveCursor({ month, offset: nextOffset });
      } else if (monthIndex + 1 < months.length) {
        nextCursor = encodeLegacyArchiveCursor({ month: months[monthIndex + 1], offset: 0 });
      }
      break;
    }
  }

  return { cards, nextCursor };
}

export async function runWikiBackfill(limit = 500): Promise<{ queued: number; limit: number }> {
  const res = await fetch(`${BASE_URL}/wiki/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  return handleResponse<{ queued: number; limit: number }>(res);
}

export async function fetchWikiDoc(docPath: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/wiki/doc?path=${encodeURIComponent(docPath)}`, { cache: 'no-store' });
  const body = await handleResponse<{ path: string; content: string }>(res);
  return body.content;
}

export async function reprocessWikiCards(cardIds: string[]): Promise<{ queued: number }> {
  const res = await fetch(`${BASE_URL}/wiki/reprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardIds }),
  });
  return handleResponse<{ queued: number }>(res);
}

export async function restartWikiWorker(): Promise<WikiWorkerStatus> {
  const res = await fetch(`${BASE_URL}/wiki/restart`, { method: 'POST' });
  return handleResponse<WikiWorkerStatus>(res);
}

export async function fetchWikiConfig(): Promise<WikiConfigDto> {
  const res = await fetch(`${BASE_URL}/wiki/config`, { cache: 'no-store' });
  return handleResponse<WikiConfigDto>(res);
}

export async function saveWikiConfig(input: WikiConfigInput): Promise<WikiConfigDto> {
  const res = await fetch(`${BASE_URL}/wiki/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<WikiConfigDto>(res);
}
