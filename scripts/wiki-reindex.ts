#!/usr/bin/env bun
/**
 * wiki-reindex — rewrite index.md so each catalog row carries the document's
 * `processed` date and `topics`, enabling index-only search by date/topic
 * without scanning every document body.
 *
 * This is a pure reformat: it reads each existing index row, pulls `processed`
 * + `topics` from the referenced document's frontmatter, and re-emits the row
 * via the shared buildIndexLine(). No LLM calls, no document rewrites — so it
 * does NOT need a prompt-version bump or a reprocess. Idempotent: re-running
 * produces the same file (date/topic tokens are recomputed from frontmatter,
 * never appended).
 *
 * Usage: bun scripts/wiki-reindex.ts [vaultDir] [--dry-run]
 *   vaultDir   defaults to the wiki.vault_dir setting; pass it explicitly if unset
 *   --dry-run  print what would change without writing
 *
 * A timestamped index.md.bak-* is written before any change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndexLine } from '../src/plugin/wiki/wiki-writer';
import { loadWikiConfig } from '../src/plugin/wiki/wiki-config';
import { SettingsStore } from '../src/core/settings-store';
import { resolveKanbanDataDir } from '../src/core/data-dir';
import type { WikiDocType } from '../src/core/types';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicitVault = args.find(a => !a.startsWith('--'));

const vaultDir = explicitVault
  ?? (await loadWikiConfig(new SettingsStore(resolveKanbanDataDir()))).vaultDir;

if (!vaultDir.trim()) {
  console.error('[wiki-reindex] vault directory is not configured. Pass vaultDir or set wiki.vault_dir in Wiki settings.');
  process.exit(1);
}

const indexPath = join(vaultDir, 'index.md');
if (!existsSync(indexPath)) {
  console.error(`[wiki-reindex] no index.md at ${indexPath}`);
  process.exit(1);
}

/** Pull processed + topics from a document's YAML frontmatter (block or inline list). */
function readDocMeta(absPath: string): { processed?: string; topics: string[] } {
  const content = readFileSync(absPath, 'utf-8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const processed = fm.match(/^processed:\s*(.+)$/m)?.[1]?.trim();

  let topics: string[] = [];
  const inline = fm.match(/^topics:\s*\[(.*)\]\s*$/m);
  if (inline) {
    topics = inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  } else {
    const block = fm.match(/^topics:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
    if (block) {
      topics = block[1].split('\n').map(l => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  return { processed, topics };
}

const lines = readFileSync(indexPath, 'utf-8').split('\n');
let updated = 0;
let missing = 0;
const missingPaths: string[] = [];

const out = lines.map((line) => {
  // Only touch document rows: "- [[type/slug|title]] ... — summary"
  const head = line.match(/^- \[\[([^\]|]+)\|(.+?)\]\]/);
  if (!head) return line; // frontmatter, header, blank lines pass through
  const link = head[1];
  const title = head[2];
  const summary = line.match(/ — (.*)$/)?.[1]?.trim() ?? '';
  const type = link.split('/')[0] as WikiDocType;
  const docPath = `${link}.md`;
  const abs = join(vaultDir, docPath);
  if (!existsSync(abs)) {
    missing++;
    missingPaths.push(link);
    return line; // leave orphaned rows untouched
  }
  const { processed, topics } = readDocMeta(abs);
  updated++;
  return buildIndexLine({ docPath, title, type, summary, processed, topics });
});

console.log(`[wiki-reindex] vault=${vaultDir}`);
console.log(`[wiki-reindex] rows reformatted=${updated} missing-docs=${missing}`);
if (missing > 0) console.log(`[wiki-reindex] missing: ${missingPaths.slice(0, 10).join(', ')}${missing > 10 ? ' …' : ''}`);

if (dryRun) {
  const sample = out.find((l, i) => l !== lines[i] && l.startsWith('- [['));
  if (sample) console.log(`[wiki-reindex] dry-run sample:\n${sample}`);
  console.log('[wiki-reindex] dry-run: no file written');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(vaultDir, `index.md.bak-${stamp}`), readFileSync(indexPath));
writeFileSync(indexPath, out.join('\n'));
console.log(`[wiki-reindex] wrote ${indexPath} (backup index.md.bak-${stamp})`);
