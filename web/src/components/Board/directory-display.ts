import type { KanbanCard } from '../../../../src/core/types';

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

export interface DirectoryOption {
  value: string;
  label: string;
  count: number;
  latestActivity: number;
}

export function buildDirectoryOptions(cards: KanbanCard[]): DirectoryOption[] {
  const byDirectory = new Map<string, { count: number; latestActivity: number }>();
  const labelCounts = new Map<string, number>();

  for (const card of cards) {
    const value = trimTrailingSlashes(card.projectDir?.trim() ?? '');
    if (!value) continue;

    const created = Date.parse(card.createdAt);
    const updated = Date.parse(card.updatedAt);
    const latestActivity = Math.max(
      Number.isNaN(created) ? 0 : created,
      Number.isNaN(updated) ? 0 : updated,
    );

    const current = byDirectory.get(value);
    byDirectory.set(value, {
      count: (current?.count ?? 0) + 1,
      latestActivity: Math.max(current?.latestActivity ?? 0, latestActivity),
    });

    const label = getDirectoryProjectName(value);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + (current ? 0 : 1));
  }

  return Array.from(byDirectory.entries())
    .map(([value, entry]) => {
      const projectName = getDirectoryProjectName(value);
      const hasDuplicateName = (labelCounts.get(projectName) ?? 0) > 1;
      const parentHint = getDirectoryParentHint(value);
      return {
        value,
        label: hasDuplicateName && parentHint ? `${projectName} · ${parentHint}` : projectName,
        count: entry.count,
        latestActivity: entry.latestActivity,
      };
    })
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (right.latestActivity !== left.latestActivity) return right.latestActivity - left.latestActivity;
      return left.label.localeCompare(right.label);
    });
}
