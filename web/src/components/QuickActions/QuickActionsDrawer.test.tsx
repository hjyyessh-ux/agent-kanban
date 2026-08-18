import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuickActionView } from '../../../../src/core/types';
import {
  buildQuickActionInput,
  buildQuickActionUpdateInput,
  makeQuickActionEditorDraft,
  QuickActionsDrawer,
} from './QuickActionsDrawer';

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'qa-prompt',
    icon: '⚡',
    type: 'prompt',
    name: 'Monitor MCP',
    description: 'Monitor recent servers',
    enabled: true,
    pinned: true,
    order: 0,
    parameterDefinitions: [],
    cardTitleTemplate: 'Monitor MCP',
    promptTemplate: 'Monitor MCP safely.',
    projectDir: '/workspace/project',
    agentRuntime: 'codex',
    model: 'gpt-5.4',
    codexOptions: { sandbox: 'read-only', reasoningEffort: 'high' },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    available: true,
    effectiveProjectDir: '/workspace/project',
    ...overrides,
  };
}

function renderDrawer(
  open: boolean,
  actions: QuickActionView[],
  runningActionIds: string[] = [],
): string {
  return renderToStaticMarkup(
    <QuickActionsDrawer
      open={open}
      actions={actions}
      scripts={[]}
      loading={false}
      error={null}
      runningActionIds={runningActionIds}
      onOpen={mock(() => undefined)}
      onClose={mock(() => undefined)}
      onCreate={mock(async () => promptAction())}
      onUpdate={mock(async () => undefined)}
      onDelete={mock(async () => undefined)}
      onRun={mock(async () => ({ cardId: 'card', status: 'in_progress' as const, dispatch: null }))}
      onRefresh={mock(async () => undefined)}
      onClearError={mock(() => undefined)}
    />,
  );
}

describe('QuickActionsDrawer', () => {
  test('builds Prompt and Script icon CRUD contracts with normalized parameters', () => {
    const promptDraft = makeQuickActionEditorDraft(promptAction());
    promptDraft.command = 'review';
    promptDraft.commandArguments = '--scope {{days}}';
    promptDraft.parameters = [{
      rowId: 'test-parameter', key: 'days', label: 'Days', type: 'number', required: true, defaultValue: '3', options: '',
    }];
    expect(buildQuickActionInput(promptDraft)).toMatchObject({
      icon: '⚡',
      type: 'prompt',
      projectDir: '/workspace/project',
      command: 'review',
      argumentsTemplate: '--scope {{days}}',
      parameterDefinitions: [{ key: 'days', type: 'number', defaultValue: 3 }],
    });
    expect(buildQuickActionUpdateInput(promptDraft)).toMatchObject({
      icon: '⚡',
      agentRuntime: 'codex',
      model: 'gpt-5.4',
    });

    const scriptDraft = makeQuickActionEditorDraft();
    Object.assign(scriptDraft, {
      icon: '🚀', type: 'script', name: 'Deploy', scriptId: 'script-1',
    });
    expect(buildQuickActionInput(scriptDraft)).toMatchObject({
      icon: '🚀',
      type: 'script',
      scriptId: 'script-1',
    });
  });

  test('renders a labeled edge-tab launcher that controls the modal sheet', () => {
    const html = renderDrawer(false, [promptAction()]);

    expect(html).toContain('class="kv2-quick-actions-drawer kv2-quick-actions-drawer--collapsed"');
    expect(html).toContain('aria-label="Open Quick Actions"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="quick-actions-drawer-panel"');
    expect(html).toContain('title="Open Quick Actions"');
    expect(html).toContain('kv2-btn--edge-tab');
    expect(html).toContain('kv2-quick-actions-rail-icon');
    expect(html).toContain('kv2-quick-actions-rail-label');
    expect(html).toContain('kv2-quick-actions-rail-cue');
    expect(html).toContain('Quick');
    expect(html).toContain('›');
    expect(html).not.toContain('class="kv2-badge"');
    expect(html).not.toContain('kv2-quick-actions-launcher');
    expect(html).not.toContain('role="dialog"');
  });

  test('renders a modal side sheet with compact row metadata and overflow CRUD actions', () => {
    const broken = {
      id: 'qa-script',
      icon: '🧪',
      type: 'script',
      name: 'Broken deploy',
      description: '',
      enabled: true,
      pinned: false,
      order: 1,
      parameterDefinitions: [],
      scriptId: 'missing-script',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      available: false,
      unavailableReason: 'Referenced script not found: missing-script',
    } satisfies QuickActionView;
    const prompt = promptAction();
    const html = renderDrawer(true, [prompt, broken], [prompt.id]);

    expect(html).toContain('kv2-dialog-overlay--side-sheet');
    expect(html).toContain('kv2-dialog--side-sheet');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="quick-actions-drawer-panel"');
    expect(html).toContain('Add Action');
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain('aria-label="Close dialog backdrop"');
    expect(html).toContain('Prompt');
    expect(html).toContain('Script');
    expect(html).toContain('Running');
    expect(html).toContain('Unavailable');
    expect(html).toContain('Pinned');
    expect(html).not.toContain('★');
    expect(html).not.toContain('Available');
    expect(html).toContain('Referenced script not found: missing-script');
    expect(html).toContain('aria-label="More actions for Monitor MCP"');
    expect(html).toContain('aria-label="Edit Monitor MCP"');
    expect(html).toContain('aria-label="Delete Broken deploy"');
    expect(html).not.toContain('neo-');
  });
});
