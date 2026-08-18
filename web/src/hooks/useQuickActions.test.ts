import { describe, expect, test } from 'bun:test';
import type { QuickActionView, RunQuickActionInput } from '../../../src/core/types';
import { QuickActionsApiError } from './useQuickActionsApi';
import {
  executeQuickActionRequest,
  QuickActionRequestIdTracker,
  quickActionRunReducer,
} from './useQuickActions';

function promptAction(): QuickActionView {
  return {
    id: 'action-1',
    icon: '🚀',
    type: 'prompt',
    name: 'Deploy',
    description: '',
    enabled: true,
    pinned: false,
    order: 0,
    parameterDefinitions: [
      { key: 'scope', label: 'Scope', type: 'string', required: true, defaultValue: 'web' },
      { key: 'token', label: 'Token', type: 'secret', required: true },
    ],
    cardTitleTemplate: 'Deploy {{scope}}',
    promptTemplate: 'Deploy {{scope}}',
    projectDir: '/workspace/app',
    agentRuntime: 'codex',
    available: true,
    effectiveProjectDir: '/workspace/app',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

describe('quickActionRunReducer', () => {
  test('tracks overlapping executions and removes the id after the last completion', () => {
    const initial = { runningCounts: {} };
    const first = quickActionRunReducer(initial, { type: 'RUN_START', id: 'action-1' });
    const second = quickActionRunReducer(first, { type: 'RUN_START', id: 'action-1' });
    const oneRemaining = quickActionRunReducer(second, { type: 'RUN_FINISH', id: 'action-1' });
    const finished = quickActionRunReducer(oneRemaining, { type: 'RUN_FINISH', id: 'action-1' });

    expect(initial).toEqual({ runningCounts: {} });
    expect(second.runningCounts).toEqual({ 'action-1': 2 });
    expect(oneRemaining.runningCounts).toEqual({ 'action-1': 1 });
    expect(finished.runningCounts).toEqual({});
  });
});

describe('executeQuickActionRequest', () => {
  test('merges defaults, refreshes after success, and advances the request id', async () => {
    const generatedIds = ['request-1', 'request-2'];
    const requestIds = new QuickActionRequestIdTracker(() => generatedIds.shift() ?? 'unexpected');
    let receivedInput: RunQuickActionInput | undefined;
    let refreshCount = 0;

    const result = await executeQuickActionRequest({
      action: promptAction(),
      userValues: { token: 'transient' },
      requestIds,
      run: async (_id, input) => {
        receivedInput = input;
        return { cardId: 'card-1', status: 'in_progress', dispatch: null };
      },
      refresh: async () => {
        refreshCount += 1;
      },
      reportError: () => {
        throw new Error('Unexpected error report');
      },
    });

    expect(result.cardId).toBe('card-1');
    expect(receivedInput).toEqual({
      clientRequestId: 'request-1',
      parameterValues: { scope: 'web', token: 'transient' },
    });
    expect(refreshCount).toBe(1);
    expect(requestIds.current('action-1')).toBe('request-2');
  });

  test('retains the id across a failed retry and redacts secret errors', async () => {
    const generatedIds = ['stable-request', 'next-request'];
    const requestIds = new QuickActionRequestIdTracker(() => generatedIds.shift() ?? 'unexpected');
    const seenRequestIds: string[] = [];
    const reportedMessages: string[] = [];
    let refreshCount = 0;
    let shouldFail = true;
    const options = {
      action: promptAction(),
      userValues: { token: 'sensitive-token' },
      requestIds,
      run: async (_id: string, input: RunQuickActionInput) => {
        seenRequestIds.push(input.clientRequestId);
        if (shouldFail) {
          throw new QuickActionsApiError(500, 'runtime rejected sensitive-token');
        }
        return { cardId: 'card-1', status: 'in_progress' as const, dispatch: null };
      },
      refresh: async () => {
        refreshCount += 1;
      },
      reportError: (error: Error) => {
        reportedMessages.push(error.message);
      },
    };

    await expect(executeQuickActionRequest(options)).rejects.toMatchObject({
      status: 500,
      message: 'runtime rejected [REDACTED]',
    });
    expect(refreshCount).toBe(0);
    expect(requestIds.current('action-1')).toBe('stable-request');

    shouldFail = false;
    await executeQuickActionRequest(options);

    expect(seenRequestIds).toEqual(['stable-request', 'stable-request']);
    expect(reportedMessages).toEqual(['runtime rejected [REDACTED]']);
    expect(reportedMessages.join(' ')).not.toContain('sensitive-token');
    expect(refreshCount).toBe(1);
    expect(requestIds.current('action-1')).toBe('next-request');
  });

  test('advances after the server persisted a failed card so recovery can create a new run', async () => {
    const generatedIds = ['failed-card-request', 'recovery-request'];
    const requestIds = new QuickActionRequestIdTracker(() => generatedIds.shift() ?? 'unexpected');
    const seenRequestIds: string[] = [];
    let refreshCount = 0;
    let shouldFail = true;
    const options = {
      action: promptAction(),
      userValues: { token: 'transient-secret' },
      requestIds,
      run: async (_id: string, input: RunQuickActionInput) => {
        seenRequestIds.push(input.clientRequestId);
        if (shouldFail) {
          throw new QuickActionsApiError(503, 'runtime failed transient-secret', {
            error: 'runtime failed transient-secret',
            cardId: 'failed-card',
            status: 'todo',
            dispatch: null,
          });
        }
        return { cardId: 'recovered-card', status: 'in_progress' as const, dispatch: null };
      },
      refresh: async () => {
        refreshCount += 1;
      },
      reportError: () => {},
    };

    const failure = await executeQuickActionRequest(options).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      status: 503,
      message: 'runtime failed [REDACTED]',
      body: { cardId: 'failed-card' },
    });
    expect(JSON.stringify(failure)).not.toContain('transient-secret');
    expect(refreshCount).toBe(1);
    expect(requestIds.current('action-1')).toBe('recovery-request');

    shouldFail = false;
    const recovered = await executeQuickActionRequest(options);
    expect(recovered.cardId).toBe('recovered-card');
    expect(seenRequestIds).toEqual(['failed-card-request', 'recovery-request']);
    expect(refreshCount).toBe(2);
  });

  test('does not call the API or refresh when local validation fails', async () => {
    const requestIds = new QuickActionRequestIdTracker(() => 'unused-request');
    let runCount = 0;
    let refreshCount = 0;
    const messages: string[] = [];

    await expect(executeQuickActionRequest({
      action: promptAction(),
      userValues: {},
      requestIds,
      run: async () => {
        runCount += 1;
        return { cardId: 'unexpected', status: 'todo', dispatch: null };
      },
      refresh: async () => {
        refreshCount += 1;
      },
      reportError: (error) => messages.push(error.message),
    })).rejects.toThrow('Token is required');

    expect(runCount).toBe(0);
    expect(refreshCount).toBe(0);
    expect(messages).toEqual(['Token is required']);
  });
});
