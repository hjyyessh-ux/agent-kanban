import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Guards the token-map contract (docs/dark-mode-token-map.md): every color in
// kv2 CSS must route through a --kv2-* token so the dark-theme block can
// repaint it. New hex/rgba literals must go through the map's Rule A/B/C, not
// straight into a component stylesheet.
const STYLES_ROOT = join(import.meta.dir, '..');
const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;

// Wiki console log lines intentionally mirror the fixed VS Code syntax
// palette (see docs/dark-mode-token-map.md Allowlist) and are never themed.
const ALLOWLIST: Record<string, string[]> = {
  'components/Wiki/Wiki.css': ['#569cd6', '#6a9955', '#d7ba7d', '#c586c0', '#d4d4d4', '#f48771'],
};

function findCssFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findCssFiles(full));
    } else if (entry.name.endsWith('.css') && entry.name !== 'kanban-v2.tokens.css') {
      files.push(full);
    }
  }
  return files;
}

describe('kv2 dark-mode token guard', () => {
  test('no hard-coded hex/rgba colors outside kanban-v2.tokens.css and the documented allowlist', () => {
    const violations: string[] = [];

    for (const file of findCssFiles(STYLES_ROOT)) {
      const relPath = relative(STYLES_ROOT, file);
      const allowed = ALLOWLIST[relPath] ?? [];
      const lines = readFileSync(file, 'utf-8').split('\n');

      lines.forEach((line, index) => {
        const matches = line.match(COLOR_PATTERN);
        if (!matches) return;
        for (const match of matches) {
          if (allowed.some((literal) => line.includes(literal))) continue;
          violations.push(`${relPath}:${index + 1}: ${match} — ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
