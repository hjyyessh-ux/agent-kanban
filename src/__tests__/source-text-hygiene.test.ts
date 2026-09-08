import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Source files must stay text, because git decides that byte by byte.
 *
 * `timelineRows.ts` shipped with a literal NUL inside `DIR_NONE_KEY` — the
 * sentinel was written as `'\0no-dir'` where the comment (and every other
 * sentinel in this codebase) says a leading *space*. It ran fine: JS strings
 * hold NUL, React keys hold NUL, and the day-grid grouping never noticed. What
 * noticed was every tool that reads the file as text. `git diff` classified the
 * whole 500-line module as `Bin 0 -> 17687 bytes` and printed no content, so
 * the file was un-reviewable in a diff and would stay that way for every future
 * change to it; `grep -n` silently returned nothing for patterns that were
 * plainly there, which is the worse failure because it looks like an answer.
 *
 * The value of the sentinel is arbitrary — `buildTimelineRows` special-cases
 * `DIR_NONE_KEY` by identity when sorting, so no byte ordering depends on it —
 * which is exactly why nothing else was ever going to catch this.
 */
const ROOTS = ['src', 'web/src', 'e2e', 'scripts', 'docs'];
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.css', '.md', '.json', '.html'];
const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Control characters that are never legitimate in source text (tab/LF/CR are). */
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function textFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...textFilesUnder(full));
    else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

describe('source files are text, not binary', () => {
  test('no tracked source file carries a NUL or other stray control byte', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of textFilesUnder(join(REPO_ROOT, root))) {
        const content = readFileSync(file, 'utf8');
        const match = FORBIDDEN.exec(content);
        if (!match) continue;
        const line = content.slice(0, match.index).split('\n').length;
        const code = match[0].charCodeAt(0).toString(16).padStart(2, '0');
        offenders.push(`${relative(REPO_ROOT, file)}:${line} → 0x${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the day-grid sentinel is a plain leading space', async () => {
    const { DIR_NONE_KEY } = await import('../../web/src/components/Works/timelineRows');
    expect(DIR_NONE_KEY).toBe(' no-dir');
    expect(FORBIDDEN.test(DIR_NONE_KEY)).toBe(false);
  });
});
