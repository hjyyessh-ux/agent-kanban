import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuickActionView } from '../../../../src/core/types';
import {
  buildQuickActionInput,
  isProductionQuickAction,
  makeQuickActionEditorDraft,
  QuickActionsDialog,
} from './QuickActionsDialog';

function promptAction(overrides: Partial<QuickActionView> = {}): QuickActionView {
  return {
    id: 'qa-prompt',
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
    codexOptions: { sandbox: 'read-only', reasoningEffort: 'high' },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    available: true,
    effectiveProjectDir: '/workspace/project',
    ...overrides,
  } as QuickActionView;
}

describe('QuickActionsDialog model', () => {
  test('builds Prompt and Script contracts with normalized parameter definitions', () => {
    const promptDraft = makeQuickActionEditorDraft(promptAction());
    promptDraft.command = 'review';
    promptDraft.commandArguments = '--scope {{days}}';
    promptDraft.parameters = [{
      key: 'days', label: 'Days', type: 'number', required: true, defaultValue: '3', options: '',
    }];
    expect(buildQuickActionInput(promptDraft)).toMatchObject({
      type: 'prompt',
      projectDir: '/workspace/project',
      command: 'review',
      argumentsTemplate: '--scope {{days}}',
      codexOptions: { sandbox: 'read-only', reasoningEffort: 'high' },
      parameterDefinitions: [{ key: 'days', type: 'number', defaultValue: 3 }],
    });

    const scriptDraft = makeQuickActionEditorDraft();
    Object.assign(scriptDraft, { type: 'script', name: 'Deploy', scriptId: 'script-1' });
    scriptDraft.parameters = [{
      key: 'dryRun', label: 'Dry run', type: 'boolean', required: true, defaultValue: 'false', options: '',
    }];
    expect(buildQuickActionInput(scriptDraft)).toMatchObject({
      type: 'script',
      scriptId: 'script-1',
      parameterDefinitions: [{ key: 'dryRun', type: 'boolean', defaultValue: false }],
    });
  });

  test('rejects missing Prompt directory and Script parameter environment collisions', () => {
    const missingDirectory = makeQuickActionEditorDraft(promptAction({ projectDir: '' }));
    expect(() => buildQuickActionInput(missingDirectory)).toThrow('Prompt project directory is required');

    const colliding = makeQuickActionEditorDraft();
    Object.assign(colliding, { type: 'script', name: 'Deploy', scriptId: 'script-1' });
    colliding.parameters = [
      { key: 'dryRun', label: 'One', type: 'string', required: false, defaultValue: '', options: '' },
      { key: 'dry_run', label: 'Two', type: 'string', required: false, defaultValue: '', options: '' },
    ];
    expect(() => buildQuickActionInput(colliding)).toThrow('AK_PARAM_DRY_RUN');
  });

  test('requires explicit confirmation for production or elevated permission actions', () => {
    expect(isProductionQuickAction(promptAction({ projectDir: '/srv/production' }))).toBe(true);
    expect(isProductionQuickAction(promptAction({ codexOptions: { sandbox: 'danger-full-access' } }))).toBe(true);
    expect(isProductionQuickAction(promptAction())).toBe(false);
  });

  test('renders existing kv2 launcher controls and unavailable reason', () => {
    const broken = {
      id: 'qa-script',
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
    const html = renderToStaticMarkup(
      <QuickActionsDialog
        actions={[broken]}
        scripts={[]}
        loading={false}
        error={null}
        runningActionIds={[]}
        onCreate={mock(async () => broken)}
        onUpdate={mock(async () => undefined)}
        onDelete={mock(async () => undefined)}
        onRun={mock(async () => ({ cardId: 'card', status: 'in_progress' as const, dispatch: null }))}
        onRefresh={mock(async () => undefined)}
        onClearError={mock(() => undefined)}
        onClose={mock(() => undefined)}
      />,
    );

    expect(html).toContain('class="kv2-dialog');
    expect(html).toContain('Manage');
    expect(html).toContain('Add Action');
    expect(html).toContain('Referenced script not found: missing-script');
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('neo-');
  });
});
