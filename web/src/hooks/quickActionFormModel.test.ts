import { describe, expect, test } from 'bun:test';
import type {
  QuickActionParameterDefinition,
  QuickActionView,
} from '../../../src/core/types';
import {
  buildQuickActionFormModel,
  redactQuickActionSecretValues,
  validateQuickActionParameterValues,
} from './quickActionFormModel';

const definitions: QuickActionParameterDefinition[] = [
  { key: 'scope', label: 'Scope', type: 'string', required: true, defaultValue: 'src' },
  { key: 'retries', label: 'Retries', type: 'number', required: true, defaultValue: 3 },
  { key: 'strict', label: 'Strict', type: 'boolean', required: true, defaultValue: false },
  {
    key: 'mode',
    label: 'Mode',
    type: 'select',
    required: true,
    options: ['safe', 'fast'],
    defaultValue: 'safe',
  },
  { key: 'token', label: 'Token', type: 'secret', required: true },
];

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'prompt-action',
    icon: '⚡',
    type: 'prompt',
    name: 'Prompt action',
    description: '',
    enabled: true,
    pinned: false,
    order: 0,
    parameterDefinitions: definitions,
    cardTitleTemplate: 'Run {{scope}}',
    promptTemplate: 'Run {{scope}}',
    projectDir: '/workspace/app',
    agentRuntime: 'codex',
    available: true,
    effectiveProjectDir: '/workspace/app',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateQuickActionParameterValues', () => {
  test('merges every supported typed default with transient secret input', () => {
    const result = validateQuickActionParameterValues(definitions, { token: 'top-secret' });

    expect(result).toEqual({
      valid: true,
      requestValues: {
        scope: 'src',
        retries: 3,
        strict: false,
        mode: 'safe',
        token: 'top-secret',
      },
      errors: {},
    });
  });

  test('accepts user values for string, number, boolean, select, and secret', () => {
    const result = validateQuickActionParameterValues(definitions, {
      scope: 'web',
      retries: 5,
      strict: true,
      mode: 'fast',
      token: 'ephemeral',
    });

    expect(result.valid).toBe(true);
    expect(result.requestValues).toEqual({
      scope: 'web',
      retries: 5,
      strict: true,
      mode: 'fast',
      token: 'ephemeral',
    });
  });

  test.each([
    ['string', [{ key: 'value', label: 'Value', type: 'string', required: true }], 1],
    ['number', [{ key: 'value', label: 'Value', type: 'number', required: true }], '1'],
    ['boolean', [{ key: 'value', label: 'Value', type: 'boolean', required: true }], 'true'],
    [
      'select',
      [{ key: 'value', label: 'Value', type: 'select', required: true, options: ['one'] }],
      'two',
    ],
    ['secret', [{ key: 'value', label: 'Value', type: 'secret', required: true }], 123],
  ] as const)('rejects an invalid %s value without echoing it', (_type, testedDefinitions, value) => {
    const result = validateQuickActionParameterValues(
      testedDefinitions as readonly QuickActionParameterDefinition[],
      { value },
    );

    expect(result.valid).toBe(false);
    expect(result.requestValues).toEqual({});
    expect(result.errors.value).not.toContain(String(value));
  });

  test('reports required and unknown keys without accepting either value', () => {
    const result = validateQuickActionParameterValues(
      [{ key: 'required', label: 'Required', type: 'string', required: true }],
      { unexpected: 'private-value' },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual({
      unexpected: 'Unknown quick action parameter: unexpected',
      required: 'Required is required',
    });
    expect(JSON.stringify(result.errors)).not.toContain('private-value');
  });

  test('treats blank required string and secret inputs as missing', () => {
    const result = validateQuickActionParameterValues(
      [
        { key: 'scope', label: 'Scope', type: 'string', required: true },
        { key: 'token', label: 'Token', type: 'secret', required: true },
      ],
      { scope: '   ', token: '' },
    );

    expect(result.valid).toBe(false);
    expect(result.requestValues).toEqual({});
    expect(result.errors).toEqual({ scope: 'Scope is required', token: 'Token is required' });
  });
});

describe('buildQuickActionFormModel', () => {
  test('keeps secret values out of form state and marks prompt projectDir required', () => {
    const model = buildQuickActionFormModel(promptAction(), { token: 'never-store-me' });

    expect(model.projectDir).toMatchObject({
      value: '/workspace/app',
      effectiveValue: '/workspace/app',
      required: true,
    });
    expect(model.parameterValues).toEqual({
      scope: 'src',
      retries: 3,
      strict: false,
      mode: 'safe',
    });
    expect(model.fields.find((field) => field.definition.key === 'token')).not.toHaveProperty('value');
    expect(JSON.stringify(model)).not.toContain('never-store-me');
    expect(model.canRun).toBe(true);
  });

  test('blocks a prompt with a missing required projectDir', () => {
    const model = buildQuickActionFormModel(promptAction({ projectDir: '' }), {
      token: 'transient',
    });

    expect(model.projectDir).toMatchObject({
      value: '',
      required: true,
      error: 'Project directory is required',
    });
    expect(model.canRun).toBe(false);
  });

  test('expresses an unavailable Script reference and effective projectDir', () => {
    const action: QuickActionView = {
      id: 'script-action',
      icon: '🧪',
      type: 'script',
      name: 'Script action',
      description: '',
      enabled: true,
      pinned: false,
      order: 0,
      parameterDefinitions: [],
      scriptId: 'removed-script',
      available: false,
      unavailableReason: 'Referenced script not found: removed-script',
      effectiveProjectDir: '/workspace/from-script',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };

    const model = buildQuickActionFormModel(action);

    expect(model.scriptReference).toEqual({
      scriptId: 'removed-script',
      status: 'unavailable',
      unavailableReason: 'Referenced script not found: removed-script',
    });
    expect(model.projectDir).toEqual({
      value: '',
      effectiveValue: '/workspace/from-script',
      required: false,
    });
    expect(model.canRun).toBe(false);
  });
});

test('redactQuickActionSecretValues removes every occurrence without changing public text', () => {
  const message = redactQuickActionSecretValues(
    'token abc failed; abc was rejected',
    definitions,
    { token: 'abc' },
  );

  expect(message).toBe('token [REDACTED] failed; [REDACTED] was rejected');
});
