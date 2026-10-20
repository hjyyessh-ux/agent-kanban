/** Visible id length everywhere (`#` + 8). Card ids, session UUIDs and work ids all share it. */
export const ID_DISPLAY_LENGTH = 8;

/** `#24b90f31` — the one short form for any opaque id (card, session, work). */
export function formatShortId(id: string): string {
  return `#${id.slice(0, ID_DISPLAY_LENGTH)}`;
}
