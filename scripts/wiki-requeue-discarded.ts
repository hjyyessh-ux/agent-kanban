#!/usr/bin/env bun
/**
 * wiki-requeue-discarded — one-off repair for archived cards that the old
 * "discarded Work" rule retired from the wiki queue.
 *
 * A previous WikiWorker version stamped every wiki-pending card of a `discarded`
 * Work as a terminal `decision: 'skipped'` / `skipReason: 'Work discarded'`.
 * Discarding a Work now only means the Work grouping is abandoned, so those
 * cards should run the ordinary per-session wiki flow. This script puts them
 * back to `status: 'pending'`, clearing the stale skip bookkeeping
 * (`decision` / `skipReason` / `processedAt`) while keeping `queuedAt` fresh.
 *
 * Only cards whose `wiki.skipReason` is exactly 'Work discarded' are touched —
 * triage-authored skip reasons are left alone.
 *
 * Usage: bun scripts/wiki-requeue-discarded.ts [--dry-run]
 *   --dry-run  list the matching cards without writing anything
 *
 * Uses the real data dir (~/.agent-kanban, KANBAN_DATA_DIR respected). Safe to
 * run next to a live plugin process — the store takes the same cross-process
 * file locks. The running WikiWorker picks the re-queued cards up on its next
 * pass (or immediately via the WIKI tab's kick).
 */
import { KanbanStore } from '../src/core/store';
import { resolveKanbanDataDir } from '../src/core/data-dir';
import type { CardWikiState } from '../src/core/types';

/** The exact marker written by the removed skipDiscardedWorkCards() path. */
const LEGACY_SKIP_REASON = 'Work discarded';

const dryRun = process.argv.includes('--dry-run');
const dataDir = resolveKanbanDataDir();
const store = new KanbanStore(dataDir);

console.log(`[wiki-requeue-discarded] dataDir=${dataDir}`);

const archived = await store.getCards({ includeArchived: true });
const targets = archived.filter(card => card.wiki?.skipReason === LEGACY_SKIP_REASON);

console.log(`[wiki-requeue-discarded] matched ${targets.length} card(s) with skipReason='${LEGACY_SKIP_REASON}'`);
for (const card of targets.slice(0, 20)) {
  console.log(`  - ${card.id} | session=${card.sessionId ?? '-'} | ${card.title}`);
}
if (targets.length > 20) {
  console.log(`  … and ${targets.length - 20} more`);
}

if (targets.length === 0) {
  console.log('[wiki-requeue-discarded] nothing to do');
  process.exit(0);
}

if (dryRun) {
  console.log('[wiki-requeue-discarded] dry-run: no cards written');
  process.exit(0);
}

const now = new Date().toISOString();
const updates: Record<string, CardWikiState> = {};
for (const card of targets) {
  // Drop the terminal skip bookkeeping; keep any prior classification fields so
  // a later reprocess can still overwrite an existing document in place.
  const { decision: _decision, skipReason: _skipReason, processedAt: _processedAt, error: _error, ...rest }
    = card.wiki ?? { status: 'pending' as const };
  updates[card.id] = { ...rest, status: 'pending', queuedAt: now };
}

const updated = await store.updateArchivedCardsWiki(updates);
console.log(`[wiki-requeue-discarded] re-queued ${updated} card(s) as wiki-pending`);
