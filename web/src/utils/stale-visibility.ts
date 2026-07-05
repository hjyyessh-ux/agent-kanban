import type { KanbanCard } from '../../../src/core/types';

export function shouldShowStaleStatus(card: Pick<KanbanCard, 'status' | 'staleStatus' | 'staleDetectedAt'>): boolean {
  return card.status === 'in_progress' && Boolean(card.staleStatus && card.staleDetectedAt);
}

export function staleCardVisualState(card: Pick<KanbanCard, 'status' | 'staleStatus' | 'staleDetectedAt'>): 'orphan' | 'stuck' | null {
  if (!shouldShowStaleStatus(card)) {
    return null;
  }

  return card.staleStatus === 'orphan' || card.staleStatus === 'stuck'
    ? card.staleStatus
    : null;
}
