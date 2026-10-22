import type { KanbanCard } from '../../../../src/core/types';
import { orderSessionTurns } from '../Board/SessionConversationModal';
import type { TimelineHighlight } from './timelineRows';

/** Which part of a turn the query was found in — the result row's label. */
export type WorkSearchHitField = 'title' | 'prompt' | 'result' | 'subagent';

export const WORK_SEARCH_FIELD_LABELS: Record<WorkSearchHitField, string> = {
  title: 'Title',
  prompt: 'Prompt',
  result: 'Result',
  subagent: 'Subagent',
};

export interface WorkSearchHit {
  cardId: string;
  /** Chronological turn number — the same T# the session modal shows. */
  turnNumber: number;
  field: WorkSearchHitField;
  /** Plain-text window around the first match; the UI marks the query in it. */
  snippet: string;
  /** When the turn ran (epoch ms) — where the timeline should look for it. */
  at: number;
}

export interface WorkSearchGroup {
  sessionId: string;
  hits: WorkSearchHit[];
}

const SNIPPET_BEFORE = 28;
const SNIPPET_LENGTH = 160;

/**
 * A one-line window of `text` around the first occurrence of `needle`
 * (lower-cased), whitespace collapsed, with `…` where it was cut.
 */
export function searchSnippet(text: string, needle: string): string {
  // Markdown markers are noise in a one-line window (`## 따로 확인하는 방법`).
  const flat = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, SNIPPET_LENGTH);
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(flat.length, from + SNIPPET_LENGTH);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/**
 * Search a Work's sessions, Obsidian-style: results grouped per session, one
 * hit per matching turn (the first field that matched, title → prompt →
 * result → subagent), turns in chronological order.
 *
 * `cardsBySession` holds each session's cards *including archived ones* when
 * they have been fetched; the board cards are the fallback for a session that
 * has not loaded yet, so typing never waits on the network to show anything.
 * Sessions keep the order of `sessionIds`; sessions without hits are dropped.
 */
export function searchWorkSessions(
  sessionIds: readonly string[],
  cardsBySession: ReadonlyMap<string, KanbanCard[]>,
  query: string,
): WorkSearchGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const groups: WorkSearchGroup[] = [];
  for (const sessionId of sessionIds) {
    const turns = orderSessionTurns(cardsBySession.get(sessionId) ?? []);
    const hits: WorkSearchHit[] = [];
    turns.forEach((card, index) => {
      const fields: Array<[WorkSearchHitField, string | undefined]> = [
        ['title', card.title],
        ['prompt', card.description],
        ['result', card.result],
        ...(card.childCards ?? []).flatMap((child): Array<[WorkSearchHitField, string | undefined]> => [
          ['subagent', child.description],
          ['subagent', child.result],
        ]),
      ];
      const found = fields.find(([, text]) => text?.toLowerCase().includes(needle));
      if (!found) return;
      hits.push({
        cardId: card.id,
        turnNumber: index + 1,
        field: found[0],
        snippet: searchSnippet(found[1] ?? '', needle),
        at: new Date(card.startedAt ?? card.createdAt).getTime(),
      });
    });
    if (hits.length > 0) groups.push({ sessionId, hits });
  }
  return groups;
}

/** What the 세션 흐름 timeline marks for a set of results. */
export function searchHighlight(groups: readonly WorkSearchGroup[]): TimelineHighlight {
  const times = groups.flatMap((group) => group.hits.map((hit) => hit.at)).filter(Number.isFinite);
  return {
    sessionIds: new Set(groups.map((group) => group.sessionId)),
    cardIds: new Set(groups.flatMap((group) => group.hits.map((hit) => hit.cardId))),
    latestAt: times.length > 0 ? Math.max(...times) : undefined,
  };
}

/** Split `text` around case-insensitive occurrences of `query`, for `<mark>`. */
export function splitOnQuery(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (let at = lower.indexOf(target); at >= 0; at = lower.indexOf(target, at + target.length)) {
    if (at > cursor) parts.push({ text: text.slice(cursor, at), match: false });
    parts.push({ text: text.slice(at, at + target.length), match: true });
    cursor = at + target.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
