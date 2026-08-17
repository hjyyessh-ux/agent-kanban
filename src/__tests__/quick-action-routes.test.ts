import { describe, expect, test } from 'bun:test';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { QuickActionStore } from '../core/quick-action-store';
import { ScriptStore } from '../core/script-store';
import { SettingsStore } from '../core/settings-store';
import { createRouteHandler } from '../server/routes';
import type { DispatchResult, KanbanCard } from '../core/types';
import {
  ScriptExecutionService,
  type ScriptSpawnInput,
  type ScriptSpawnProcess,
} from '../plugin/script-execution-service';
import { withTempDir } from './setup';

const TOKEN = 'quick-action-token';

async function withQuickActionServer(
  callback: (context: {
    baseUrl: string;
    kanbanStore: KanbanStore;
    quickActionStore: QuickActionStore;
    scriptStore: ScriptStore;
    settingsStore: SettingsStore;
    scriptExecutionService: ScriptExecutionService;
    dataDir: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<void>,
  token?: string,
  dispatch?: (cardId: string, store: KanbanStore) => Promise<DispatchResult>,
  scriptSpawn?: (input: ScriptSpawnInput) => ScriptSpawnProcess,
): Promise<void> {
  await withTempDir(async (dir) => {
    const kanbanStore = new KanbanStore(dir);
    const scriptStore = new ScriptStore(dir);
    const settingsStore = new SettingsStore(dir);
    const quickActionStore = new QuickActionStore(dir, scriptStore);
    const scriptExecutionService = new ScriptExecutionService({
      scriptStore,
      settingsStore,
      cardStore: kanbanStore,
      dispatchFn: dispatch ? (cardId) => dispatch(cardId, kanbanStore) : undefined,
      spawn: scriptSpawn,
    });
    const { handleRequest } = createRouteHandler(
      kanbanStore,
      dispatch ? (cardId) => dispatch(cardId, kanbanStore) : undefined,
      undefined,
      undefined,
      settingsStore,
      undefined,
      scriptStore,
      undefined,
      undefined,
      undefined,
      undefined,
      token ? () => token : undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      quickActionStore,
      scriptExecutionService,
    );

    await callback({
      baseUrl: 'http://localhost',
      kanbanStore,
      quickActionStore,
      scriptStore,
      settingsStore,
      scriptExecutionService,
      dataDir: dir,
      request: (path, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Host', 'localhost');
        return handleRequest(new Request(`http://localhost${path}`, { ...init, headers }));
      },
    });
  });
}

async function createPromptAction(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  projectDir: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const response = await request('/api/quick-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...promptBody(), projectDir, ...overrides }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function promptBody() {
  return {
    type: 'prompt',
    name: 'Review',
    description: 'Review changes',
    enabled: true,
    pinned: false,
    order: 2,
    parameterDefinitions: [],
    cardTitleTemplate: 'Review changes',
    promptTemplate: 'Review all changes.',
    projectDir: '/workspace/project',
    agentRuntime: 'codex',
    model: 'gpt-5.4',
    codexOptions: { reasoningEffort: 'high' },
  };
}

describe('quick action routes', () => {
  test('supports create, ordered list, single read, patch, and delete', async () => {
    await withQuickActionServer(async ({ request }) => {
      const createdResponse = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptBody()),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { id: string; available: boolean };
      expect(created.available).toBe(true);

      const listResponse = await request('/api/quick-actions');
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json()) as unknown[]).toHaveLength(1);

      const singleResponse = await request(`/api/quick-actions/${created.id}`);
      expect(singleResponse.status).toBe(200);

      const patchResponse = await request(`/api/quick-actions/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, order: 7 }),
      });
      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.json()).toMatchObject({ enabled: false, order: 7 });

      const deleteResponse = await request(`/api/quick-actions/${created.id}`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(204);
      expect((await request(`/api/quick-actions/${created.id}`)).status).toBe(404);
    });
  });

  test('rejects malformed parameters, missing prompt projectDir, and broken script references', async () => {
    await withQuickActionServer(async ({ request }) => {
      const malformed = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...promptBody(),
          parameterDefinitions: [
            { key: 'same', label: 'One', type: 'string', required: false },
            { key: 'same', label: 'Two', type: 'string', required: false },
          ],
        }),
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toHaveProperty('error');

      const missingProjectDir = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...promptBody(), projectDir: undefined }),
      });
      expect(missingProjectDir.status).toBe(400);

      const brokenScript = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'script',
          name: 'Broken',
          description: '',
          enabled: true,
          pinned: false,
          order: 0,
          parameterDefinitions: [],
          scriptId: 'missing',
        }),
      });
      expect(brokenScript.status).toBe(400);
    });
  });

  test('blocks direct deletion of a referenced script with 409', async () => {
    await withQuickActionServer(async ({ request, scriptStore }) => {
      const script = await scriptStore.createEntry({ name: 'lint', description: '', content: 'echo lint' });
      const createAction = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'script',
          name: 'Lint',
          description: '',
          enabled: true,
          pinned: false,
          order: 0,
          parameterDefinitions: [],
          scriptId: script.id,
        }),
      });
      expect(createAction.status).toBe(201);

      const deleteScript = await request(`/api/scripts/${script.id}`, { method: 'DELETE' });
      expect(deleteScript.status).toBe(409);
      expect(await deleteScript.json()).toHaveProperty('error');
      expect(await scriptStore.getEntry(script.id)).not.toBeNull();
    });
  });

  test('keeps an action but marks it unavailable when directory sync removes its script', async () => {
    await withQuickActionServer(async ({ request, scriptStore }) => {
      const scriptsDir = scriptStore.scriptsDir;
      if (!scriptsDir) throw new Error('scriptsDir missing');
      mkdirSync(scriptsDir, { recursive: true });
      const path = join(scriptsDir, 'temporary.sh');
      writeFileSync(path, 'echo temporary');
      await scriptStore.syncFromDirectory();
      const script = (await scriptStore.getEntries()).find((entry) => entry.name === 'temporary');
      if (!script) throw new Error('synced script missing');

      const actionResponse = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'script',
          name: 'Temporary',
          description: '',
          enabled: true,
          pinned: false,
          order: 0,
          parameterDefinitions: [],
          scriptId: script.id,
        }),
      });
      const action = await actionResponse.json() as { id: string };

      unlinkSync(path);
      const syncResponse = await request('/api/scripts/sync', { method: 'POST' });
      expect(syncResponse.status).toBe(200);

      const readResponse = await request(`/api/quick-actions/${action.id}`);
      expect(readResponse.status).toBe(200);
      expect(await readResponse.json()).toMatchObject({ available: false });
    });
  });

  test('requires bearer auth for writes while allowing reads', async () => {
    let dispatchCount = 0;
    await withQuickActionServer(async ({ request, dataDir }) => {
      expect((await request('/api/quick-actions')).status).toBe(200);

      const unauthorized = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptBody()),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await request('/api/quick-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ ...promptBody(), projectDir: dataDir }),
      });
      expect(authorized.status).toBe(201);
      const action = await authorized.json() as { id: string };

      const runBody = JSON.stringify({ clientRequestId: 'authorized-run', parameterValues: {} });
      expect((await request(`/api/quick-actions/${action.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: runBody,
      })).status).toBe(401);

      const authorizedRun = await request(`/api/quick-actions/${action.id}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: runBody,
      });
      expect(authorizedRun.status).toBe(200);
      expect(dispatchCount).toBe(1);
    }, TOKEN, async (cardId, store) => {
      dispatchCount += 1;
      await store.updateCard(cardId, { status: 'in_progress', sessionId: 'authorized-session' });
      return {
        sessionId: 'authorized-session',
        runId: 'authorized-run',
        startedAt: '2026-08-16T00:00:00.000Z',
      };
    });
  });

  test('keeps same-origin CORS behavior for quick action routes', async () => {
    await withQuickActionServer(async ({ baseUrl, request }) => {
      const crossOrigin = await request('/api/quick-actions', {
        headers: { Origin: 'https://evil.example' },
      });
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin request rejected' });

      const preflight = await request('/api/quick-actions', {
        method: 'OPTIONS',
        headers: { Origin: baseUrl },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH');
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  test('normal card POST cannot inject quick action provenance', async () => {
    await withQuickActionServer(async ({ request }) => {
      const response = await request('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Ordinary card',
          description: 'No provenance allowed',
          originChannel: 'quick_action',
          executionKind: 'script',
          quickActionId: 'qa-forged',
          quickActionRequestId: 'request-forged',
          scriptRunId: 'run-forged',
          scriptName: 'forged script',
          parameterSnapshot: { token: 'secret' },
        }),
      });
      expect(response.status).toBe(201);
      const card = await response.json() as Record<string, unknown>;
      expect(card.originChannel).toBeUndefined();
      expect(card.executionKind).toBeUndefined();
      expect(card.quickActionId).toBeUndefined();
      expect(card.quickActionRequestId).toBeUndefined();
      expect(card.scriptRunId).toBeUndefined();
      expect(card.scriptName).toBeUndefined();
      expect(card.parameterSnapshot).toBeUndefined();

      const patchResponse = await request(`/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quickActionId: 'qa-forged',
          quickActionRequestId: 'request-forged',
          quickActionRun: {
            status: 'accepted',
            dispatch: {
              sessionId: 'forged',
              runId: 'forged',
              startedAt: '2026-08-16T00:00:00.000Z',
            },
            updatedAt: '2026-08-16T00:00:00.000Z',
          },
          scriptName: 'forged script',
        }),
      });
      expect(patchResponse.status).toBe(200);
      const patchedCard = await patchResponse.json();
      expect(patchedCard).not.toHaveProperty('quickActionRun');
      expect(patchedCard).not.toHaveProperty('scriptName');
    });
  });

  test('runs the three-day MCP monitoring fixture as a read-only Codex card', async () => {
    const fixture = await Bun.file(new URL('./fixtures/quick-action-mcp-monitoring.json', import.meta.url)).json() as {
      action: Record<string, unknown>;
      request: { clientRequestId: string; parameterValues: Record<string, unknown> };
      expected: { title: string; prompt: string };
    };
    let cardAtDispatch: KanbanCard | null = null;

    await withQuickActionServer(async ({ request, dataDir, kanbanStore }) => {
      const action = await createPromptAction(request, dataDir, {
        ...fixture.action,
        projectDir: dataDir,
        command: 'prompts:verifier',
        argumentsTemplate: '--days {{days}} --scope {{scope}}',
      });
      const response = await request(`/api/quick-actions/${action.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixture.request),
      });

      expect(response.status).toBe(200);
      const result = await response.json() as {
        cardId: string;
        status: string;
        dispatch: DispatchResult;
      };
      expect(result).toMatchObject({
        status: 'in_progress',
        dispatch: {
          sessionId: 'codex-thread-mcp',
          runId: 'codex-run-mcp',
        },
      });

      const card = await kanbanStore.getCard(result.cardId);
      expect(card).toMatchObject({
        title: fixture.expected.title,
        description: fixture.expected.prompt,
        status: 'in_progress',
        sessionId: 'codex-thread-mcp',
        projectDir: dataDir,
        agentRuntime: 'codex',
        model: 'gpt-5.5',
        agentType: 'general',
        command: 'prompts:verifier',
        arguments: '--days 3 --scope all',
        codexOptions: {
          reasoningEffort: 'high',
          sandbox: 'read-only',
          skipGitRepoCheck: false,
          bypassApprovalsAndSandbox: false,
        },
        originChannel: 'quick_action',
        executionKind: 'agent',
        quickActionId: action.id,
        quickActionRequestId: fixture.request.clientRequestId,
        parameterSnapshot: { days: 3, scope: 'all' },
      });
      expect(cardAtDispatch).toMatchObject({
        projectDir: dataDir,
        codexOptions: { sandbox: 'read-only' },
      });
    }, undefined, async (cardId, store) => {
      const card = await store.getCard(cardId);
      if (!card) throw new Error('card missing at dispatch');
      cardAtDispatch = card;
      await store.updateCard(cardId, { status: 'in_progress', sessionId: 'codex-thread-mcp' });
      return {
        sessionId: 'codex-thread-mcp',
        runId: 'codex-run-mcp',
        startedAt: '2026-08-16T00:00:00.000Z',
      };
    });
  });

  test('rejects missing, mistyped, invalid select, unknown, and unresolved parameters before card creation', async () => {
    await withQuickActionServer(async ({ request, dataDir, kanbanStore }) => {
      const action = await createPromptAction(request, dataDir, {
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true },
          { key: 'count', label: 'Count', type: 'number', required: true },
          { key: 'strict', label: 'Strict', type: 'boolean', required: true },
          { key: 'mode', label: 'Mode', type: 'select', required: true, options: ['safe', 'fast'] },
        ],
        cardTitleTemplate: 'Review {{scope}} in {{mode}} mode',
        promptTemplate: 'Review {{count}} items; strict={{strict}}.',
      });
      const invalidValues = [
        { count: 3, strict: true, mode: 'safe' },
        { scope: 'src', count: '3', strict: true, mode: 'safe' },
        { scope: 'src', count: 3, strict: 'true', mode: 'safe' },
        { scope: 'src', count: 3, strict: true, mode: 'unsafe' },
        { scope: 'src', count: 3, strict: true, mode: 'safe', extra: 'unknown' },
      ];

      for (const [index, parameterValues] of invalidValues.entries()) {
        const response = await request(`/api/quick-actions/${action.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientRequestId: `invalid-${index}`, parameterValues }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toHaveProperty('error');
      }

      const unresolvedAction = await createPromptAction(request, dataDir, {
        parameterDefinitions: [
          { key: 'optional', label: 'Optional', type: 'string', required: false },
        ],
        cardTitleTemplate: 'Monitor {{optional}}',
        promptTemplate: 'Monitor safely.',
      });
      const unresolved = await request(`/api/quick-actions/${unresolvedAction.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'unresolved', parameterValues: {} }),
      });
      expect(unresolved.status).toBe(400);
      expect(await unresolved.json()).toEqual({ error: 'Unresolved quick action placeholder: optional' });

      const malformedAction = await createPromptAction(request, dataDir, {
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true },
        ],
        cardTitleTemplate: 'Monitor {{ scope }}',
        promptTemplate: 'Monitor {{scope}}.',
      });
      const malformed = await request(`/api/quick-actions/${malformedAction.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'malformed', parameterValues: { scope: 'all' } }),
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'Quick action template contains an invalid placeholder' });
      expect((await kanbanStore.load()).cards).toHaveLength(0);
    });
  });

  test('rejects invalid project directories and disabled or unavailable actions without dispatching', async () => {
    let dispatchCount = 0;
    await withQuickActionServer(async ({ request, dataDir, scriptStore, kanbanStore }) => {
      const invalidDirAction = await createPromptAction(request, join(dataDir, 'missing'));
      const invalidDir = await request(`/api/quick-actions/${invalidDirAction.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'invalid-dir', parameterValues: {} }),
      });
      expect(invalidDir.status).toBe(400);
      expect(await invalidDir.json()).toHaveProperty('error');

      const disabledAction = await createPromptAction(request, dataDir, { enabled: false });
      const disabled = await request(`/api/quick-actions/${disabledAction.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'disabled', parameterValues: {} }),
      });
      expect(disabled.status).toBe(409);
      expect(await disabled.json()).toEqual({ error: 'Quick action is disabled' });

      const script = await scriptStore.createEntry({ name: 'removed', description: '', content: 'echo removed' });
      const scriptActionResponse = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'script',
          name: 'Removed script',
          description: '',
          parameterDefinitions: [],
          scriptId: script.id,
        }),
      });
      const scriptAction = await scriptActionResponse.json() as { id: string };
      await scriptStore.deleteEntry(script.id);
      const unavailable = await request(`/api/quick-actions/${scriptAction.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'unavailable', parameterValues: {} }),
      });
      expect(unavailable.status).toBe(409);
      expect((await unavailable.json() as { error: string }).error).toContain('Referenced script not found');

      expect(dispatchCount).toBe(0);
      expect((await kanbanStore.load()).cards).toHaveLength(0);
    }, undefined, async () => {
      dispatchCount += 1;
      throw new Error('must not dispatch');
    });
  });

  test('deduplicates concurrent double taps and later retries to the same card and dispatch result', async () => {
    let dispatchCount = 0;
    let markDispatchStarted: () => void = () => {};
    let releaseDispatch: () => void = () => {};
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });

    await withQuickActionServer(async ({ request, dataDir, kanbanStore }) => {
      const action = await createPromptAction(request, dataDir);
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'double-tap', parameterValues: {} }),
      };
      const firstRequest = request(`/api/quick-actions/${action.id}/run`, init);
      await dispatchStarted;
      const secondRequest = request(`/api/quick-actions/${action.id}/run`, init);
      releaseDispatch();

      const firstResponse = await firstRequest;
      const secondResponse = await secondRequest;
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const firstResult = await firstResponse.json();
      const secondResult = await secondResponse.json();
      expect(secondResult).toEqual(firstResult);

      const retryResponse = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toEqual(firstResult);
      expect(dispatchCount).toBe(1);
      expect((await kanbanStore.load()).cards).toHaveLength(1);
    }, undefined, async (cardId, store) => {
      dispatchCount += 1;
      await store.updateCard(cardId, { status: 'in_progress', sessionId: 'dedup-session' });
      markDispatchStarted();
      await dispatchGate;
      return {
        sessionId: 'dedup-session',
        runId: 'dedup-run',
        startedAt: '2026-08-16T01:00:00.000Z',
      };
    });
  });

  test('keeps a failed dispatch card in todo with a durable failure response', async () => {
    let dispatchCount = 0;
    await withQuickActionServer(async ({ request, dataDir, kanbanStore }) => {
      const action = await createPromptAction(request, dataDir);
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'failed-dispatch', parameterValues: {} }),
      };
      const response = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(response.status).toBe(502);
      const result = await response.json() as {
        error: string;
        cardId: string;
        status: string;
        dispatch: null;
        failureSummary: string;
      };
      expect(result).toMatchObject({ status: 'todo', dispatch: null });
      expect(result.failureSummary).toContain('[failed] Quick action dispatch failed: runtime unavailable');
      expect(result.error).toBe(result.failureSummary);

      const card = await kanbanStore.getCard(result.cardId);
      expect(card).toMatchObject({
        status: 'todo',
        progressSummary: result.failureSummary,
        quickActionRun: {
          status: 'failed',
          dispatch: null,
          errorStatusCode: 502,
        },
      });

      const retry = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(retry.status).toBe(502);
      expect(await retry.json()).toEqual(result);
      expect(dispatchCount).toBe(1);
    }, undefined, async (cardId, store) => {
      dispatchCount += 1;
      await store.updateCard(cardId, { status: 'in_progress', sessionId: 'transient-session' });
      throw Object.assign(new Error('runtime unavailable'), { statusCode: 502 });
    });
  });

  test('preserves the runtime model, agent, and runtime-specific options through dispatch', async () => {
    const cardsAtDispatch: KanbanCard[] = [];
    await withQuickActionServer(async ({ request, dataDir }) => {
      const cases = [
        {
          name: 'opencode',
          overrides: {
            agentRuntime: 'opencode',
            model: 'anthropic/claude-sonnet-4-5',
            agentType: 'reviewer',
            codexOptions: undefined,
          },
        },
        {
          name: 'codex',
          overrides: {
            agentRuntime: 'codex',
            model: 'gpt-5.5',
            agentType: 'general',
            codexOptions: { reasoningEffort: 'xhigh', sandbox: 'read-only', skipGitRepoCheck: true },
          },
        },
        {
          name: 'claude',
          overrides: {
            agentRuntime: 'claude',
            model: 'claude-opus-5',
            agentType: 'general-purpose',
            codexOptions: undefined,
            claudeOptions: { permissionMode: 'plan', dangerouslySkipPermissions: false },
          },
        },
      ];

      for (const runtimeCase of cases) {
        const action = await createPromptAction(request, dataDir, runtimeCase.overrides);
        const response = await request(`/api/quick-actions/${action.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientRequestId: `runtime-${runtimeCase.name}`,
            parameterValues: {},
          }),
        });
        expect(response.status).toBe(200);
      }

      expect(cardsAtDispatch).toHaveLength(3);
      expect(cardsAtDispatch[0]).toMatchObject({
        agentRuntime: 'opencode',
        model: 'anthropic/claude-sonnet-4-5',
        agentType: 'reviewer',
      });
      expect(cardsAtDispatch[0].codexOptions).toBeUndefined();
      expect(cardsAtDispatch[0].claudeOptions).toBeUndefined();
      expect(cardsAtDispatch[1]).toMatchObject({
        agentRuntime: 'codex',
        model: 'gpt-5.5',
        agentType: 'general',
        codexOptions: { reasoningEffort: 'xhigh', sandbox: 'read-only', skipGitRepoCheck: true },
      });
      expect(cardsAtDispatch[2]).toMatchObject({
        agentRuntime: 'claude',
        model: 'claude-opus-5',
        agentType: 'general-purpose',
        claudeOptions: { permissionMode: 'plan', dangerouslySkipPermissions: false },
      });
    }, undefined, async (cardId, store) => {
      const card = await store.getCard(cardId);
      if (!card) throw new Error('card missing at dispatch');
      cardsAtDispatch.push(card);
      const sessionId = `${card.agentRuntime}-session`;
      await store.updateCard(cardId, { status: 'in_progress', sessionId });
      return {
        sessionId,
        runId: `${card.agentRuntime}-run`,
        startedAt: '2026-08-16T02:00:00.000Z',
      };
    });
  });

  test('runs the deployment script fixture asynchronously as one idempotent tracked card', async () => {
    const fixture = await Bun.file(
      new URL('./fixtures/quick-action-script-deployment.json', import.meta.url),
    ).json() as {
      script: Record<string, unknown>;
      action: Record<string, unknown>;
      request: { clientRequestId: string; parameterValues: Record<string, unknown> };
    };
    let release!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => { release = resolve; });
    const captured: ScriptSpawnInput[] = [];

    await withQuickActionServer(async ({
      request,
      dataDir,
      scriptStore,
      settingsStore,
      kanbanStore,
      scriptExecutionService,
    }) => {
      await settingsStore.createEntry({
        key: 'DEPLOY_ENV', value: 'staging', description: 'deployment environment', masked: false,
      });
      const script = await scriptStore.createEntry({
        ...fixture.script,
        name: fixture.script.name as string,
        description: fixture.script.description as string,
        content: fixture.script.content as string,
        language: fixture.script.language as string,
        projectDir: dataDir,
      });
      const actionResponse = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fixture.action, scriptId: script.id, projectDir: dataDir }),
      });
      expect(actionResponse.status).toBe(201);
      const action = await actionResponse.json() as { id: string };
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixture.request),
      };

      const accepted = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(accepted.status).toBe(202);
      const first = await accepted.json() as {
        cardId: string;
        runId: string;
        status: string;
        runStatus: string;
      };
      expect(first).toMatchObject({ status: 'in_progress', runStatus: 'running' });

      const duplicate = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(duplicate.status).toBe(202);
      expect(await duplicate.json()).toMatchObject({ cardId: first.cardId, runId: first.runId });
      expect((await kanbanStore.load()).cards).toHaveLength(1);
      expect((await scriptStore.getHistory(script.id))).toHaveLength(1);
      expect(await kanbanStore.getCard(first.cardId)).toMatchObject({
        status: 'in_progress',
        originChannel: 'quick_action',
        executionKind: 'script',
        scriptRunId: first.runId,
        scriptName: fixture.script.name,
        projectDir: dataDir,
        parameterSnapshot: {
          service: fixture.request.parameterValues.service,
          replicas: 3,
          dryRun: false,
          region: 'ap-northeast-2',
        },
      });

      release(0);
      await scriptExecutionService.waitForRun(first.runId);
      const completed = await request(`/api/cards/${first.cardId}`);
      expect(completed.status).toBe(200);
      const completedCard = await completed.json() as KanbanCard;
      expect(completedCard).toMatchObject({ status: 'complete', resolution: 'completed' });
      expect(JSON.stringify(completedCard)).not.toContain('fixture-secret-token');
      expect(captured).toHaveLength(1);
      expect(captured[0].argv).toEqual(['bash', '-c', fixture.script.content as string]);
      expect(captured[0].cwd).toBe(dataDir);
      expect(captured[0].env).toMatchObject({
        AK_PARAM_SERVICE: fixture.request.parameterValues.service,
        AK_PARAM_REPLICAS: '3',
        AK_PARAM_DRY_RUN: 'false',
        AK_PARAM_REGION: 'ap-northeast-2',
        AK_PARAM_DEPLOY_TOKEN: 'fixture-secret-token',
        DEPLOY_ENV: 'staging',
      });

      const unknown = await request(`/api/quick-actions/${action.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: 'unknown-script-param',
          parameterValues: { ...fixture.request.parameterValues, interpreter: 'zsh' },
        }),
      });
      expect(unknown.status).toBe(400);
    }, undefined, undefined, (input) => {
      captured.push(input);
      return {
        stdout: new Blob(['deployed fixture-secret-token']).stream(),
        stderr: new Blob([]).stream(),
        exited,
      };
    });
  });

  test('keeps script failure terminal and returns the same card/run on clientRequestId retry', async () => {
    await withQuickActionServer(async ({
      request,
      dataDir,
      scriptStore,
      kanbanStore,
      scriptExecutionService,
    }) => {
      const script = await scriptStore.createEntry({
        name: 'broken-deploy', description: '', content: 'exit 12', language: 'bash', projectDir: dataDir,
      });
      const actionResponse = await request('/api/quick-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'script',
          name: 'Broken deploy',
          description: '',
          enabled: true,
          pinned: false,
          order: 0,
          scriptId: script.id,
          parameterDefinitions: [],
        }),
      });
      const action = await actionResponse.json() as { id: string };
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'same-failure', parameterValues: {} }),
      };

      const accepted = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(accepted.status).toBe(202);
      const first = await accepted.json() as { cardId: string; runId: string };
      await scriptExecutionService.waitForRun(first.runId);

      expect(await kanbanStore.getCard(first.cardId)).toMatchObject({
        status: 'complete',
        resolution: 'failed',
        quickActionRun: {
          status: 'failed',
          scriptRunId: first.runId,
        },
      });
      const retry = await request(`/api/quick-actions/${action.id}/run`, init);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        cardId: first.cardId,
        runId: first.runId,
        status: 'complete',
        runStatus: 'fail',
      });
      expect((await kanbanStore.load()).cards).toHaveLength(1);
      expect((await scriptStore.getHistory(script.id))).toHaveLength(1);
    }, undefined, undefined, () => {
      throw new Error('spawn unavailable');
    });
  });
});
