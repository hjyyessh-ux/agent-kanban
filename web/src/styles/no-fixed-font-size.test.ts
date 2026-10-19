import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Guards the font-scale contract (docs/design-system.md "Font scale"): every
// text size routes through a `--kv2-text-*` token, which multiplies by
// `--kv2-font-scale`. A `px` or `rem` font-size ignores the user's text-size
// setting entirely — `rem` included, because `base.css` pins the root at 16px.
// Relative `em` / `%` sizes are allowed: they follow their tokenised parent.
const STYLES_ROOT = join(import.meta.dir, '..');
const FIXED_FONT_SIZE = /font-size:\s*([0-9.]+(?:px|rem))\b/g;

// Known debt, frozen at its current size. Each entry is consumed once, so a
// file may lose a literal (convert it and delete the entry) but never gain one.
// `base.css` is the exception by design: it is the unscaled root type ramp.
const ALLOWLIST: Record<string, string[]> = {
  'styles/base.css': ['16px', '2.5rem', '2rem', '1.5rem', '1.25rem', '1.125rem', '1rem', '1rem'],
  'styles/kv2/board.css': [
    '0.62rem', '0.68rem', '0.68rem', '0.72rem', '11px', '11px', '0.85rem',
    '10px', '12px', '0.9rem', '10px', '11px',
  ],
  'styles/kv2/panels.css': ['1.45rem', '1.28rem', '1.12rem', '1rem', '10px', '10px'],
  'styles/kv2/card-detail.css': ['10px'],
  'styles/kv2/primitives.css': ['1rem'],
  'components/Capabilities/Capabilities.css': [
    '18px', '11px', '14px', '12px', '14px', '10px', '2rem', '0.65rem', '2.5rem',
  ],
  'components/Settings/Settings.css': ['12px', '20px'],
};

function findCssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findCssFiles(full));
    } else if (entry.name.endsWith('.css') && entry.name !== 'kanban-v2.tokens.css') {
      files.push(full);
    }
  }
  return files;
}

describe('kv2 font-scale guard', () => {
  test('no px/rem font-size outside kanban-v2.tokens.css and the frozen allowlist', () => {
    const violations: string[] = [];

    for (const file of findCssFiles(STYLES_ROOT)) {
      const relPath = relative(STYLES_ROOT, file);
      const remaining = [...(ALLOWLIST[relPath] ?? [])];
      const lines = readFileSync(file, 'utf-8').split('\n');

      lines.forEach((line, index) => {
        for (const match of line.matchAll(FIXED_FONT_SIZE)) {
          const allowedAt = remaining.indexOf(match[1]);
          if (allowedAt !== -1) {
            remaining.splice(allowedAt, 1);
            continue;
          }
          violations.push(`${relPath}:${index + 1}: ${match[1]} — use a --kv2-text-* token`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
