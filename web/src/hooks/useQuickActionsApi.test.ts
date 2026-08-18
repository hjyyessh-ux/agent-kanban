import { afterEach, describe, expect, mock, test } from 'bun:test';
import type {
  CreateQuickActionInput,
  QuickActionView,
  RunQuickActionResponse,
} from '../../../src/core/types';
import {
  createQuickAction,
  deleteQuickAction,
  fetchQuickAction,
  fetchQuickActions,
  QuickActionsApiError,
  runQuickAction,
  updateQuickAction,
} from './useQuickActionsApi';

const originalFetch = globalThis.fetch;

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'action/one',
    icon: '🚀',
    type: 'prompt',
    name: 'Deploy',
    description: 'Deploy a service',
    enabled: true,
    pinned: true,
    order: 1,
    parameterDefinitions: [],
    cardTitleTemplate: 'Deploy',
    promptTemplate: 'Deploy now',
    projectDir: '/workspace/app',
    agentRuntime: 'codex',
    available: true,
    effectiveProjectDir: '/workspace/app',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Quick Actions API', () => {
  test('uses the confirmed CRUD and run endpoints and accepts 202 run responses', async () => {
    const action = promptAction();
    const runResult: RunQuickActionResponse = {
      cardId: 'card-1',
      status: 'in_progress',
      dispatch: null,
    };
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/run')) {
        return Response.json(runResult, { status: 202 });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (url === '/api/quick-actions' && method === 'GET') return Response.json([action]);
      return Response.json(action, { status: method === 'POST' ? 201 : 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const createInput: CreateQuickActionInput = {
      icon: action.icon,
      type: 'prompt',
      name: action.name,
      description: action.description,
      cardTitleTemplate: action.cardTitleTemplate,
      promptTemplate: action.promptTemplate,
      projectDir: action.projectDir,
      agentRuntime: action.agentRuntime,
    };

    expect(await fetchQuickActions()).toEqual([action]);
    expect(await fetchQuickAction(action.id)).toEqual(action);
    expect(await createQuickAction(createInput)).toEqual(action);
    expect(await updateQuickAction(action.id, { icon: '🧪', pinned: false })).toEqual(action);
    await expect(deleteQuickAction(action.id)).resolves.toBeUndefined();
    await expect(runQuickAction(action.id, {
      clientRequestId: 'request-1',
      parameterValues: {},
    })).resolves.toEqual(runResult);

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method ?? 'GET'])).toEqual([
      ['/api/quick-actions', 'GET'],
      ['/api/quick-actions/action%2Fone', 'GET'],
      ['/api/quick-actions', 'POST'],
      ['/api/quick-actions/action%2Fone', 'PATCH'],
      ['/api/quick-actions/action%2Fone', 'DELETE'],
      ['/api/quick-actions/action%2Fone/run', 'POST'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      icon: '🚀',
      type: 'prompt',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      icon: '🧪',
      pinned: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      clientRequestId: 'request-1',
      parameterValues: {},
    });
  });

  test('surfaces the backend error body and status', async () => {
    const fetchMock = mock(async () => Response.json(
      { error: 'Referenced script not found' },
      { status: 409, statusText: 'Conflict' },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = runQuickAction('missing', {
      clientRequestId: 'request-1',
      parameterValues: {},
    });
    await expect(promise).rejects.toEqual(new QuickActionsApiError(
      409,
      'Referenced script not found',
      { error: 'Referenced script not found' },
    ));
  });
});
