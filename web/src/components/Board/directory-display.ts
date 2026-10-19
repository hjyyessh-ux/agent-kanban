import type { KanbanCard } from '../../../../src/core/types';
import { groupCardsByParent } from './board-utils';

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getDirectoryProjectName(projectDir: string | undefined): string {
  const normalized = trimTrailingSlashes(projectDir?.trim() ?? '');
  if (!normalized) return '';

  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function getDirectoryParentHint(projectDir: string | undefined): string {
  const normalized = trimTrailingSlashes(projectDir?.trim() ?? '');
  if (!normalized) return '';

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return normalized;

  return parts[parts.length - 2] ?? normalized;
}

/** "Recent" for the switcher's ordering: a project touched in the last week. */
export const RECENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Card counts behind one project chip (or `All`).
 *
 * `count` is the number the chip shows: **in-flight top-level cards** —
 * `todo` + `in_progress` + `complete`, never `done`, never a child card. That
 * is what the board's columns count, so `All` equals the sum of the three
 * active column badges instead of the old raw `cards.length` that also held
 * Done and every subagent card. The rest is the tooltip's breakdown.
 */
export interface DirectoryCounts {
  count: number;
  doneCount: number;
  childCount: number;
}

export interface DirectoryOption extends DirectoryCounts {
  value: string;
  label: string;
  /** Newest `createdAt`/`updatedAt` across the project's cards (epoch ms, 0 when none parse). */
  latestActivity: number;
  /** Top-level cards whose latest activity falls inside `RECENT_ACTIVITY_WINDOW_MS`. */
  recentCount: number;
}

function cardActivity(card: KanbanCard): number {
  const created = Date.parse(card.createdAt);
  const updated = Date.parse(card.updatedAt);
  return Math.max(
    Number.isNaN(created) ? 0 : created,
    Number.isNaN(updated) ? 0 : updated,
  );
}

/** Ids of the cards the board shows as columns entries — `groupCardsByParent`'s top level. */
function topLevelIds(cards: KanbanCard[]): Set<string> {
  return new Set(groupCardsByParent(cards).map((card) => card.id));
}

function addCard(counts: DirectoryCounts, card: KanbanCard, isTopLevel: boolean): void {
  if (!isTopLevel) counts.childCount += 1;
  else if (card.status === 'done') counts.doneCount += 1;
  else counts.count += 1;
}

/** Counts for the `All` chip — same definition as every project chip. */
export function buildDirectoryTotals(cards: KanbanCard[]): DirectoryCounts {
  const topLevel = topLevelIds(cards);
  const totals: DirectoryCounts = { count: 0, doneCount: 0, childCount: 0 };
  for (const card of cards) addCard(totals, card, topLevel.has(card.id));
  return totals;
}

/** Tooltip breakdown: `active 12 · done 40 · child 2`. */
export function formatDirectoryCountBreakdown(counts: DirectoryCounts): string {
  return `active ${counts.count} · done ${counts.doneCount} · child ${counts.childCount}`;
}

/** Compact age of a project's last activity for the More list: `5m`, `3h`, `2d`. */
export function formatActivityAge(latestActivity: number, nowMs = Date.now()): string {
  if (latestActivity <= 0) return '—';
  const minutes = Math.max(0, Math.floor((nowMs - latestActivity) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One option per distinct `projectDir`, ordered for the switcher: projects
 * with more cards active in the last 7 days first, then by in-flight card
 * count, then by newest activity, then by label. Keeping the currently
 * selected chip on screen is `splitDirectoryOptions`' job, not the sort's —
 * re-sorting on every click would make the chip you just pressed jump.
 */
export function buildDirectoryOptions(cards: KanbanCard[], nowMs = Date.now()): DirectoryOption[] {
  const topLevel = topLevelIds(cards);
  const byDirectory = new Map<string, DirectoryCounts & { latestActivity: number; recentCount: number }>();
  const labelCounts = new Map<string, number>();

  for (const card of cards) {
    const value = trimTrailingSlashes(card.projectDir?.trim() ?? '');
    if (!value) continue;

    const isTopLevel = topLevel.has(card.id);
    const latestActivity = cardActivity(card);
    let entry = byDirectory.get(value);
    if (!entry) {
      entry = { count: 0, doneCount: 0, childCount: 0, latestActivity: 0, recentCount: 0 };
      byDirectory.set(value, entry);
      const label = getDirectoryProjectName(value);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    addCard(entry, card, isTopLevel);
    entry.latestActivity = Math.max(entry.latestActivity, latestActivity);
    if (isTopLevel && latestActivity > 0 && nowMs - latestActivity <= RECENT_ACTIVITY_WINDOW_MS) {
      entry.recentCount += 1;
    }
  }

  return Array.from(byDirectory.entries())
    .map(([value, entry]) => {
      const projectName = getDirectoryProjectName(value);
      const hasDuplicateName = (labelCounts.get(projectName) ?? 0) > 1;
      const parentHint = getDirectoryParentHint(value);
      return {
        value,
        label: hasDuplicateName && parentHint ? `${projectName} · ${parentHint}` : projectName,
        ...entry,
      };
    })
    .sort((left, right) => {
      if (right.recentCount !== left.recentCount) return right.recentCount - left.recentCount;
      if (right.count !== left.count) return right.count - left.count;
      if (right.latestActivity !== left.latestActivity) return right.latestActivity - left.latestActivity;
      return left.label.localeCompare(right.label);
    });
}

/** Case-insensitive match on the chip label or the full path, for the More search box. */
export function filterDirectoryOptions(options: DirectoryOption[], query: string): DirectoryOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle));
}

export interface DirectoryChipLayout {
  /** Rendered width of each option's chip, aligned with `options`. */
  widths: number[];
  /** Width left for project chips after `All` (a gap precedes every chip). */
  available: number;
  gap: number;
  /** Width of the `+N More ▾` trigger, reserved only when something overflows. */
  moreWidth: number;
  /** Currently selected directory; always lands in `visible`. */
  selected: string;
}

export interface DirectoryOptionSplit {
  visible: DirectoryOption[];
  overflow: DirectoryOption[];
}

/**
 * Top-N split for the project bar: the longest prefix of `options` whose
 * chips fit in `available`, with room for the More trigger whenever anything
 * is left over. A selected option that would overflow takes the last visible
 * slot instead (dropping chips from the end until it fits), so the active
 * filter is never hidden behind More. Unmeasured layouts (`widths` shorter
 * than `options`, e.g. before the first layout pass) show every option.
 */
export function splitDirectoryOptions(
  options: DirectoryOption[],
  { widths, available, gap, moreWidth, selected }: DirectoryChipLayout,
): DirectoryOptionSplit {
  if (widths.length < options.length) return { visible: options, overflow: [] };

  const total = widths.reduce((sum, width) => sum + gap + width, 0);
  if (total <= available) return { visible: options, overflow: [] };

  const budget = available - gap - moreWidth;
  const visibleIndexes: number[] = [];
  let used = 0;
  for (let index = 0; index < options.length; index += 1) {
    const next = used + gap + widths[index];
    if (next > budget) break;
    visibleIndexes.push(index);
    used = next;
  }

  const selectedIndex = options.findIndex((option) => option.value === selected);
  if (selectedIndex >= 0 && !visibleIndexes.includes(selectedIndex)) {
    const selectedWidth = gap + widths[selectedIndex];
    while (visibleIndexes.length > 0 && used + selectedWidth > budget) {
      const dropped = visibleIndexes.pop() ?? 0;
      used -= gap + widths[dropped];
    }
    visibleIndexes.push(selectedIndex);
  }

  const visibleSet = new Set(visibleIndexes);
  return {
    visible: visibleIndexes.map((index) => options[index]),
    overflow: options.filter((_, index) => !visibleSet.has(index)),
  };
}
