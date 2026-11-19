/**
 * Shareable in-app links (no router — `App.tsx` reads and writes these).
 *
 * Canonical forms, all on the SPA root so the daemon's static serving never
 * needs a path fallback:
 *
 *   ?card=<cardId>                              card detail
 *   ?session=<sessionId>                        session conversation
 *   ?session=<sessionId>&msg=<cardId>:user      that turn's Prompt
 *   ?session=<sessionId>&msg=<cardId>:assistant that turn's Result
 *
 * `?card=` is also the form older links were shared with, so it stays the
 * canonical card URL. Only stable identifiers go into a link — never a search
 * query, prompt text, or a token: the link is pasted into chats and history.
 */

export type DeepLinkMessageRole = 'user' | 'assistant';

export interface DeepLinkMessage {
  /** The turn's card id. */
  cardId: string;
  role: DeepLinkMessageRole;
}

export type DeepLinkTarget =
  | { kind: 'card'; cardId: string }
  | { kind: 'session'; sessionId: string; message?: DeepLinkMessage };

export type ParsedDeepLink =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | DeepLinkTarget;

/** The query keys this module owns; everything else in the URL is preserved. */
export const DEEP_LINK_PARAMS = ['card', 'session', 'msg'] as const;

// nanoid card ids may start with `-` or `_`; a leading `.` is still refused.
const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const ROLES: readonly DeepLinkMessageRole[] = ['user', 'assistant'];

export function isValidLinkId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** `"<cardId>:<role>"` → message; `null` when the shape is wrong. */
export function parseMessageId(value: string): DeepLinkMessage | null {
  const at = value.lastIndexOf(':');
  if (at <= 0) return null;
  const cardId = value.slice(0, at);
  const role = value.slice(at + 1);
  if (!isValidLinkId(cardId)) return null;
  const known = ROLES.find((candidate) => candidate === role);
  return known ? { cardId, role: known } : null;
}

export function formatMessageId(message: DeepLinkMessage): string {
  return `${message.cardId}:${message.role}`;
}

export function parseDeepLink(search: string): ParsedDeepLink {
  const params = new URLSearchParams(search);
  const card = params.get('card');
  const session = params.get('session');
  const msg = params.get('msg');

  if (card !== null && session !== null) {
    return { kind: 'invalid', reason: '카드와 세션을 동시에 가리키는 링크입니다.' };
  }
  if (card !== null) {
    const cardId = card.trim();
    if (!isValidLinkId(cardId)) return { kind: 'invalid', reason: '카드 ID 형식이 올바르지 않습니다.' };
    return { kind: 'card', cardId };
  }
  if (session !== null) {
    const sessionId = session.trim();
    if (!isValidLinkId(sessionId)) return { kind: 'invalid', reason: '세션 ID 형식이 올바르지 않습니다.' };
    if (msg === null) return { kind: 'session', sessionId };
    const message = parseMessageId(msg.trim());
    if (!message) return { kind: 'invalid', reason: '메시지 ID 형식이 올바르지 않습니다.' };
    return { kind: 'session', sessionId, message };
  }
  if (msg !== null) return { kind: 'invalid', reason: '세션 없이 메시지만 가리키는 링크입니다.' };
  return { kind: 'none' };
}

/**
 * `search` with this module's keys replaced by `target` (or removed for
 * `null`). Unrelated params survive so a future feature's query is not eaten.
 */
export function buildDeepLinkSearch(currentSearch: string, target: DeepLinkTarget | null): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of DEEP_LINK_PARAMS) params.delete(key);
  if (target?.kind === 'card') {
    params.set('card', target.cardId);
  } else if (target?.kind === 'session') {
    params.set('session', target.sessionId);
    if (target.message) params.set('msg', formatMessageId(target.message));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Path + query for `history.pushState`, keeping the current hash. */
export function buildDeepLinkPath(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  target: DeepLinkTarget | null,
): string {
  return `${location.pathname}${buildDeepLinkSearch(location.search, target)}${location.hash}`;
}

/** Absolute URL for the clipboard — the SPA root of the current origin. */
export function buildDeepLinkUrl(
  location: Pick<Location, 'origin' | 'pathname'>,
  target: DeepLinkTarget,
): string {
  return `${location.origin}${location.pathname}${buildDeepLinkSearch('', target)}`;
}

export function sameDeepLinkTarget(a: DeepLinkTarget | null, b: DeepLinkTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'card' || b.kind === 'card') {
    return a.kind === 'card' && b.kind === 'card' && a.cardId === b.cardId;
  }
  return a.sessionId === b.sessionId
    && (a.message ? formatMessageId(a.message) : '') === (b.message ? formatMessageId(b.message) : '');
}

/**
 * The browser location, or the SPA root when rendered without a DOM (the
 * component tests render with `renderToString`).
 */
export function linkLocation(): Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'> {
  if (typeof window === 'undefined') return { origin: '', pathname: '/', search: '', hash: '' };
  return window.location;
}
