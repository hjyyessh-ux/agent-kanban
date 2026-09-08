import { describe, test, expect } from 'bun:test';
import {
  WORK_LIST_SORTS,
  isWorkListSort,
  selectWorks,
  workPlanOverrunDays,
  workProjectDirs,
} from '../core/work-list';
import type { Work } from '../core/types';

/**
 * The Works tab had no search, no directory filter and no sort at all: the list
 * was `updatedAt` descending, full stop. That is exactly the wrong order for the
 * question it is usually asked — a Work nobody has touched for three weeks sank
 * to the bottom, which is where it was already invisible — and a planned end
 * that had come and gone was indistinguishable from one still in the future.
 *
 * `selectWorks` is the one rule behind both `GET /api/works` and the Active
 * section's client-side narrowing, so it is pinned here as a pure function.
 */

function work(input: Partial<Work> & { id: string }): Work {
  return {
    title: input.id,
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...input,
  };
}

const NOW = Date.parse('2026-09-10T00:00:00.000Z');

describe('selectWorks — filtering', () => {
  test('an omitted query keeps everything, most recently updated first', () => {
    const older = work({ id: 'a', updatedAt: '2026-09-02T00:00:00.000Z' });
    const newer = work({ id: 'b', updatedAt: '2026-09-05T00:00:00.000Z' });
    expect(selectWorks([older, newer]).map(w => w.id)).toEqual(['b', 'a']);
  });

  test('does not mutate or reorder its input', () => {
    const works = [
      work({ id: 'a', updatedAt: '2026-09-02T00:00:00.000Z' }),
      work({ id: 'b', updatedAt: '2026-09-05T00:00:00.000Z' }),
    ];
    selectWorks(works, { sort: 'stale' });
    expect(works.map(w => w.id)).toEqual(['a', 'b']);
  });

  test('status narrows the list', () => {
    const works = [
      work({ id: 'a' }),
      work({ id: 'b', status: 'done' }),
      work({ id: 'c', status: 'discarded' }),
    ];
    expect(selectWorks(works, { status: 'done' }).map(w => w.id)).toEqual(['b']);
  });

  test('projectDir is an exact match, not a suffix', () => {
    const works = [
      work({ id: 'a', projectDir: '/repo/web' }),
      work({ id: 'b', projectDir: '/repo' }),
      work({ id: 'c' }),
    ];
    expect(selectWorks(works, { projectDir: '/repo' }).map(w => w.id)).toEqual(['b']);
  });

  test('q matches the title case-insensitively', () => {
    const works = [
      work({ id: 'a', title: 'Wiki 파이프라인 리팩터링' }),
      work({ id: 'b', title: 'Timeline 드래그' }),
    ];
    expect(selectWorks(works, { q: 'wiki' }).map(w => w.id)).toEqual(['a']);
    expect(selectWorks(works, { q: 'WIKI' }).map(w => w.id)).toEqual(['a']);
  });

  test('q also reaches the directory, the notes and the Summary lines', () => {
    // The two places a Work says what it is *about* are the human note and the
    // generated summary. Searching titles alone made a Work findable only by
    // whichever first prompt it happened to be seeded from.
    const byDir = work({ id: 'dir', projectDir: '/Users/me/workspace/agent-kanban' });
    const byNotes = work({ id: 'notes', notes: '락 순서 정리부터 다시' });
    const bySummary = work({
      id: 'summary',
      summary: { lines: ['dual lock 순서를 바꿨다'], generatedAt: '', model: 'm' },
    });
    const works = [byDir, byNotes, bySummary, work({ id: 'other' })];

    expect(selectWorks(works, { q: 'agent-kanban' }).map(w => w.id)).toEqual(['dir']);
    expect(selectWorks(works, { q: '락 순서' }).map(w => w.id)).toEqual(['notes']);
    expect(selectWorks(works, { q: 'dual lock' }).map(w => w.id)).toEqual(['summary']);
  });

  test('a blank q is not a filter', () => {
    const works = [work({ id: 'a' }), work({ id: 'b' })];
    expect(selectWorks(works, { q: '   ' })).toHaveLength(2);
  });

  test('filters compose', () => {
    const works = [
      work({ id: 'a', projectDir: '/repo', title: 'wiki 정리', status: 'active' }),
      work({ id: 'b', projectDir: '/repo', title: 'wiki 정리', status: 'done' }),
      work({ id: 'c', projectDir: '/other', title: 'wiki 정리' }),
    ];
    expect(selectWorks(works, { status: 'active', projectDir: '/repo', q: 'wiki' }).map(w => w.id))
      .toEqual(['a']);
  });
});

describe('selectWorks — sorting', () => {
  const a = work({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' });
  const b = work({ id: 'b', updatedAt: '2026-09-05T00:00:00.000Z' });
  const c = work({ id: 'c', updatedAt: '2026-09-03T00:00:00.000Z' });

  test('updated is most recent activity first', () => {
    expect(selectWorks([a, b, c], { sort: 'updated' }).map(w => w.id)).toEqual(['b', 'c', 'a']);
  });

  test('stale is the exact mirror — longest untouched first', () => {
    expect(selectWorks([a, b, c], { sort: 'stale' }).map(w => w.id)).toEqual(['a', 'c', 'b']);
  });

  test('planned puts the nearest planned end first', () => {
    const soon = work({ id: 'soon', resolvedAt: '2026-09-11T00:00:00.000Z' });
    const later = work({ id: 'later', resolvedAt: '2026-09-20T00:00:00.000Z' });
    const past = work({ id: 'past', resolvedAt: '2026-09-02T00:00:00.000Z' });
    expect(selectWorks([later, soon, past], { sort: 'planned' }).map(w => w.id))
      .toEqual(['past', 'soon', 'later']);
  });

  test('planned sinks undated Works below every dated one, by recency', () => {
    const dated = work({ id: 'dated', resolvedAt: '2026-09-20T00:00:00.000Z' });
    const undatedOld = work({ id: 'old', updatedAt: '2026-09-01T00:00:00.000Z' });
    const undatedNew = work({ id: 'new', updatedAt: '2026-09-08T00:00:00.000Z' });
    expect(selectWorks([undatedOld, dated, undatedNew], { sort: 'planned' }).map(w => w.id))
      .toEqual(['dated', 'new', 'old']);
  });

  test('ties break on id, so the order is total', () => {
    const same = '2026-09-04T00:00:00.000Z';
    const works = [work({ id: 'z', updatedAt: same }), work({ id: 'y', updatedAt: same })];
    expect(selectWorks(works, { sort: 'updated' }).map(w => w.id)).toEqual(['y', 'z']);
    expect(selectWorks(works, { sort: 'stale' }).map(w => w.id)).toEqual(['y', 'z']);
  });

  test('an unparseable updatedAt sinks instead of throwing off the order', () => {
    const broken = work({ id: 'broken', updatedAt: 'not-a-date' });
    expect(selectWorks([broken, b], { sort: 'updated' }).map(w => w.id)).toEqual(['b', 'broken']);
  });
});

describe('isWorkListSort', () => {
  test('accepts exactly the documented values', () => {
    for (const sort of WORK_LIST_SORTS) expect(isWorkListSort(sort)).toBe(true);
    expect(isWorkListSort('recent')).toBe(false);
    expect(isWorkListSort('')).toBe(false);
  });
});

describe('workPlanOverrunDays', () => {
  test('counts whole days past an active Work’s planned end', () => {
    const overdue = work({ id: 'a', resolvedAt: '2026-09-07T23:59:59.999Z' });
    expect(workPlanOverrunDays(overdue, NOW)).toBe(2);
  });

  test('clamps to 1 for an end that has only just passed', () => {
    // A manually set end lands at end-of-day, so the first hours of overrun
    // would floor to 0 — and "예정 0일 초과" is not an overrun.
    const justPassed = work({ id: 'a', resolvedAt: '2026-09-09T23:00:00.000Z' });
    expect(workPlanOverrunDays(justPassed, NOW)).toBe(1);
  });

  test('is 0 for a future planned end, and for no planned end at all', () => {
    expect(workPlanOverrunDays(work({ id: 'a', resolvedAt: '2026-09-20T00:00:00.000Z' }), NOW))
      .toBe(0);
    expect(workPlanOverrunDays(work({ id: 'a' }), NOW)).toBe(0);
  });

  test('is 0 for a terminal Work — its resolvedAt is an end, not a forecast', () => {
    const done = work({ id: 'a', status: 'done', resolvedAt: '2026-09-02T00:00:00.000Z' });
    const discarded = work({ id: 'b', status: 'discarded', resolvedAt: '2026-09-02T00:00:00.000Z' });
    expect(workPlanOverrunDays(done, NOW)).toBe(0);
    expect(workPlanOverrunDays(discarded, NOW)).toBe(0);
  });

  test('is 0 for an unparseable date rather than a nonsense day count', () => {
    expect(workPlanOverrunDays(work({ id: 'a', resolvedAt: 'nope' }), NOW)).toBe(0);
  });
});

describe('workProjectDirs', () => {
  test('returns the distinct directories, alphabetically, skipping unset ones', () => {
    const works = [
      work({ id: 'a', projectDir: '/z' }),
      work({ id: 'b', projectDir: '/a' }),
      work({ id: 'c', projectDir: '/a' }),
      work({ id: 'd' }),
    ];
    expect(workProjectDirs(works)).toEqual(['/a', '/z']);
  });
});
