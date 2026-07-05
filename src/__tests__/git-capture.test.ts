import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { captureGitStart, captureGitEndAndUsage } from '../plugin/runtimes/git-capture';
import { withTempDir } from './setup';

// Run a git command in `cwd`, throwing on failure (test setup must be reliable).
async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code})`);
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.email', 'test@example.com');
  await git(cwd, 'config', 'user.name', 'Test');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await git(cwd, 'checkout', '-q', '-b', 'main');
}

async function commit(cwd: string, file: string, content: string): Promise<void> {
  writeFileSync(join(cwd, file), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '-m', `add ${file}`);
}

// Run a callback with an isolated temporary git working tree.
async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'gitcap-repo-'));
  try {
    await initRepo(repo);
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('captureGitStart', () => {
  test('stamps start snapshot, repoRoot, and startBranches on the card', async () => {
    await withTempDir(async (dataDir) => {
      await withRepo(async (repo) => {
        await commit(repo, 'a.txt', 'hello');
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: repo });

        await captureGitStart(store, card.id, repo);

        const updated = await store.getCard(card.id);
        expect(updated?.git?.start?.branch).toBe('main');
        expect(updated?.git?.start?.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(updated?.git?.start?.dirty).toBe(false);
        expect(updated?.git?.startBranches?.main).toBe(updated?.git?.start?.commit);
        expect(updated?.git?.repoRoot).toBeTruthy();
      });
    });
  });

  test('is a no-op (no git field) outside a git repo', async () => {
    await withTempDir(async (dataDir) => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'gitcap-plain-'));
      try {
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: nonRepo });
        await captureGitStart(store, card.id, nonRepo);
        const updated = await store.getCard(card.id);
        expect(updated?.git).toBeUndefined();
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });
});

describe('captureGitEndAndUsage', () => {
  test('records end snapshot and per-branch commitsAdded for commits made during the run', async () => {
    await withTempDir(async (dataDir) => {
      await withRepo(async (repo) => {
        await commit(repo, 'a.txt', 'hello');
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: repo });

        await captureGitStart(store, card.id, repo);

        // Two new commits on main during the "run".
        await commit(repo, 'b.txt', 'world');
        await commit(repo, 'c.txt', 'again');

        await captureGitEndAndUsage(store, card.id, repo);

        const updated = await store.getCard(card.id);
        expect(updated?.git?.end?.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(updated?.git?.end?.commit).not.toBe(updated?.git?.start?.commit);
        const mainActivity = updated?.git?.branches?.find(b => b.branch === 'main');
        expect(mainActivity?.commitsAdded).toBe(2);
        expect(mainActivity?.baseCommit).toBe(updated?.git?.start?.commit);
        // bookkeeping map is consumed and dropped
        expect(updated?.git?.startBranches).toBeUndefined();
      });
    });
  });

  test('reports a new branch created during the run', async () => {
    await withTempDir(async (dataDir) => {
      await withRepo(async (repo) => {
        await commit(repo, 'a.txt', 'hello');
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: repo });
        await captureGitStart(store, card.id, repo);

        await git(repo, 'checkout', '-q', '-b', 'feature/x');
        await commit(repo, 'd.txt', 'feat');

        await captureGitEndAndUsage(store, card.id, repo);

        const updated = await store.getCard(card.id);
        const feat = updated?.git?.branches?.find(b => b.branch === 'feature/x');
        expect(feat).toBeTruthy();
        expect(feat?.baseCommit).toBeUndefined();
        expect(feat?.commitsAdded).toBe(2); // whole branch history reachable from new tip
      });
    });
  });

  test('aggregates usage from a provided events.jsonl path', async () => {
    await withTempDir(async (dataDir) => {
      await withRepo(async (repo) => {
        await commit(repo, 'a.txt', 'hello');
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: repo });
        await captureGitStart(store, card.id, repo);

        const eventsPath = join(repo, 'events.jsonl');
        writeFileSync(eventsPath, [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'pr-review' } }] } }),
          JSON.stringify({ type: 'system', subtype: 'task_started', subagent_type: 'Explore' }),
        ].join('\n'));

        await captureGitEndAndUsage(store, card.id, repo, eventsPath);

        const updated = await store.getCard(card.id);
        expect(updated?.usage?.tools).toEqual({ Read: 1 });
        expect(updated?.usage?.skillsUsed).toEqual(['pr-review']);
        expect(updated?.usage?.subagents).toEqual(['Explore']);
      });
    });
  });

  test('does not throw and writes nothing when cwd is not a git repo and no events given', async () => {
    await withTempDir(async (dataDir) => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'gitcap-plain-'));
      try {
        const store = new KanbanStore(dataDir);
        const card = await store.createCard({ title: 'T', description: 'D', projectDir: nonRepo });
        await captureGitEndAndUsage(store, card.id, nonRepo);
        const updated = await store.getCard(card.id);
        expect(updated?.git).toBeUndefined();
        expect(updated?.usage).toBeUndefined();
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });
});
