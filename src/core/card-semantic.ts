export const CARD_SEMANTIC_SETTINGS_KEY = 'card_semantic_search';
export const CARD_SEMANTIC_SETTINGS_PATH = '/api/settings/card-semantic';
export const CARD_SEMANTIC_SEARCH_PATH = '/api/cards/search/semantic';

export interface CardSemanticConfig {
  enabled: boolean;
  directories: string[];
}

export interface CardSemanticStatus extends CardSemanticConfig {
  state: 'off' | 'unavailable' | 'preparing' | 'ready' | 'failed';
  pending: number;
  failed: number;
  revision: string;
}

export type CardSemanticScope =
  | { kind: 'board'; filter?: Record<string, string>; work?: string; unread?: boolean; grouped?: boolean }
  | { kind: 'work'; id: string }
  | { kind: 'archive'; status: string };

export interface CardSemanticHit {
  id: string;
  title: string;
  sessionId?: string;
}

export interface CardSemanticResult {
  status: 'off' | 'preparing' | 'failed' | 'timeout' | 'ready';
  exact: CardSemanticHit[];
  semantic: CardSemanticHit[];
}

const exactPattern = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?(?![\w/-])(?:[?#][^\s,)]*)?|\bPR\s*#?\d+\b|#\d+\b|(?<![\w-])[A-Za-z0-9_-]{21}(?![\w-])/gi;

function exactKey(token: string): string {
  if (/^https:\/\//i.test(token)) {
    const url = new URL(token);
    return url.host.toLowerCase() + url.pathname.replace(/\/$/, '').toLowerCase();
  }
  const number = /^(?:PR\s*)?#?(\d+)$/i.exec(token);
  return number ? '#' + number[1] : token;
}

export function splitCardSearch(query: string, cardIds?: ReadonlySet<string>): { keys: Set<string>; text: string } {
  const keys = new Set<string>();
  if (/^\d+$/.test(query)) return { keys: new Set([exactKey(query)]), text: '' };
  const text = query.replace(exactPattern, token => {
    try {
      const key = exactKey(token);
      if (key === token && !key.startsWith('#') && !cardIds?.has(token)) return token;
      keys.add(key);
    } catch { return token; }
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  return { keys, text };
}

export function exactReferenceKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(exactPattern)) {
    try {
      const key = exactKey(match[0]);
      if (key.length <= 2_048) keys.add(key);
      const number = /\/pull\/(\d+)$/.exec(key)?.[1];
      if (number) keys.add('#' + number);
      // The lexical fallback remains available for exceptionally reference-heavy cards.
      if (keys.size >= 1_024) break;
    } catch {
      // Malformed references remain available through the ordinary keyword search.
    }
  }
  return [...keys];
}

export function exactCardSearchMatch(id: string, text: string, keys: Set<string>): boolean {
  if (keys.has(id)) return true;
  for (const token of text.matchAll(exactPattern)) {
    try {
      const key = exactKey(token[0]);
      if (keys.has(key)) return true;
      const urlNumber = /\/pull\/(\d+)$/.exec(key)?.[1];
      if (urlNumber && keys.has('#' + urlNumber)) return true;
    } catch {
      // Malformed URL text can still be matched by the existing keyword search.
    }
  }
  return false;
}

export function combineCardSearch<T extends CardSemanticHit>(keyword: T[], result: CardSemanticResult): CardSemanticHit[] {
  const exact = new Map(result.exact.map(hit => [hit.id, hit]));
  const ranked = new Map<string, { hit: CardSemanticHit; score: number }>();
  for (const list of [keyword, result.semantic]) {
    const seen = new Set<string>();
    list.forEach((hit, i) => {
      if (seen.has(hit.id) || exact.has(hit.id)) return;
      seen.add(hit.id);
      const score = (ranked.get(hit.id)?.score ?? 0) + 1 / (61 + i);
      ranked.set(hit.id, { hit, score });
    });
  }
  return [...exact.values(), ...[...ranked.values()]
    .sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id))
    .map(({ hit }) => hit)];
}
