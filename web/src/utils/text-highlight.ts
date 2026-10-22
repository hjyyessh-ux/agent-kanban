/**
 * Search-term highlighting through the CSS Custom Highlight API.
 *
 * The highlighted text is rendered by React (and by react-markdown), so
 * wrapping matches in `<mark>` would fight the reconciler. A registered
 * `Highlight` paints ranges without touching the DOM; style it with
 * `::highlight(<name>)`. Browsers without the API simply show no highlight.
 */

/** Start offsets of every case-insensitive, non-overlapping occurrence of `needle`. */
export function findMatchOffsets(text: string, needle: string): number[] {
  const query = needle.toLowerCase();
  if (!query) return [];
  const haystack = text.toLowerCase();
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(query, from);
    if (index < 0) return offsets;
    offsets.push(index);
    from = index + query.length;
  }
}

export function supportsTextHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/** Text under this attribute (UI labels like "PROMPT", tags, timestamps) is never highlighted. */
export const HIGHLIGHT_SKIP_ATTR = 'data-highlight-skip';

/** Highlight every occurrence of `needle` under `roots` as `name`; returns the match count. */
export function applyTextHighlight(name: string, roots: Array<Element | null>, needle: string): number {
  if (!supportsTextHighlight()) return 0;
  const query = needle.trim();
  if (!query) {
    CSS.highlights.delete(name);
    return 0;
  }

  const ranges: Range[] = [];
  for (const root of roots) {
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(`[${HIGHLIGHT_SKIP_ATTR}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (const offset of findMatchOffsets(text, query)) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + query.length);
        ranges.push(range);
      }
    }
  }

  CSS.highlights.set(name, new Highlight(...ranges));
  return ranges.length;
}

export function clearTextHighlight(name: string): void {
  if (supportsTextHighlight()) CSS.highlights.delete(name);
}
