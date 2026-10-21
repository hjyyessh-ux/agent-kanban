/**
 * How the board groups finished work — the toolbar `GROUP: CARD | SESSION | WORKS`
 * segment. Web-only (never sent to the server), so it lives here rather than in
 * `src/core/types.ts`.
 *
 * - `card`    — complete column shows flat cards (done is always session-grouped)
 * - `session` — complete column groups turns into session groups
 * - `works`   — session groups, further gathered into their Work containers
 */
export type BoardGroupMode = 'card' | 'session' | 'works';

export const BOARD_GROUP_MODES: readonly BoardGroupMode[] = ['card', 'session', 'works'];

/**
 * The key predates the 3-way mode: it held the old boolean "세션 묶기" toggle
 * (`'true'`/`'false'`). It is kept so an upgrade lands on the same layout.
 */
export const BOARD_GROUP_MODE_STORAGE_KEY = 'kanban-complete-session-view';

/** Reads a stored value, migrating the legacy boolean: `'true'` → session, `'false'` → card. */
export function parseBoardGroupMode(stored: string | null | undefined): BoardGroupMode {
  if (stored === 'session' || stored === 'works' || stored === 'card') return stored;
  if (stored === 'true') return 'session';
  return 'card';
}

/** Session and Works modes both draw the complete column as session groups. */
export function groupsCompleteBySession(mode: BoardGroupMode): boolean {
  return mode !== 'card';
}
