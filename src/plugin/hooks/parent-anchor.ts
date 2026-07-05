import type { KanbanCard, KanbanStatus } from '../../core/types';

const ACTIVE_STATUSES: ReadonlySet<KanbanStatus> = new Set(['todo', 'in_progress', 'complete']);

function hasCommandOrigin(card: Pick<KanbanCard, 'command' | 'sourceContext'>): boolean {
  return Boolean(card.command || card.sourceContext);
}

function sortNewestFirst(cards: KanbanCard[]): KanbanCard[] {
  return [...cards].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function resolveSessionParentAnchor(cards: KanbanCard[], sessionId: string): KanbanCard | undefined {
  const sameSessionTopLevel = cards.filter(card => !card.parentCardId && card.sessionId === sessionId);
  if (sameSessionTopLevel.length === 0) return undefined;

  const activeCommandRoots = sortNewestFirst(
    sameSessionTopLevel.filter(card => ACTIVE_STATUSES.has(card.status) && hasCommandOrigin(card)),
  );
  if (activeCommandRoots.length > 0) return activeCommandRoots[0];

  const inProgressCards = sortNewestFirst(
    sameSessionTopLevel.filter(card => card.status === 'in_progress'),
  );
  if (inProgressCards.length > 0) return inProgressCards[0];

  const activeCards = sortNewestFirst(
    sameSessionTopLevel.filter(card => card.status !== 'done'),
  );
  if (activeCards.length > 0) return activeCards[0];

  return sortNewestFirst(sameSessionTopLevel)[0];
}
