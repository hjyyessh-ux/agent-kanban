import type { Work } from '../../../../src/core/types';

/**
 * NEW TASK: the Directory after picking `work`. A Work's `projectDir` fills an
 * empty field, or replaces a value the previous pick filled (`lastAutoDir`) —
 * never a path the user typed or chose themselves. Clearing the Work leaves
 * the Directory alone.
 */
export function directoryAfterWorkPick(
  currentDir: string,
  lastAutoDir: string | null,
  work: Pick<Work, 'projectDir'> | undefined,
): string {
  const next = work?.projectDir?.trim();
  if (!next) return currentDir;
  const current = currentDir.trim();
  if (current === '' || (lastAutoDir !== null && current === lastAutoDir)) return next;
  return currentDir;
}
