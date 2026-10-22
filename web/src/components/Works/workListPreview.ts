import type { KanbanCard, Work } from '../../../../src/core/types';
import { previewLine } from '../../utils/text-preview';
import { splitCardResult } from '../Card/card-result';

/**
 * Where a Work list row's one line came from. The row says so with a tag, so a
 * sentence is never mistaken for something the user wrote when a model did.
 */
export type WorkPreviewSource = 'summary' | 'notes' | 'result' | 'none';

export interface WorkPreview {
  source: WorkPreviewSource;
  text: string;
}

export const WORK_PREVIEW_LABELS: Record<Exclude<WorkPreviewSource, 'none'>, string> = {
  summary: '요약',
  notes: '메모',
  result: '최근 결과',
};

/**
 * The one line under a Work's title in the list.
 *
 * It used to be `summary.lines` only — but the Summary exists only after
 * someone presses `요약 생성`, so most rows had nothing there. The fallbacks:
 *
 * 1. `요약` — the first Summary line (LLM, generated on request)
 * 2. `메모` — the first line of the human-owned notes
 * 3. `최근 결과` — the latest finished top-level turn's result, through the same
 *    `previewLine` the session modal's folded turns use. Always available once
 *    anything ran; board cards only (a completed Work's archived cards are not
 *    polled, and such a Work normally has a Summary by then).
 * 4. nothing → the row offers `요약 생성` instead.
 */
export function workListPreview(
  work: Pick<Work, 'summary' | 'notes' | 'sessionLinks'>,
  cards: readonly KanbanCard[],
): WorkPreview {
  const summary = work.summary?.lines.find((line) => line.trim())?.trim();
  if (summary) return { source: 'summary', text: summary };

  const notes = previewLine(work.notes);
  if (notes) return { source: 'notes', text: notes };

  // Newest first, and only parsed until one yields a line: this runs for every
  // row on every 3s board poll, and markdown-parsing every finished card of a
  // long Work to keep just one would be most of that cost.
  const sessions = new Set(work.sessionLinks.map((link) => link.sessionId));
  const finished = cards
    .filter((card) => !card.parentCardId && card.sessionId && sessions.has(card.sessionId)
      && (card.status === 'complete' || card.status === 'done'))
    .map((card) => ({ card, at: new Date(card.completedAt ?? card.updatedAt).getTime() }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => b.at - a.at);
  for (const { card } of finished) {
    const text = previewLine(splitCardResult(card).final);
    if (text) return { source: 'result', text };
  }

  return { source: 'none', text: '' };
}

export interface WorkProjectShare {
  projectDir: string;
  sessionCount: number;
}

/**
 * Every project a Work's sessions ran in, most sessions first (then by name,
 * so the order is stable between polls). A Work is a goal, not a repo — one
 * that touched `ingestion`, `mcp-server` and `agent-kanban` lists all three
 * instead of the single `projectDir` it was created with. Falls back to that
 * `projectDir` when no link carries one.
 */
export function workProjectShares(work: Pick<Work, 'projectDir' | 'sessionLinks'>): WorkProjectShare[] {
  const counts = new Map<string, number>();
  for (const link of work.sessionLinks) {
    const dir = link.projectDir?.trim().replace(/\/+$/, '');
    if (!dir) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (counts.size === 0 && work.projectDir) {
    return [{ projectDir: work.projectDir.replace(/\/+$/, ''), sessionCount: work.sessionLinks.length }];
  }
  return [...counts]
    .map(([projectDir, sessionCount]) => ({ projectDir, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount || a.projectDir.localeCompare(b.projectDir));
}

/**
 * Top-level cards running right now, per Work — the list's `실행 중` signal.
 *
 * Not `activity.inProgressCount`: that counts `todo` *and* `in_progress` (it is
 * "not finished yet"), so a Work with one queued card would float to the top
 * of the list without anything actually running. Board cards only, which is
 * where a running card always is.
 */
export function workRunningCounts(
  works: readonly Pick<Work, 'id' | 'status' | 'sessionLinks'>[],
  cards: readonly KanbanCard[],
): Map<string, number> {
  const workBySession = new Map<string, string>();
  for (const work of works) {
    if (work.status !== 'active') continue;
    for (const link of work.sessionLinks) workBySession.set(link.sessionId, work.id);
  }
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.status !== 'in_progress' || card.parentCardId || !card.sessionId) continue;
    const workId = workBySession.get(card.sessionId);
    if (workId) counts.set(workId, (counts.get(workId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Split an already-sorted list into the Works with something running and the
 * rest, each keeping the incoming order — so the chosen sort still applies
 * inside both groups and only "is something running" outranks it.
 */
export function partitionRunningWorks<T extends Pick<Work, 'id'>>(
  works: readonly T[],
  running: ReadonlyMap<string, number>,
): { running: T[]; rest: T[] } {
  const lifted: T[] = [];
  const rest: T[] = [];
  for (const work of works) ((running.get(work.id) ?? 0) > 0 ? lifted : rest).push(work);
  return { running: lifted, rest };
}
