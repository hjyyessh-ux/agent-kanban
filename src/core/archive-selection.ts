import type { KanbanCard } from './types';

/** The exact archive cascade, shared by confirmation, guards and persistence. */
export function selectArchiveCards(
  cards: KanbanCard[],
  cardIds?: string[],
  requireDone = true,
): KanbanCard[] {
  if (!cardIds?.length) return cards.filter(c => !c.deletedAt && c.status === 'done');
  const requested = new Set(cardIds);
  const children = new Map<string, KanbanCard[]>();
  for (const card of cards) {
    if (card.deletedAt || !card.parentCardId) continue;
    const siblings = children.get(card.parentCardId) ?? [];
    siblings.push(card);
    children.set(card.parentCardId, siblings);
  }
  const selected = new Set(cards.filter(c => !c.deletedAt && requested.has(c.id)
    && (!requireDone || c.status === 'done')).map(c => c.id));
  const stack = [...selected];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (child.favorite || selected.has(child.id)) continue;
      selected.add(child.id);
      stack.push(child.id);
    }
  }
  return cards.filter(c => selected.has(c.id));
}
