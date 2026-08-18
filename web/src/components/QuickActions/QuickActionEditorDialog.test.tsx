import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuickActionView } from '../../../../src/core/types';
import { QuickActionEditorDialog } from './QuickActionEditorDialog';

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;
type ScriptQuickActionView = Extract<QuickActionView, { type: 'script' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'prompt-1',
    icon: '⚡',
    type: 'prompt',
    name: 'Inspect',
    description: 'Inspect the project',
    enabled: true,
    pinned: false,
    order: 0,
    parameterDefinitions: [],
    cardTitleTemplate: 'Inspect project',
    promptTemplate: 'Inspect this project.',
    projectDir: '/workspace/project',
    agentRuntime: 'claude',
    model: 'claude-saved',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    available: true,
    effectiveProjectDir: '/workspace/project',
    ...overrides,
  };
}

function scriptAction(overrides: Partial<ScriptQuickActionView> = {}): ScriptQuickActionView {
  return {
    id: 'script-1',
    icon: '📦',
    type: 'script',
    name: 'Package',
    description: 'Build a package',
    enabled: true,
    pinned: false,
    order: 1,
    parameterDefinitions: [],
    scriptId: 'build-script',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    available: true,
    scriptName: 'Build script',
    ...overrides,
  };
}

function renderEditor(action: QuickActionView | undefined, actions: QuickActionView[]): string {
  return renderToStaticMarkup(
    <QuickActionEditorDialog
      action={action}
      actions={actions}
      scripts={[]}
      error={null}
      onCreate={mock(async () => promptAction())}
      onUpdate={mock(async () => undefined)}
      onRefresh={mock(async () => undefined)}
      onClearError={mock(() => undefined)}
      onSaved={mock(() => undefined)}
      onCancel={mock(() => undefined)}
    />,
  );
}

describe('QuickActionEditorDialog', () => {
  test('renders a dedicated DialogSkeleton editor with palette availability and Prompt runtime/model fields', () => {
    const actions = [promptAction(), promptAction({ id: 'prompt-2', icon: '🔍' })];
    const html = renderEditor(undefined, actions);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Add Quick Action');
    expect(html).toContain('aria-label="Default icon palette"');
    expect(html).toContain('aria-label="⚡ already in use"');
    expect(html).toContain('aria-label="🧪 selected"');
    expect(html).toContain('id="quick-action-custom-icon"');
    expect(html).toContain('id="quick-action-runtime"');
    expect(html).toContain('id="quick-action-model"');
    expect(html).toContain('Allow this action to run');
    expect(html).toContain('keep the action saved while preventing new runs');
    expect(html).toContain('Pin to top of list');
    expect(html).toContain('before Quick Actions that are not pinned');
    expect(html).not.toContain('neo-');
  });

  test('shows saved custom icon and runtime for an existing Prompt action', () => {
    const action = promptAction({ icon: '🧑‍💻' });
    const html = renderEditor(action, [action]);

    expect(html).toContain('Edit Quick Action');
    expect(html).toContain('value="🧑‍💻"');
    expect(html).toContain('kv2-create-agent-chip--runtime-claude');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('id="quick-action-model"');
  });

  test('keeps icon editing but hides Runtime and Model for Script actions', () => {
    const action = scriptAction();
    const html = renderEditor(action, [action]);

    expect(html).toContain('aria-label="📦 selected"');
    expect(html).toContain('id="quick-action-script"');
    expect(html).not.toContain('id="quick-action-runtime"');
    expect(html).not.toContain('id="quick-action-model"');
  });
});
