import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';

export interface CardWithChildren extends KanbanCard {
  childCards?: KanbanCard[];
}

type SortableKanbanCard = KanbanCard & {
  todoOrder?: number;
};

export function groupCardsByParent(cards: KanbanCard[]): CardWithChildren[] {
  const cardMap = new Map<string, KanbanCard>();
  const childrenByParent = new Map<string, KanbanCard[]>();

  for (const card of cards) {
    cardMap.set(card.id, card);
  }

  const topLevelCards: KanbanCard[] = [];
  for (const card of cards) {
    const isLinkedChild =
      card.linkKind === 'subagent' || card.linkKind === 'nested' || card.linkKind === 'worker';
    if (card.parentCardId && cardMap.has(card.parentCardId)) {
      const siblings = childrenByParent.get(card.parentCardId);
      if (siblings) {
        siblings.push(card);
      } else {
        childrenByParent.set(card.parentCardId, [card]);
      }
    } else if (!isLinkedChild) {
      topLevelCards.push(card);
    }
    // linkKind child whose parent is not in the current view: silently omit (not orphaned top-level)
  }

  return topLevelCards.map((card) => {
    const children = childrenByParent.get(card.id);
    return children ? { ...card, childCards: children } : card;
  });
}

export function sortCardsForColumn<T extends SortableKanbanCard>(
  status: KanbanStatus,
  cards: T[],
): T[] {
  const nextCards = [...cards];
  const originalIndex = new Map(nextCards.map((card, index) => [card.id, index]));

  const compareByNewestTimestamp = (a: T, b: T, field: 'createdAt' | 'updatedAt'): number => {
    const timeDiff = new Date(b[field]).getTime() - new Date(a[field]).getTime();
    if (timeDiff !== 0) return timeDiff;

    return (originalIndex.get(b.id) ?? 0) - (originalIndex.get(a.id) ?? 0);
  };

  const compareByNewestResponse = (a: T, b: T): number => {
    const getTime = (card: T): number => new Date(card.responseAt ?? card.completedAt ?? card.updatedAt).getTime();
    const timeDiff = getTime(b) - getTime(a);
    if (timeDiff !== 0) return timeDiff;

    return (originalIndex.get(b.id) ?? 0) - (originalIndex.get(a.id) ?? 0);
  };

  if (status === 'todo') {
    const allHaveTodoOrder = nextCards.every((card) => typeof card.todoOrder === 'number');
    if (allHaveTodoOrder) {
      return nextCards.sort((a, b) => (a.todoOrder ?? 0) - (b.todoOrder ?? 0));
    }

    const allQueued = nextCards.every((card) => typeof card.queuePosition === 'number');
    if (allQueued) {
      return nextCards.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
    }
  }

  if (status === 'complete') {
    return nextCards.sort(compareByNewestResponse);
  }

  if (status === 'done') {
    return nextCards.sort(compareByNewestResponse);
  }

  return nextCards.sort((a, b) => compareByNewestTimestamp(a, b, 'createdAt'));
}
