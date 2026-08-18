import { useCallback, useReducer, useRef } from 'react';
import { nanoid } from 'nanoid';
import type {
  CreateQuickActionInput,
  QuickActionView,
  RunQuickActionInput,
  RunQuickActionResponse,
  UpdateQuickActionInput,
} from '../../../src/core/types';
import {
  createQuickAction as apiCreateQuickAction,
  deleteQuickAction as apiDeleteQuickAction,
  fetchQuickActions,
  QuickActionsApiError,
  runQuickAction as apiRunQuickAction,
  updateQuickAction as apiUpdateQuickAction,
} from './useQuickActionsApi';
import {
  redactQuickActionSecretValues,
  validateQuickActionParameterValues,
} from './quickActionFormModel';
import { useCrudResource } from './useCrudResource';

export interface QuickActionRunUiState {
  runningCounts: Record<string, number>;
}

export type QuickActionRunUiAction =
  | { type: 'RUN_START'; id: string }
  | { type: 'RUN_FINISH'; id: string };

export function quickActionRunReducer(
  state: QuickActionRunUiState,
  action: QuickActionRunUiAction,
): QuickActionRunUiState {
  const current = state.runningCounts[action.id] ?? 0;
  if (action.type === 'RUN_START') {
    return {
      runningCounts: {
        ...state.runningCounts,
        [action.id]: current + 1,
      },
    };
  }
  if (current <= 1) {
    const { [action.id]: _removed, ...runningCounts } = state.runningCounts;
    return { runningCounts };
  }
  return {
    runningCounts: {
      ...state.runningCounts,
      [action.id]: current - 1,
    },
  };
}

export class QuickActionRequestIdTracker {
  private readonly ids = new Map<string, string>();
  private readonly createId: () => string;

  constructor(createId: () => string = nanoid) {
    this.createId = createId;
  }

  current(actionId: string): string {
    const existing = this.ids.get(actionId);
    if (existing) return existing;
    const created = this.createId();
    this.ids.set(actionId, created);
    return created;
  }

  advance(actionId: string): string {
    const next = this.createId();
    this.ids.set(actionId, next);
    return next;
  }

  discard(actionId: string): void {
    this.ids.delete(actionId);
  }
}

interface ExecuteQuickActionRequestOptions {
  action: QuickActionView;
  userValues: Readonly<Record<string, unknown>>;
  requestIds: QuickActionRequestIdTracker;
  run: (id: string, input: RunQuickActionInput) => Promise<RunQuickActionResponse>;
  refresh: () => Promise<void>;
  reportError: (error: Error) => void;
}

function committedQuickActionCardId(body: unknown): string | undefined {
  return typeof body === 'object'
    && body !== null
    && 'cardId' in body
    && typeof body.cardId === 'string'
    && body.cardId.length > 0
    ? body.cardId
    : undefined;
}

function sanitizedRunError(
  error: unknown,
  action: QuickActionView,
  userValues: Readonly<Record<string, unknown>>,
): Error {
  const rawMessage = error instanceof Error ? error.message : 'Failed to run quick action';
  const message = redactQuickActionSecretValues(
    rawMessage,
    action.parameterDefinitions,
    userValues,
  );
  if (!(error instanceof QuickActionsApiError)) return new Error(message);
  const cardId = committedQuickActionCardId(error.body);
  return new QuickActionsApiError(
    error.status,
    message,
    cardId ? { cardId } : undefined,
  );
}

function hasCommittedQuickActionRun(error: QuickActionsApiError): boolean {
  return committedQuickActionCardId(error.body) !== undefined;
}

/** Purely orchestrates validation, idempotency, API execution, and refresh. */
export async function executeQuickActionRequest(
  options: ExecuteQuickActionRequestOptions,
): Promise<RunQuickActionResponse> {
  const validation = validateQuickActionParameterValues(
    options.action.parameterDefinitions,
    options.userValues,
  );
  if (!validation.valid) {
    const error = new Error(Object.values(validation.errors)[0] ?? 'Invalid quick action parameters');
    options.reportError(error);
    throw error;
  }

  const clientRequestId = options.requestIds.current(options.action.id);
  let result: RunQuickActionResponse;
  try {
    result = await options.run(options.action.id, {
      clientRequestId,
      parameterValues: validation.requestValues,
    });
  } catch (error: unknown) {
    const sanitized = sanitizedRunError(error, options.action, options.userValues);
    if (sanitized instanceof QuickActionsApiError && hasCommittedQuickActionRun(sanitized)) {
      // The server persisted a terminal failed execution. A retry with the same
      // idempotency key can only replay that result, so expose the card now and
      // let the user's next click create a new logical execution.
      options.requestIds.advance(options.action.id);
      await options.refresh();
    }
    options.reportError(sanitized);
    throw sanitized;
  }

  // The server accepted the logical execution. Only now may the next click use
  // a fresh id; failed attempts retain the current id for safe retries.
  options.requestIds.advance(options.action.id);
  await options.refresh();
  return result;
}

export interface UseQuickActionsResult {
  entries: QuickActionView[];
  loading: boolean;
  error: string | null;
  runningActionIds: string[];
  createEntry: (input: CreateQuickActionInput) => Promise<QuickActionView>;
  updateEntry: (id: string, input: UpdateQuickActionInput) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  runEntry: (
    id: string,
    parameterValues: Readonly<Record<string, unknown>>,
  ) => Promise<RunQuickActionResponse>;
  refreshEntries: () => Promise<void>;
  clearError: () => void;
}

export function useQuickActions(enabled: boolean): UseQuickActionsResult {
  const resource = useCrudResource<
    QuickActionView,
    CreateQuickActionInput,
    UpdateQuickActionInput,
    string
  >({
    enabled,
    fetchAll: fetchQuickActions,
    create: apiCreateQuickAction,
    update: apiUpdateQuickAction,
    remove: apiDeleteQuickAction,
    fallbackMessages: {
      fetch: 'Failed to fetch quick actions',
      create: 'Failed to create quick action',
      update: 'Failed to update quick action',
      delete: 'Failed to delete quick action',
    },
    makeError: (_action, message) => message,
  });
  const [runState, dispatchRun] = useReducer(quickActionRunReducer, { runningCounts: {} });
  const entriesRef = useRef(resource.entries);
  entriesRef.current = resource.entries;
  const requestIdsRef = useRef<QuickActionRequestIdTracker | null>(null);
  if (!requestIdsRef.current) requestIdsRef.current = new QuickActionRequestIdTracker();
  const requestIds = requestIdsRef.current;

  const deleteEntry = useCallback(async (id: string) => {
    await resource.deleteEntry(id);
    requestIdsRef.current?.discard(id);
  }, [resource.deleteEntry]);

  const runEntry = useCallback(async (
    id: string,
    parameterValues: Readonly<Record<string, unknown>>,
  ): Promise<RunQuickActionResponse> => {
    dispatchRun({ type: 'RUN_START', id });
    try {
      const action = entriesRef.current.find((entry) => entry.id === id);
      if (!action) {
        const error = new Error('Quick action not found');
        resource.reportError('run', error, 'Failed to run quick action');
        throw error;
      }
      return await executeQuickActionRequest({
        action,
        userValues: parameterValues,
        requestIds,
        run: apiRunQuickAction,
        refresh: resource.refreshEntries,
        reportError: (error) => {
          resource.reportError('run', error, 'Failed to run quick action');
        },
      });
    } finally {
      dispatchRun({ type: 'RUN_FINISH', id });
    }
  }, [requestIds, resource.refreshEntries, resource.reportError]);

  return {
    entries: resource.entries,
    loading: resource.loading,
    error: resource.error,
    runningActionIds: Object.keys(runState.runningCounts),
    createEntry: resource.createEntry,
    updateEntry: resource.updateEntry,
    deleteEntry,
    runEntry,
    refreshEntries: resource.refreshEntries,
    clearError: resource.clearError,
  };
}
