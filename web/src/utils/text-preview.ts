const PREVIEW_MAX_CHARS = 160;
const BLOCK_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/;

/**
 * The first meaningful line of a markdown body, as plain text — the folded
 * turn preview in the session modal and the `최근 결과` / `메모` line of a Works
 * list row.
 *
 * - Link and emphasis syntax go first, so `**1. 결과**` and
 *   `[설정 절차](https://…)` read as `결과` and `설정 절차`.
 * - Block prefixes are stripped until none is left (`### 1. 왜` → `왜`).
 * - `_` is only emphasis at a word edge — `ghes_migration` keeps its underscore.
 * - Code-fence lines (```` ```text ````) and rules (`---`, `|---|`) are skipped.
 */
export function previewLine(text: string | undefined): string {
  if (!text) return '';
  const line = text.split('\n')
    .filter((raw) => !/^\s*(```|~~~)/.test(raw))
    .map((raw) => {
      let plain = raw
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|[*`]/g, '')
        .replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, '$1$2');
      while (BLOCK_PREFIX.test(plain)) plain = plain.replace(BLOCK_PREFIX, '');
      return plain.trim();
    })
    .find((raw) => raw.length > 0 && !/^[-=|:\s]+$/.test(raw));
  if (!line) return '';
  return line.length > PREVIEW_MAX_CHARS ? `${line.slice(0, PREVIEW_MAX_CHARS)}…` : line;
}
