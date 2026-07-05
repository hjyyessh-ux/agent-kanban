// Card git/usage capture, wired into the dispatch (start) and completion (end)
// paths. Every function is best-effort and NEVER throws — a capture failure
// must not block dispatch nor stop a card from completing. This module is the
// single integration point so both dispatch paths (standalone runtime-host and
// embedded plugin/index) and both completion paths (claude-adapter and the
// opencode session.idle handler) share identical behavior.

import { existsSync } from 'node:fs';
import type { KanbanStore } from '../../core/store';
import type { CardGitState, CardUsageStats } from '../../core/types';
import {
  isGitRepo,
  getRepoRoot,
  captureSnapshot,
  snapshotAllBranches,
  countCommits,
  diffBranches,
} from '../../core/git-info';
import { aggregateUsage, aggregateCodexUsage } from './usage-aggregator';

// Which runtime's stream format the events.jsonl is in. Picks the matching
// usage parser; defaults to claude when omitted (back-compat with callers
// that predate codex usage capture).
export type UsageFormat = 'claude' | 'codex';

/**
 * Capture the working tree's git starting state at dispatch time and stamp it
 * onto the card (`git.start`, `git.startBranches`, `git.repoRoot`). The branch
 * map is persisted so the completion path can diff against it. No-op for
 * non-git dirs. Swallows all errors.
 */
export async function captureGitStart(store: KanbanStore, cardId: string, cwd: string): Promise<void> {
  try {
    if (!(await isGitRepo(cwd))) return;
    const [start, branchMap, repoRoot] = await Promise.all([
      captureSnapshot(cwd),
      snapshotAllBranches(cwd),
      getRepoRoot(cwd),
    ]);
    if (!start) return;

    const git: CardGitState = {
      start,
      startBranches: Object.fromEntries(branchMap),
      updatedAt: new Date().toISOString(),
    };
    if (repoRoot) git.repoRoot = repoRoot;

    await store.updateCard(cardId, { git });
  } catch {
    // swallow — git capture must never break dispatch
  }
}

/**
 * Capture the working tree's git ending state plus per-branch activity, and
 * (when `eventsPath` is supplied) aggregate tool/skill/MCP/subagent usage from
 * the run's events.jsonl. Stamps `git.end`/`git.branches` and `usage` onto the
 * card, dropping the `startBranches` bookkeeping. Swallows all errors so a
 * capture failure never blocks completion or queue auto-dispatch.
 *
 * `eventsPath` is the claude/codex runtime run log; the opencode session.idle
 * path has no such file, so usage is simply skipped there (git still captured).
 * `usageFormat` selects the stream parser for `eventsPath` (default 'claude').
 */
export async function captureGitEndAndUsage(
  store: KanbanStore,
  cardId: string,
  cwd: string,
  eventsPath?: string,
  usageFormat: UsageFormat = 'claude',
): Promise<void> {
  try {
    const card = await store.getCard(cardId);
    if (!card) return;

    let git: CardGitState | undefined;
    if (await isGitRepo(cwd)) {
      const end = await captureSnapshot(cwd);
      if (end) {
        const prior = card.git;
        const beforeMap = new Map<string, string>(Object.entries(prior?.startBranches ?? {}));
        const afterMap = await snapshotAllBranches(cwd);
        const branches = diffBranches(beforeMap, afterMap);

        // Enrich each changed branch with the exact number of commits added
        // (base..head, or the whole new branch when there is no base).
        for (const branch of branches) {
          const range = branch.baseCommit ? `${branch.baseCommit}..${branch.headCommit}` : branch.headCommit;
          if (!range) continue;
          const count = await countCommits(cwd, range);
          if (count !== null) branch.commitsAdded = count;
        }

        git = {
          ...(prior?.repoRoot ? { repoRoot: prior.repoRoot } : {}),
          ...(prior?.start ? { start: prior.start } : {}),
          end,
          ...(branches.length ? { branches } : {}),
          updatedAt: new Date().toISOString(),
        };
        // startBranches intentionally omitted — bookkeeping is consumed here.
      }
    }

    let usage: CardUsageStats | undefined;
    if (eventsPath && existsSync(eventsPath)) {
      const text = await Bun.file(eventsPath).text();
      const lines = text.split('\n');
      const aggregated = usageFormat === 'codex'
        ? aggregateCodexUsage(lines)
        : aggregateUsage(lines);
      // Only attach when there is real signal (more than the updatedAt stamp).
      if (Object.keys(aggregated).length > 1) usage = aggregated;
    }

    if (!git && !usage) return;
    await store.updateCard(cardId, {
      ...(git ? { git } : {}),
      ...(usage ? { usage } : {}),
    });
  } catch {
    // swallow — git/usage capture must never block completion
  }
}
