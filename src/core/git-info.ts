// Git activity capture for kanban cards. No-dep: shells out to `git` via
// Bun.spawn. Every capture is best-effort — non-git dirs, detached HEAD,
// fresh repos with no commits, and worktrees all degrade to null/empty
// instead of throwing. `diffBranches` is a pure function so the branch-diff
// logic can be unit-tested without a real repository.
//
// remoteUrl is intentionally NOT captured: remote URLs can embed tokens
// (https://x-access-token:...@host/...) and leaking those into card JSON is
// a credential-exposure risk. (1차 제외 — 후속 카드에서 마스킹과 함께 재검토)

import type { CardGitSnapshot, CardGitBranchActivity } from './types';

interface GitResult {
  ok: boolean;
  stdout: string;
}

// Run a git subcommand in `cwd`. Returns ok=false (never throws) on any
// failure — missing binary, non-zero exit, or spawn error. GIT_OPTIONAL_LOCKS=0
// avoids touching the index lock for read-only queries.
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** True when `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const { ok, stdout } = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return ok && stdout === 'true';
}

/** Absolute repository root for `cwd`, or null when not a repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  const { ok, stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
  return ok && stdout ? stdout : null;
}

/**
 * Capture the current branch, HEAD commit, and dirty flag.
 * Returns null for non-git dirs or repos with no commit yet (unborn HEAD).
 * Detached HEAD yields branch='HEAD' (graceful, not an error).
 */
export async function captureSnapshot(cwd: string): Promise<CardGitSnapshot | null> {
  if (!(await isGitRepo(cwd))) return null;

  const commitRes = await git(cwd, ['rev-parse', 'HEAD']);
  if (!commitRes.ok || !commitRes.stdout) return null; // unborn HEAD / no commits

  const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusRes = await git(cwd, ['status', '--porcelain']);

  return {
    branch: branchRes.ok && branchRes.stdout ? branchRes.stdout : 'HEAD',
    commit: commitRes.stdout,
    dirty: statusRes.stdout.length > 0,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Map every local branch to its tip SHA. Empty map for non-git dirs or repos
 * with no branches. Used as the before/after input to `diffBranches`.
 */
export async function snapshotAllBranches(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!(await isGitRepo(cwd))) return result;

  const { ok, stdout } = await git(cwd, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads',
  ]);
  if (!ok || !stdout) return result;

  for (const line of stdout.split('\n')) {
    const sep = line.indexOf(' ');
    if (sep <= 0) continue;
    const branch = line.slice(0, sep);
    const sha = line.slice(sep + 1).trim();
    if (branch && sha) result.set(branch, sha);
  }
  return result;
}

/**
 * Total commit count reachable from a ref (`git rev-list --count`). Returns
 * null on failure. The optional `commitCounts` input to `diffBranches` is
 * built from this so `commitsAdded` can be derived; capturing it lives in the
 * integration layer (2/4), not in the pure diff.
 */
export async function countCommits(cwd: string, ref: string): Promise<number | null> {
  const { ok, stdout } = await git(cwd, ['rev-list', '--count', ref]);
  if (!ok) return null;
  const n = Number.parseInt(stdout, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure diff of two branch→SHA snapshots. Returns one entry per branch whose
 * tip changed or that is new in `after`; unchanged branches are omitted.
 *
 * `commitsAdded` is only populated when `commitCounts` is supplied (the pure
 * function cannot count commits between two SHAs on its own). For a new branch
 * the base count defaults to 0.
 */
export function diffBranches(
  before: Map<string, string>,
  after: Map<string, string>,
  commitCounts?: { before?: Map<string, number>; after?: Map<string, number> },
): CardGitBranchActivity[] {
  const activity: CardGitBranchActivity[] = [];

  for (const [branch, headCommit] of after) {
    const baseCommit = before.get(branch);
    if (baseCommit === headCommit) continue; // unchanged → no activity

    const entry: CardGitBranchActivity = { branch, headCommit };
    if (baseCommit !== undefined) entry.baseCommit = baseCommit;

    const afterCount = commitCounts?.after?.get(branch);
    if (afterCount !== undefined) {
      const beforeCount = commitCounts?.before?.get(branch) ?? 0;
      const delta = afterCount - beforeCount;
      if (delta >= 0) entry.commitsAdded = delta;
    }

    activity.push(entry);
  }

  return activity;
}
