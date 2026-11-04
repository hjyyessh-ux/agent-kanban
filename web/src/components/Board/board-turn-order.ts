import { useSyncExternalStore } from 'react';

/**
 * Board-wide order of the turns inside every session group. It used to be a
 * toggle on each session (`↓ 최신→과거 순`), repeated on every card for a
 * setting that is almost never changed; it now lives once in the complete /
 * done column `⋯` menu.
 */
export type BoardTurnOrder = 'newest' | 'oldest';

const STORAGE_KEY = 'kanban.board.turnOrder';
const listeners = new Set<() => void>();
let current: BoardTurnOrder | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readBoardTurnOrder(): BoardTurnOrder {
  if (current) return current;
  current = storage()?.getItem(STORAGE_KEY) === 'oldest' ? 'oldest' : 'newest';
  return current;
}

export function setBoardTurnOrder(order: BoardTurnOrder): void {
  current = order;
  try {
    storage()?.setItem(STORAGE_KEY, order);
  } catch {
    // Private mode / quota — the in-memory value still applies for this tab.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const serverSnapshot = (): BoardTurnOrder => 'newest';

export function useBoardTurnOrder(): BoardTurnOrder {
  return useSyncExternalStore(subscribe, readBoardTurnOrder, serverSnapshot);
}
