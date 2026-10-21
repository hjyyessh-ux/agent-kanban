import type { Work, WorkInboxSession } from '../../../../src/core/types';

// The directory colour moved to `utils/project-color.ts` so the board can share
// it; re-exported here so Works code keeps one import for both affinity signals.
export { DIR_COLOR_SLOTS, dirAccentClass, projectDirColorSlot } from '../../utils/project-color';

/**
 * Works that already hold a session this one continues — the "🔗 이어진 세션"
 * signal. `relatedSessionIds` comes from the server (`buildSessionChainMap`,
 * computed over archived cards too), so an empty result means "no lineage
 * found", never "not loaded".
 *
 * Kept separate from the directory colour on purpose: same directory is *where*
 * a session came from, lineage is *what it came out of*, and a Work can be
 * either, both, or neither.
 */
export function chainedWorkIds(
  session: Pick<WorkInboxSession, 'relatedSessionIds'>,
  works: Work[],
): ReadonlySet<string> {
  const lineage = new Set(session.relatedSessionIds ?? []);
  if (lineage.size === 0) return new Set();
  const matched = new Set<string>();
  for (const work of works) {
    if (work.sessionLinks.some((link) => lineage.has(link.sessionId))) matched.add(work.id);
  }
  return matched;
}
