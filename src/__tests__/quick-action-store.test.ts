import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  QuickActionStore,
  buildQuickActionParameterSnapshot,
  renderPromptQuickAction,
} from '../core/quick-action-store';
import { KanbanStore } from '../core/store';
import { ScriptStore } from '../core/script-store';
import type { CreateQuickActionInput, PromptQuickAction } from '../core/types';
import { withTempDir } from './setup';

function promptInput(overrides: Record<string, unknown> = {}): CreateQuickActionInput {
  return {
    type: 'prompt',
    name: 'Review changes',
    description: 'Review the current worktree',
    enabled: true,
    pinned: false,
    order: 10,
    parameterDefinitions: [],
    cardTitleTemplate: 'Review {{scope}}',
    promptTemplate: 'Review {{scope}} carefully.',
    projectDir: '/workspace/project',
    agentRuntime: 'codex',
    model: 'gpt-5.4',
    agentType: 'reviewer',
    codexOptions: { reasoningEffort: 'high', sandbox: 'workspace-write' },
    ...overrides,
  } as CreateQuickActionInput;
}

describe('QuickActionStore', () => {
  test('persists CRUD changes and reloads them from a fresh store', async () => {
    await withTempDir(async (dir) => {
      const scripts = new ScriptStore(dir);
      const store = new QuickActionStore(dir, scripts);
      const created = await store.createAction(promptInput());

      const reloaded = new QuickActionStore(dir, scripts);
      expect((await reloaded.getAction(created.id))?.name).toBe('Review changes');

      const updated = await reloaded.updateAction(created.id, {
        name: 'Review repository',
        enabled: false,
        order: 3,
      });
      expect(updated.name).toBe('Review repository');
      expect(updated.enabled).toBe(false);
      expect(updated.order).toBe(3);

      await reloaded.deleteAction(created.id);
      expect(await store.getAction(created.id)).toBeNull();
    });
  });

  test('sorts pinned actions first and then by order', async () => {
    await withTempDir(async (dir) => {
      const scripts = new ScriptStore(dir);
      const store = new QuickActionStore(dir, scripts);
      await store.createAction(promptInput({ name: 'later', order: 20 }));
      await store.createAction(promptInput({ name: 'pinned', pinned: true, order: 99 }));
      await store.createAction(promptInput({ name: 'earlier', order: 1 }));

      expect((await store.getActions()).map((action) => action.name)).toEqual([
        'pinned',
        'earlier',
        'later',
      ]);
    });
  });

  test('reloads inside the write lock so multiple instances do not lose updates', async () => {
    await withTempDir(async (dir) => {
      const scripts = new ScriptStore(dir);
      const first = new QuickActionStore(dir, scripts);
      const second = new QuickActionStore(dir, scripts);

      await first.createAction(promptInput({ name: 'first' }));
      await second.createAction(promptInput({ name: 'second' }));

      expect((await first.getActions()).map((action) => action.name).sort()).toEqual([
        'first',
        'second',
      ]);
    });
  });

  test('recovers an empty quick-actions file and persists the next write', async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, 'quick-actions.json'), '');
      const scripts = new ScriptStore(dir);
      const store = new QuickActionStore(dir, scripts);

      expect(await store.getActions()).toEqual([]);
      await store.createAction(promptInput());
      const raw = JSON.parse(await Bun.file(join(dir, 'quick-actions.json')).text()) as {
        version: number;
        entries: unknown[];
      };
      expect(raw.version).toBe(1);
      expect(raw.entries).toHaveLength(1);
    });
  });

  test('loads the legacy bare-array format without dropping valid actions', async () => {
    await withTempDir(async (dir) => {
      const legacy = {
        id: 'legacy-action',
        ...promptInput({ name: 'Legacy action', enabled: undefined, pinned: undefined, order: undefined }),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await Bun.write(join(dir, 'quick-actions.json'), JSON.stringify([legacy]));

      const actions = await new QuickActionStore(dir, new ScriptStore(dir)).getActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'legacy-action',
        name: 'Legacy action',
        enabled: true,
        pinned: false,
        order: 0,
      });
    });
  });

  test('strictly rejects malformed parameter schemas and defaults', async () => {
    await withTempDir(async (dir) => {
      const store = new QuickActionStore(dir, new ScriptStore(dir));
      const invalidDefinitions = [
        [{ key: 'bad key', label: 'Bad', type: 'string', required: false }],
        [
          { key: 'scope', label: 'Scope', type: 'string', required: false },
          { key: 'scope', label: 'Again', type: 'string', required: true },
        ],
        [{ key: 'choice', label: 'Choice', type: 'select', required: true, options: [] }],
        [{ key: 'count', label: 'Count', type: 'number', required: false, defaultValue: '1' }],
        [{ key: 'token', label: 'Token', type: 'secret', required: true, defaultValue: 'saved' }],
        [{ key: 'flag', label: 'Flag', type: 'boolean', required: false, options: ['yes'] }],
      ];

      for (const parameterDefinitions of invalidDefinitions) {
        await expect(store.createAction(promptInput({ parameterDefinitions }))).rejects.toThrow();
      }
    });
  });

  test('validates select membership and accepts type-correct defaults', async () => {
    await withTempDir(async (dir) => {
      const store = new QuickActionStore(dir, new ScriptStore(dir));
      await expect(store.createAction(promptInput({
        parameterDefinitions: [{
          key: 'mode',
          label: 'Mode',
          type: 'select',
          required: true,
          options: ['safe', 'fast'],
          defaultValue: 'missing',
        }],
      }))).rejects.toThrow(/options/i);

      const action = await store.createAction(promptInput({
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true, defaultValue: 'src' },
          { key: 'count', label: 'Count', type: 'number', required: false, defaultValue: 2 },
          { key: 'strict', label: 'Strict', type: 'boolean', required: false, defaultValue: true },
          { key: 'mode', label: 'Mode', type: 'select', required: true, options: ['safe', 'fast'], defaultValue: 'safe' },
          { key: 'token', label: 'Token', type: 'secret', required: true },
        ],
      }));
      expect(action.parameterDefinitions).toHaveLength(5);
    });
  });

  test('requires prompt projectDir and rejects options for the wrong runtime', async () => {
    await withTempDir(async (dir) => {
      const store = new QuickActionStore(dir, new ScriptStore(dir));
      await expect(store.createAction(promptInput({ projectDir: '' }))).rejects.toThrow(/projectDir/i);
      await expect(store.createAction(promptInput({
        agentRuntime: 'claude',
        codexOptions: { reasoningEffort: 'high' },
      }))).rejects.toThrow(/codexOptions/i);
    });
  });

  test('stores only a scriptId and derives projectDir and availability from ScriptStore', async () => {
    await withTempDir(async (dir) => {
      const scripts = new ScriptStore(dir);
      const script = await scripts.createEntry({
        name: 'lint',
        description: 'lint',
        content: 'bun test',
        projectDir: '/workspace/from-script',
      });
      const store = new QuickActionStore(dir, scripts);
      const action = await store.createAction({
        type: 'script',
        name: 'Run lint',
        description: 'Run the lint script',
        enabled: true,
        pinned: false,
        order: 1,
        parameterDefinitions: [],
        scriptId: script.id,
      });

      expect(action).toMatchObject({
        scriptId: script.id,
        scriptName: 'lint',
        available: true,
        effectiveProjectDir: '/workspace/from-script',
      });
      expect('content' in action).toBe(false);

      await scripts.deleteEntry(script.id);
      const unavailable = await store.getAction(action.id);
      expect(unavailable).toMatchObject({
        id: action.id,
        available: false,
      });
      expect(unavailable?.unavailableReason).toMatch(/script/i);
    });
  });

  test('rejects a broken script reference on create and update', async () => {
    await withTempDir(async (dir) => {
      const scripts = new ScriptStore(dir);
      const store = new QuickActionStore(dir, scripts);
      await expect(store.createAction({
        type: 'script',
        name: 'Broken',
        description: '',
        enabled: true,
        pinned: false,
        order: 0,
        parameterDefinitions: [],
        scriptId: 'missing-script',
      })).rejects.toThrow(/script/i);

      const first = await scripts.createEntry({ name: 'one', description: '', content: 'echo one' });
      const action = await store.createAction({
        type: 'script',
        name: 'One',
        description: '',
        enabled: true,
        pinned: false,
        order: 0,
        parameterDefinitions: [],
        scriptId: first.id,
      });
      await expect(store.updateAction(action.id, { scriptId: 'missing-script' })).rejects.toThrow(/script/i);
    });
  });
});

describe('buildQuickActionParameterSnapshot', () => {
  test('applies defaults and removes secret values from provenance', () => {
    const action = {
      ...promptInput({
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true, defaultValue: 'src' },
          { key: 'token', label: 'Token', type: 'secret', required: true },
        ],
      }),
      id: 'qa-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as PromptQuickAction;

    expect(buildQuickActionParameterSnapshot(action, { token: 'do-not-store' })).toEqual({
      scope: 'src',
    });
  });

  test('persists sanitized quick action provenance on internally created cards', async () => {
    await withTempDir(async (dir) => {
      const action = {
        ...promptInput({
          parameterDefinitions: [
            { key: 'scope', label: 'Scope', type: 'string', required: true },
            { key: 'token', label: 'Token', type: 'secret', required: true },
          ],
        }),
        id: 'qa-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as PromptQuickAction;
      const parameterSnapshot = buildQuickActionParameterSnapshot(action, {
        scope: 'src',
        token: 'do-not-store',
      });
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Quick review',
        description: 'Review src',
        originChannel: 'quick_action',
        executionKind: 'agent',
        quickActionId: action.id,
        quickActionRequestId: 'request-1',
        parameterSnapshot,
      });

      expect(await store.getCard(card.id)).toMatchObject({
        originChannel: 'quick_action',
        executionKind: 'agent',
        quickActionId: 'qa-1',
        quickActionRequestId: 'request-1',
        parameterSnapshot: { scope: 'src' },
      });
    });
  });

  test('renders exact placeholders once and keeps secrets out of provenance', () => {
    const action = {
      ...promptInput({
        cardTitleTemplate: 'Review {{scope}}',
        promptTemplate: 'Review {{scope}} with token {{token}}',
        command: 'prompts:verifier',
        argumentsTemplate: '--scope {{scope}}',
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true },
          { key: 'token', label: 'Token', type: 'secret', required: true },
        ],
      }),
      id: 'qa-render',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as PromptQuickAction;

    expect(renderPromptQuickAction(action, {
      scope: '{{token}}',
      token: 'runtime-secret',
    })).toEqual({
      title: 'Review {{token}}',
      prompt: 'Review {{token}} with token runtime-secret',
      arguments: '--scope {{token}}',
      parameterSnapshot: { scope: '{{token}}' },
    });
  });

  test('requires a command when a Prompt action stores command arguments', async () => {
    await withTempDir(async (dir) => {
      const store = new QuickActionStore(dir, new ScriptStore(dir));
      await expect(store.createAction(promptInput({
        command: undefined,
        argumentsTemplate: '--scope {{scope}}',
      }))).rejects.toThrow('argumentsTemplate requires command');
    });
  });

  test('rejects blank required values and empty rendered card content', () => {
    const action = {
      ...promptInput({
        cardTitleTemplate: '{{scope}}',
        promptTemplate: '{{scope}}',
        parameterDefinitions: [
          { key: 'scope', label: 'Scope', type: 'string', required: true },
        ],
      }),
      id: 'qa-blank',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as PromptQuickAction;

    expect(() => renderPromptQuickAction(action, { scope: '   ' })).toThrow('Missing required parameter');

    const optional = {
      ...action,
      parameterDefinitions: [
        { key: 'scope', label: 'Scope', type: 'string', required: false },
      ],
    } as PromptQuickAction;
    expect(() => renderPromptQuickAction(optional, { scope: '' })).toThrow('Rendered quick action card title is empty');
  });

  test('atomically reserves one card for a Quick Action idempotency key', async () => {
    await withTempDir(async (dir) => {
      const first = new KanbanStore(dir);
      const second = new KanbanStore(dir);
      const input = {
        title: 'Idempotent action',
        description: 'Dispatch once',
        projectDir: dir,
        originChannel: 'quick_action' as const,
        executionKind: 'agent' as const,
        quickActionId: 'qa-idempotent',
        quickActionRequestId: 'request-idempotent',
      };

      const [left, right] = await Promise.all([
        first.createQuickActionCard(input),
        second.createQuickActionCard(input),
      ]);
      expect([left.created, right.created].sort()).toEqual([false, true]);
      expect(left.card.id).toBe(right.card.id);
      expect((await first.load()).cards).toHaveLength(1);
    });
  });
});
