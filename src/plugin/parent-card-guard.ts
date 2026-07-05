import type { KanbanCard } from '../core/types';

export function hasActiveDirectChild(
  cards: Array<Pick<KanbanCard, 'parentCardId' | 'status' | 'linkKind'>>,
  parentCardId: string,
): boolean {
  return cards.some(
    card =>
      card.parentCardId === parentCardId &&
      card.status === 'in_progress' &&
      card.linkKind !== 'subagent',
  );
}

export function isTopLevelParentWaitingOnDirectChild(
  card: Pick<KanbanCard, 'id' | 'parentCardId'>,
  cards: Array<Pick<KanbanCard, 'parentCardId' | 'status' | 'linkKind'>>,
): boolean {
  return !card.parentCardId && hasActiveDirectChild(cards, card.id);
}
