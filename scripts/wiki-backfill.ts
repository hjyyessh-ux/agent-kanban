#!/usr/bin/env bun
/**
 * wiki-backfill — queue unprocessed/outdated archived cards and process them
 * into the Obsidian vault wiki, printing progress every 30s.
 *
 * Usage: bun scripts/wiki-backfill.ts [--dry-run] [--concurrency N] [--limit N]
 *   --dry-run        only report how many cards/session groups would be queued
 *   --concurrency N  parallel session groups (default 4); vault writes stay serialized
 *   --limit N        queue only the N most recent candidate cards (0 = no limit)
 *
 * Uses the real data dir (~/.agent-kanban, KANBAN_DATA_DIR respected) and the
 * wiki.* settings from settings.json. Safe to run next to a live plugin process
 * — stores share the same cross-process file locks.
 */
import { KanbanStore } from '../src/core/store';
import { SettingsStore } from '../src/core/settings-store';
import { WikiWorker, groupCardsBySession } from '../src/plugin/wiki/wiki-worker';
import { WIKI_PROMPT_VERSION, loadWikiConfig } from '../src/plugin/wiki/wiki-config';
import { resolveKanbanDataDir } from '../src/core/data-dir';

const dryRun = process.argv.includes('--dry-run');
const dataDir = resolveKanbanDataDir();
const store = new KanbanStore(dataDir);
const settingsStore = new SettingsStore(dataDir);
const config = await loadWikiConfig(settingsStore);

console.log(`[wiki-backfill] dataDir=${dataDir}`);
console.log(`[wiki-backfill] vault=${config.vaultDir} model=${config.model} enabled=${config.enabled} promptVersion=${WIKI_PROMPT_VERSION}`);

if (dryRun) {
  const archived = await store.getCards({ includeArchived: true });
  const targets = archived.filter(c =>
    c.status === 'done' && !c.deletedAt && (
      !c.wiki || c.wiki.status === 'failed' || (c.wiki.promptVersion ?? 0) < WIKI_PROMPT_VERSION
    ),
  );
  const groups = groupCardsBySession(targets);
  console.log(`[wiki-backfill] dry-run: ${targets.length} cards in ${groups.length} session groups would be queued`);
  process.exit(0);
}

if (!config.vaultDir.trim()) {
  console.error('[wiki-backfill] vault directory is not configured. Set wiki.vault_dir in Wiki settings first.');
  process.exit(1);
}
if (!config.enabled) {
  console.error('[wiki-backfill] wiki is disabled. Enable LLM Wiki in Wiki settings first.');
  process.exit(1);
}

const concurrencyArg = process.argv.indexOf('--concurrency');
const concurrency = concurrencyArg !== -1 ? Number(process.argv[concurrencyArg + 1]) || 4 : 4;
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;

const worker = new WikiWorker(store, settingsStore, { concurrency });
console.log(`[wiki-backfill] concurrency=${concurrency} limit=${limit > 0 ? limit : 'none'}`);
const queued = await store.markWikiPending({
  currentPromptVersion: WIKI_PROMPT_VERSION,
  ...(limit > 0 ? { limit } : {}),
});
console.log(`[wiki-backfill] queued ${queued} cards`);

const progress = setInterval(() => {
  void worker.getStatus().then((s) => {
    console.log(`[wiki-backfill] progress ${s.processedInRun}/${s.totalInRun} pending=${s.pendingCount}${s.lastError ? ` lastError=${s.lastError.slice(0, 120)}` : ''}`);
  }).catch(() => {});
}, 30_000);

await worker.processQueue();
clearInterval(progress);

const status = await worker.getStatus();
console.log(`[wiki-backfill] done. remaining pending=${status.pendingCount} lastError=${status.lastError ?? '-'}`);
