import { describe, test, expect } from 'bun:test';
import { diffBranches } from '../core/git-info';

describe('diffBranches', () => {
  test('reports a branch whose tip SHA changed', () => {
    const before = new Map([['main', 'aaa']]);
    const after = new Map([['main', 'bbb']]);
    expect(diffBranches(before, after)).toEqual([
      { branch: 'main', headCommit: 'bbb', baseCommit: 'aaa' },
    ]);
  });

  test('omits branches whose tip is unchanged', () => {
    const before = new Map([['main', 'aaa'], ['dev', 'ccc']]);
    const after = new Map([['main', 'aaa'], ['dev', 'ddd']]);
    expect(diffBranches(before, after)).toEqual([
      { branch: 'dev', headCommit: 'ddd', baseCommit: 'ccc' },
    ]);
  });

  test('reports a new branch with no baseCommit', () => {
    const before = new Map([['main', 'aaa']]);
    const after = new Map([['main', 'aaa'], ['feature/x', 'eee']]);
    expect(diffBranches(before, after)).toEqual([
      { branch: 'feature/x', headCommit: 'eee' },
    ]);
  });

  test('ignores branches that disappeared (only after-branches are considered)', () => {
    const before = new Map([['main', 'aaa'], ['gone', 'zzz']]);
    const after = new Map([['main', 'aaa']]);
    expect(diffBranches(before, after)).toEqual([]);
  });

  test('derives commitsAdded from supplied commit counts on a changed branch', () => {
    const before = new Map([['main', 'aaa']]);
    const after = new Map([['main', 'bbb']]);
    const counts = {
      before: new Map([['main', 10]]),
      after: new Map([['main', 13]]),
    };
    expect(diffBranches(before, after, counts)).toEqual([
      { branch: 'main', headCommit: 'bbb', baseCommit: 'aaa', commitsAdded: 3 },
    ]);
  });

  test('counts all commits of a new branch as added (base defaults to 0)', () => {
    const before = new Map<string, string>();
    const after = new Map([['feature/x', 'eee']]);
    const counts = { after: new Map([['feature/x', 4]]) };
    expect(diffBranches(before, after, counts)).toEqual([
      { branch: 'feature/x', headCommit: 'eee', commitsAdded: 4 },
    ]);
  });

  test('omits commitsAdded when counts are absent', () => {
    const before = new Map([['main', 'aaa']]);
    const after = new Map([['main', 'bbb']]);
    const [entry] = diffBranches(before, after);
    expect(entry).not.toHaveProperty('commitsAdded');
  });

  test('skips a negative delta (history rewrite / force-push) rather than reporting it', () => {
    const before = new Map([['main', 'aaa']]);
    const after = new Map([['main', 'bbb']]);
    const counts = {
      before: new Map([['main', 13]]),
      after: new Map([['main', 10]]),
    };
    const [entry] = diffBranches(before, after, counts);
    expect(entry).not.toHaveProperty('commitsAdded');
  });

  test('returns an empty list for two empty snapshots', () => {
    expect(diffBranches(new Map(), new Map())).toEqual([]);
  });
});
