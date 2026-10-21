import type { KanbanCard } from '../../../../src/core/types';
import { isUnreadCompletion } from './board-selectors';

export type BoardFilters = {
  search: string;
  directory: string;
  sessionName: string;
  sessionId: string;
  createdFrom: string;
  createdTo: string;
  updatedFrom: string;
  updatedTo: string;
};

export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  search: '',
  directory: '',
  sessionName: '',
  sessionId: '',
  createdFrom: '',
  createdTo: '',
  updatedFrom: '',
  updatedTo: '',
};

function toLowerTrimmed(value: string | undefined): string {
  return (value ?? '').toLowerCase().trim();
}

function normalizeDirectory(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

function toStartTimestamp(dateInput: string): number | null {
  if (!dateInput) return null;
  const timestamp = Date.parse(`${dateInput}T00:00:00.000Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toEndTimestamp(dateInput: string): number | null {
  const start = toStartTimestamp(dateInput);
  if (start === null) return null;
  return start + (24 * 60 * 60 * 1000) - 1;
}

function dateInRange(
  isoDate: string,
  fromDateInput: string,
  toDateInput: string,
): boolean {
  if (!fromDateInput && !toDateInput) return true;

  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return false;

  const from = toStartTimestamp(fromDateInput);
  const to = toEndTimestamp(toDateInput);

  if (from !== null && timestamp < from) return false;
  if (to !== null && timestamp > to) return false;
  return true;
}

export function filterBoardCards(cards: KanbanCard[], filters: BoardFilters): KanbanCard[] {
  const searchQuery = toLowerTrimmed(filters.search);
  const directoryQuery = normalizeDirectory(filters.directory);
  const sessionNameQuery = toLowerTrimmed(filters.sessionName);
  const sessionIdQuery = toLowerTrimmed(filters.sessionId);

  return cards.filter((card) => {
    if (searchQuery) {
      const haystack = [card.title, card.description, card.progressSummary, card.result, card.sessionId]
        .map((field) => toLowerTrimmed(field))
        .join(' ');
      if (!haystack.includes(searchQuery)) return false;
    }

    if (directoryQuery && normalizeDirectory(card.projectDir) !== directoryQuery) {
      return false;
    }

    if (sessionNameQuery && !toLowerTrimmed(card.sessionTitle).includes(sessionNameQuery)) {
      return false;
    }

    if (sessionIdQuery && !toLowerTrimmed(card.sessionId).includes(sessionIdQuery)) {
      return false;
    }

    if (!dateInRange(card.createdAt, filters.createdFrom, filters.createdTo)) {
      return false;
    }

    if (!dateInRange(card.updatedAt, filters.updatedFrom, filters.updatedTo)) {
      return false;
    }

    return true;
  });
}

function sessionGroupKey(card: KanbanCard): string {
  // Same key `groupCompleteCardsBySession` groups by.
  return card.sessionId ? `session:${card.sessionId}` : `card:${card.id}`;
}

/**
 * The toolbar's `Unread only` toggle. Kept apart from `BoardFilters` on
 * purpose: those also narrow the Timeline (`sessionFilter`), and the Timeline
 * draws executed work, which has no read state — it ignores this one.
 *
 * - Flat columns keep only unread completions.
 * - With `groupBySession` (Session 모아보기) a session that has *any* unread
 *   card keeps all of its `complete` cards, so the group reads as a
 *   conversation rather than one orphan turn. Its `done` cards stay out: the
 *   Done column is a different group.
 * - Children of a kept card stay with it, so the parent's child counts do not
 *   change just because the filter is on.
 */
export function filterUnreadOnly(
  cards: KanbanCard[],
  { groupBySession }: { groupBySession: boolean },
): KanbanCard[] {
  const unreadSessions = new Set<string>();
  if (groupBySession) {
    for (const card of cards) {
      if (isUnreadCompletion(card)) unreadSessions.add(sessionGroupKey(card));
    }
  }

  const kept = new Set<string>();
  for (const card of cards) {
    if (
      isUnreadCompletion(card)
      || (groupBySession && card.status === 'complete' && unreadSessions.has(sessionGroupKey(card)))
    ) {
      kept.add(card.id);
    }
  }

  return cards.filter((card) => kept.has(card.id) || (!!card.parentCardId && kept.has(card.parentCardId)));
}
