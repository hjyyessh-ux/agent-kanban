import { useReducer, useEffect, useCallback } from 'react';
import type { QuestionRequest } from './useQuestionsApi';
import {
  fetchQuestions,
  replyToQuestion as apiReply,
  rejectQuestion as apiReject,
} from './useQuestionsApi';
import { usePolling } from './usePolling';

interface QuestionsState {
  questions: QuestionRequest[];
  loading: boolean;
  error: string | null;
}

type QuestionsAction =
  | { type: 'LOAD'; questions: QuestionRequest[] }
  | { type: 'REMOVE'; id: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_LOADING'; loading: boolean };

function questionsReducer(state: QuestionsState, action: QuestionsAction): QuestionsState {
  switch (action.type) {
    case 'LOAD':
      return { ...state, questions: action.questions, loading: false, error: null };
    case 'REMOVE':
      return { ...state, questions: state.questions.filter((q) => q.id !== action.id) };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

const initialState: QuestionsState = {
  questions: [],
  loading: false,
  error: null,
};

export function useQuestions(): {
  questions: QuestionRequest[];
  loading: boolean;
  error: string | null;
  reply: (id: string, answers: string[][]) => Promise<void>;
  reject: (id: string) => Promise<void>;
  refreshQuestions: () => Promise<void>;
} {
  const [state, dispatch] = useReducer(questionsReducer, initialState);

  const refreshQuestions = useCallback(async () => {
    try {
      const questions = await fetchQuestions();
      dispatch({ type: 'LOAD', questions });
    } catch {
      // Silently ignore — question monitor may not be running
      dispatch({ type: 'LOAD', questions: [] });
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    void refreshQuestions();
  }, [refreshQuestions]);

  // Poll every 3 seconds (always active — questions can come in at any time)
  usePolling(refreshQuestions, 3000);

  const reply = useCallback(async (id: string, answers: string[][]) => {
    try {
      await apiReply(id, answers);
      dispatch({ type: 'REMOVE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit answer';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, []);

  const reject = useCallback(async (id: string) => {
    try {
      await apiReject(id);
      dispatch({ type: 'REMOVE', id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to reject question';
      dispatch({ type: 'SET_ERROR', error: message });
      throw err;
    }
  }, []);

  return {
    questions: state.questions,
    loading: state.loading,
    error: state.error,
    reply,
    reject,
    refreshQuestions,
  };
}
