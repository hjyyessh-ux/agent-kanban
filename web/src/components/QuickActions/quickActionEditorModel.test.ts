import { describe, expect, test } from 'bun:test';
import type { AgentRuntime, QuickActionView } from '../../../../src/core/types';
import { QUICK_ACTION_ICON_PALETTE } from '../../../../src/core/types';
import {
  applyQuickActionEditorDefaults,
  buildQuickActionInput,
  buildQuickActionUpdateInput,
  getFirstAvailableQuickActionIcon,
  getQuickActionIconChoices,
  makeQuickActionEditorDraft,
  makeQuickActionParameterDraft,
} from './quickActionEditorModel';

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'action-1',
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
    agentType: 'atlas',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    available: true,
    effectiveProjectDir: '/workspace/project',
    ...overrides,
  };
}

describe('Quick Action editor model', () => {
  test('assigns stable local row ids to Parameter drafts', () => {
    const first = makeQuickActionParameterDraft();
    const second = makeQuickActionParameterDraft();

    expect(first.rowId).not.toBe(second.rowId);
    expect(first).toMatchObject({ key: '', label: '', type: 'string', required: false });
  });

  test('offers one shared palette, marks icons used elsewhere, and selects the first free icon', () => {
    const actions = [
      promptAction(),
      promptAction({ id: 'action-2', icon: '🔍' }),
    ];

    expect(getFirstAvailableQuickActionIcon(actions)).toBe('🧪');
    expect(getQuickActionIconChoices(actions, '🧪')).toEqual(
      QUICK_ACTION_ICON_PALETTE.map((icon) => ({
        icon,
        selected: icon === '🧪',
        used: icon === '⚡' || icon === '🔍',
      })),
    );
    expect(getFirstAvailableQuickActionIcon(actions, 'action-1')).toBe('⚡');
  });

  test('uses the Create Card runtime/model flow for untouched new Prompt drafts', () => {
    const initial = makeQuickActionEditorDraft(undefined, { runtime: 'opencode', icon: '🚀' });
    const resolveDefault = (runtime: AgentRuntime) => `${runtime}-default`;

    const asynchronousDefaults = applyQuickActionEditorDefaults(
      initial,
      'codex',
      { runtime: false, model: false },
      resolveDefault,
    );
    expect(asynchronousDefaults).toMatchObject({
      icon: '🚀',
      agentRuntime: 'codex',
      model: 'codex-default',
    });

    const opencodeFallback = applyQuickActionEditorDefaults(
      initial,
      undefined,
      { runtime: false, model: false },
      resolveDefault,
    );
    expect(opencodeFallback.agentRuntime).toBe('opencode');
    expect(opencodeFallback.model).toBe('opencode-default');
  });

  test('applies independent touched guards when runtime/model defaults arrive asynchronously', () => {
    const draft = makeQuickActionEditorDraft(undefined, { runtime: 'claude', icon: '📊' });
    draft.model = 'manual-model';

    const bothTouched = applyQuickActionEditorDefaults(
      draft,
      'codex',
      { runtime: true, model: true },
      (runtime) => `${runtime}-late-default`,
    );
    expect(bothTouched).toBe(draft);
    expect(bothTouched).toMatchObject({
      agentRuntime: 'claude',
      model: 'manual-model',
    });

    expect(applyQuickActionEditorDefaults(
      draft,
      'codex',
      { runtime: true, model: false },
      (runtime) => `${runtime}-late-default`,
    )).toMatchObject({
      agentRuntime: 'claude',
      model: 'claude-late-default',
    });
    expect(applyQuickActionEditorDefaults(
      draft,
      'codex',
      { runtime: false, model: true },
      (runtime) => `${runtime}-late-default`,
    )).toMatchObject({
      agentRuntime: 'codex',
      model: 'manual-model',
    });
  });

  test('preserves saved Prompt runtime, model, and icon while building icon CRUD payloads', () => {
    const action = promptAction({ icon: '🧑‍💻' });
    const draft = makeQuickActionEditorDraft(action, {
      runtime: 'codex',
      model: 'late-default',
      icon: '🚀',
    });
    const afterAsyncSettings = applyQuickActionEditorDefaults(
      draft,
      'opencode',
      { runtime: false, model: false },
      () => 'new-default',
    );

    expect(afterAsyncSettings).toBe(draft);
    expect(draft).toMatchObject({
      icon: '🧑‍💻',
      agentRuntime: 'claude',
      model: 'claude-saved',
    });
    expect(buildQuickActionInput(draft)).toMatchObject({
      icon: '🧑‍💻',
      agentRuntime: 'claude',
      model: 'claude-saved',
    });
    expect(buildQuickActionUpdateInput(draft)).toMatchObject({
      icon: '🧑‍💻',
      agentRuntime: 'claude',
      model: 'claude-saved',
    });
  });
});
