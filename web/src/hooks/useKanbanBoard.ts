import { useReducer, useEffect, useCallback } from 'react';
import type { KanbanCard, CreateCardInput, QueueSessionMode, UpdateCardInput } from '../../../src/core/types';
import {
  fetchCards,
  fetchNextQueuePosition,
  createCard as apiCreateCard,
  updateCard as apiUpdateCard,
  markCompletionSeen as apiMarkCompletionSeen,
  deleteCard as apiDeleteCard,
  archiveCards as apiArchiveCards,
  dispatchCard as apiDispatchCard,
  scheduleCard as apiScheduleCard,
  cancelCardSchedule as apiCancelCardSchedule,
} from './useKanbanApi';
import { usePolling } from './usePolling';
import { createUiAlert, type UiAlert } from './uiAlert';

interface KanbanBoardState {
  cards: KanbanCard[];
  loading: boolean;
  error: UiAlert | null;
}

type KanbanAction =
  | { type: 'LOAD'; cards: KanbanCard[] }
  | { type: 'CREATE'; card: KanbanCard }
  | { type: 'UPDATE'; card: KanbanCard }
  | { type: 'DELETE'; id: string }
  | { type: 'ARCHIVE'; ids: string[] }
  | { type: 'SET_ERROR'; error: UiAlert }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_LOADING'; loading: boolean };

function kanbanReducer(state: KanbanBoardState, action: KanbanAction): KanbanBoardState {
  switch (action.type) {
    case 'LOAD':
      return { ...state, cards: action.cards, loading: false, error: null };
    case 'CREATE':
      return { ...state, cards: [...state.cards, action.card] };
    case 'UPDATE':
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === action.card.id ? action.card : c)),
      };
    case 'DELETE':
      return { ...state, cards: state.cards.filter((c) => c.id !== action.id) };
    case 'ARCHIVE':
      return { ...state, cards: state.cards.filter((c) => !action.ids.includes(c.id)) };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

const initialState: KanbanBoardState = {
  cards: [],
  loading: true,
  error: null,
};

export function selectCompletableCards(cards: KanbanCard[]): KanbanCard[] {
  return cards.filter((card) => card.status === 'complete' && !card.favorite);
}

export function selectArchivableCards(cards: KanbanCard[]): KanbanCard[] {
  const selectedParents = new Set(
    cards
      .filter((card) => card.status === 'done' && !card.favorite && !card.parentCardId)
      .map((card) => card.id),
  );

  return cards.filter((card) => {
    if (card.status !== 'done') return false;
    if (card.parentCardId) return selectedParents.has(card.parentCardId);
    return !card.favorite;
  });
}

export function useKanbanBoard(): {
  cards: KanbanCard[];
  loading: boolean;
  error: UiAlert | null;
  createCard: (input: CreateCardInput) => Promise<KanbanCard>;
  updateCard: (id: string, input: UpdateCardInput) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  dispatchCard: (id: string) => Promise<void>;
  refreshCards: () => Promise<void>;
  archiveCards: (cardIds?: string[]) => Promise<void>;
  completeAllCards: () => Promise<void>;
  queueCard: (cardId: string, afterCardId: string, sessionMode: QueueSessionMode) => Promise<KanbanCard>;
  unqueueCard: (cardId: string) => Promise<KanbanCard>;
  scheduleCard: (cardId: string, scheduledAt: string) => Promise<KanbanCard>;
  rescheduleCard: (cardId: string, scheduledAt: string) => Promise<KanbanCard>;
  cancelCardSchedule: (cardId: string) => Promise<KanbanCard>;
  reorderCards: (reorderedCardIds: string[]) => Promise<void>;
  setResumeSession: (cardId: string, sessionId: string) => Promise<void>;
  clearResumeSession: (cardId: string) => Promise<void>;
  markCompletionSeen: (cardId: string) => Promise<KanbanCard>;
  clearError: () => void;
  showError: (error: UiAlert) => void;
} {
  const [state, dispatch] = useReducer(kanbanReducer, initialState);

  const refreshCards = useCallback(async () => {
    try {
      const cards = await fetchCards();
      dispatch({ type: 'LOAD', cards });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch cards';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Board unavailable', message, 'Refresh board') });
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    void refreshCards();
  }, [refreshCards]);

  // Poll every 3 seconds
  usePolling(refreshCards, 3000);

  const createCard = useCallback(async (input: CreateCardInput): Promise<KanbanCard> => {
    try {
      const card = await apiCreateCard(input);
      dispatch({ type: 'CREATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not create task', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const updateCard = useCallback(async (id: string, input: UpdateCardInput) => {
    try {
      const card = await apiUpdateCard(id, input);
      dispatch({ type: 'UPDATE', card });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Task update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const deleteCard = useCallback(async (id: string) => {
    try {
      await apiDeleteCard(id);
      dispatch({ type: 'DELETE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not delete task', message, 'Refresh board') });
      throw err;
    }
  }, []);


  const archiveCards = useCallback(async (cardIds?: string[]) => {
    try {
      const requestedIds = new Set(cardIds ?? []);
      const doneCards = cardIds && cardIds.length > 0
        ? state.cards.filter((card) => requestedIds.has(card.id) && card.status === 'done')
        : selectArchivableCards(state.cards);
      if (doneCards.length === 0) return;
      await apiArchiveCards(doneCards.map((card) => card.id));
      dispatch({ type: 'ARCHIVE', ids: doneCards.map(c => c.id) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to archive cards';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Archive failed', message, 'Refresh board') });
      throw err;
    }
  }, [state.cards]);

  const completeAllCards = useCallback(async () => {
    try {
      const completeCards = selectCompletableCards(state.cards);
      if (completeCards.length === 0) return;
      await Promise.all(
        completeCards.map(async (card) => {
          const updated = await apiUpdateCard(card.id, { status: 'done' });
          dispatch({ type: 'UPDATE', card: updated });
        })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to complete all cards';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Bulk complete failed', message, 'Refresh board') });
      throw err;
    }
  }, [state.cards]);

  const dispatchCard = useCallback(async (id: string) => {
    try {
      await apiDispatchCard(id);
      await refreshCards();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to dispatch card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Could not start task', message, 'Refresh board') });
      throw err;
    }
  }, [refreshCards]);

  const queueCard = useCallback(async (cardId: string, afterCardId: string, sessionMode: QueueSessionMode): Promise<KanbanCard> => {
    try {
      const position = await fetchNextQueuePosition(afterCardId);
      const card = await apiUpdateCard(cardId, {
        queuedAfterCardId: afterCardId,
        queuePosition: position,
        queueSessionMode: sessionMode,
      });
      dispatch({ type: 'UPDATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to queue card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Queue update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const unqueueCard = useCallback(async (cardId: string): Promise<KanbanCard> => {
    try {
      const card = await apiUpdateCard(cardId, {
        queuedAfterCardId: null,
        queuePosition: null,
        queueSessionMode: null,
      });
      dispatch({ type: 'UPDATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to unqueue card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Queue update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const scheduleCard = useCallback(async (cardId: string, scheduledAt: string): Promise<KanbanCard> => {
    try {
      const card = await apiScheduleCard(cardId, scheduledAt);
      dispatch({ type: 'UPDATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to schedule card';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Schedule update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const cancelCardSchedule = useCallback(async (cardId: string): Promise<KanbanCard> => {
    try {
      const card = await apiCancelCardSchedule(cardId);
      dispatch({ type: 'UPDATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to cancel schedule';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Schedule update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const reorderCards = useCallback(async (reorderedCardIds: string[]) => {
    try {
      // Update each card's position
      const updatePromises = reorderedCardIds.map(async (id, index) => {
        const queuePosition = index + 1;
        const card = state.cards.find(c => c.id === id);
        
        // Skip if position hasn't changed
        if (card && card.queuePosition === queuePosition) {
          return;
        }

        const updatedCard = await apiUpdateCard(id, { queuePosition });
        dispatch({ type: 'UPDATE', card: updatedCard });
      });

      await Promise.all(updatePromises);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to reorder cards';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Card order update failed', message, 'Refresh board') });
      throw err;
    }
  }, [state.cards]);

  const setResumeSession = useCallback(async (cardId: string, sessionId: string) => {
    try {
      const card = await apiUpdateCard(cardId, { resumeSessionId: sessionId });
      dispatch({ type: 'UPDATE', card });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to set resume session';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Session update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const clearResumeSession = useCallback(async (cardId: string) => {
    try {
      const card = await apiUpdateCard(cardId, { resumeSessionId: null });
      dispatch({ type: 'UPDATE', card });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to clear resume session';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Session update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const markCompletionSeen = useCallback(async (cardId: string): Promise<KanbanCard> => {
    try {
      const card = await apiMarkCompletionSeen(cardId);
      dispatch({ type: 'UPDATE', card });
      return card;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to mark completion as seen';
      dispatch({ type: 'SET_ERROR', error: createUiAlert('Completion update failed', message, 'Refresh board') });
      throw err;
    }
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  const showError = useCallback((error: UiAlert) => {
    dispatch({ type: 'SET_ERROR', error });
  }, []);

  return {
    cards: state.cards,
    loading: state.loading,
    error: state.error,
    createCard,
    updateCard,
    deleteCard,
    archiveCards,
    completeAllCards,
    dispatchCard,
    refreshCards,
    queueCard,
    unqueueCard,
    scheduleCard,
    rescheduleCard: scheduleCard,
    cancelCardSchedule,
    reorderCards,
    setResumeSession,
    clearResumeSession,
    markCompletionSeen,
    clearError,
    showError,
  };

}
