import type { Work, WorkListQuery, WorkListSort } from './types';

/**
 * Search / filter / sort for the Work list — the one implementation, shared by
 * `GET /api/works` and the Works tab's Active section.
 *
 * It is pure and lives in `core/` rather than in the route or the view because
 * both need it and neither may own it: the web client polls the **whole**
 * `/api/works` list (the Timeline groups by it, the assign panel recommends from
 * it, the move dialog picks from it), so it cannot narrow the request — it has
 * to narrow its own rendering with exactly the rule the server applies.
 */

/** Accepted `sort=` values, in the order the UI offers them. */
export const WORK_LIST_SORTS: readonly WorkListSort[] = ['updated', 'stale', 'planned'];

export function isWorkListSort(value: string): value is WorkListSort {
  return (WORK_LIST_SORTS as readonly string[]).includes(value);
}

/** Instant of an ISO date, or `fallback` when it is missing/unparseable. */
function instant(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Every string a text search should look at.
 *
 * Notes and Summary lines are included on purpose: the two places a Work says
 * what it is actually about are the human note and the generated summary, and a
 * title-only search made a Work findable only by the first prompt it happened to
 * be seeded from.
 */
function haystack(work: Work): string {
  return [
    work.title,
    work.projectDir ?? '',
    work.notes ?? '',
    ...(work.summary?.lines ?? []),
  ].join('\n').toLowerCase();
}

/**
 * How many whole days an `active` Work is past its **planned** end
 * (`resolvedAt`), or `0` when it is not — including every non-`active` Work,
 * whose `resolvedAt` is a real end rather than a forecast.
 *
 * Clamped to at least 1 once the deadline has passed: a manually set end lands
 * at end-of-day, so the first few hours of overrun would otherwise floor to
 * `0`, and "예정 0일 초과" is not an overrun.
 */
export function workPlanOverrunDays(
  work: Pick<Work, 'status' | 'resolvedAt'>,
  now: number = Date.now(),
): number {
  if (work.status !== 'active' || !work.resolvedAt) return 0;
  const end = Date.parse(work.resolvedAt);
  if (Number.isNaN(end) || end >= now) return 0;
  return Math.max(1, Math.floor((now - end) / 86_400_000));
}

/** Sort comparators. Every one ends on `id` so the order is total and stable. */
const COMPARATORS: Record<WorkListSort, (a: Work, b: Work) => number> = {
  // Most recently updated first — the board/session convention.
  updated: (a, b) => instant(b.updatedAt, 0) - instant(a.updatedAt, 0) || a.id.localeCompare(b.id),
  // The mirror image: longest untouched first.
  stale: (a, b) => instant(a.updatedAt, 0) - instant(b.updatedAt, 0) || a.id.localeCompare(b.id),
  // Nearest planned end first. A Work with no planned end has nothing to be
  // near, so it sinks below every dated one instead of claiming the epoch or
  // the far future — and those sink among themselves by recent activity.
  planned: (a, b) => {
    const aEnd = a.resolvedAt ? instant(a.resolvedAt, Number.NaN) : Number.NaN;
    const bEnd = b.resolvedAt ? instant(b.resolvedAt, Number.NaN) : Number.NaN;
    const aHas = !Number.isNaN(aEnd);
    const bHas = !Number.isNaN(bEnd);
    if (aHas && bHas) return aEnd - bEnd || a.id.localeCompare(b.id);
    if (aHas !== bHas) return aHas ? -1 : 1;
    return COMPARATORS.updated(a, b);
  },
};

/**
 * Filter and sort a Work list. Never mutates the input.
 *
 * An omitted `sort` is `updated`, which is what `WorkStore.getWorks()` did
 * before this existed — so every existing caller keeps its ordering.
 */
export function selectWorks(works: readonly Work[], query?: WorkListQuery): Work[] {
  const needle = query?.q?.trim().toLowerCase();
  const projectDir = query?.projectDir?.trim();
  const filtered = works.filter((work) => {
    if (query?.status && work.status !== query.status) return false;
    if (projectDir && work.projectDir !== projectDir) return false;
    if (needle && !haystack(work).includes(needle)) return false;
    return true;
  });
  return filtered.sort(COMPARATORS[query?.sort ?? 'updated']);
}

/** Distinct `projectDir`s present in a Work list, alphabetical. Powers the directory filter. */
export function workProjectDirs(works: readonly Work[]): string[] {
  const dirs = new Set<string>();
  for (const work of works) {
    if (work.projectDir) dirs.add(work.projectDir);
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}
