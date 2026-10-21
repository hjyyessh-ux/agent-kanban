/**
 * Number of slots in the directory palette (`--kv2-dir-1` … `--kv2-dir-8` in
 * `kanban-v2.tokens.css`). Adding a colour means adding a token *and* a
 * `.works-dir-c{n}` rule (`styles/kv2/project-color.css`).
 */
export const DIR_COLOR_SLOTS = 8;

/**
 * Stable palette slot (1…`DIR_COLOR_SLOTS`) for a `projectDir`, or null when the
 * session/Work/card has none.
 *
 * Triage is a matching game — "which of these Works belongs to the project this
 * session came from" — and a colour answers it faster than reading eight paths.
 * The hash is over the **full path**, not the last segment, so two different
 * checkouts that happen to end in `web` do not claim the same colour. It is a
 * plain deterministic string hash (FNV-1a): the same directory gets the same
 * colour on every machine, in every session, with no state to keep.
 *
 * Shared by every screen that colours a project (Works, Timeline, mentions,
 * board) so the same directory is the same colour everywhere.
 */
export function projectDirColorSlot(projectDir: string | undefined): number | null {
  if (!projectDir) return null;
  const path = projectDir.replace(/\/+$/, '');
  if (!path) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % DIR_COLOR_SLOTS) + 1;
}

/**
 * Class that publishes a directory's colour as `--works-dir-accent` for the
 * element and its children; empty string when there is no directory (callers
 * concatenate it, and the CSS falls back to transparent).
 */
export function dirAccentClass(projectDir: string | undefined): string {
  const slot = projectDirColorSlot(projectDir);
  return slot === null ? '' : `works-dir-c${slot}`;
}
