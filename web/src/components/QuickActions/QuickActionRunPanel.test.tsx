import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuickActionView } from '../../../../src/core/types';
import {
  initialQuickActionRunValues,
  isProductionQuickAction,
  QuickActionRunPanel,
} from './QuickActionRunPanel';

type PromptQuickActionView = Extract<QuickActionView, { type: 'prompt' }>;

function promptAction(overrides: Partial<PromptQuickActionView> = {}): PromptQuickActionView {
  return {
    id: 'production-audit',
    icon: '🛡️',
    type: 'prompt',
    name: 'Production audit',
    description: 'Inspect production safely',
    enabled: true,
    pinned: false,
    order: 0,
    parameterDefinitions: [
      { key: 'days', label: 'Days', type: 'number', required: true },
      { key: 'scope', label: 'Scope', type: 'select', required: true, options: ['api', 'web'], defaultValue: 'api' },
      { key: 'token', label: 'Token', type: 'secret', required: true },
    ],
    cardTitleTemplate: 'Production audit',
    promptTemplate: 'Audit production.',
    projectDir: '/srv/production',
    agentRuntime: 'codex',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    available: true,
    effectiveProjectDir: '/srv/production',
    ...overrides,
  };
}

describe('QuickActionRunPanel', () => {
  test('renders typed required fields, keeps secrets out of defaults, and gates production runs', () => {
    const action = promptAction();
    const html = renderToStaticMarkup(
      <QuickActionRunPanel
        action={action}
        running={false}
        onRun={mock(async () => ({ cardId: 'card', status: 'in_progress' as const, dispatch: null }))}
        onBack={mock(() => undefined)}
        onCompleted={mock(() => undefined)}
        onError={mock(() => undefined)}
      />,
    );

    expect(initialQuickActionRunValues(action)).toEqual({ scope: 'api' });
    expect(html).toContain('Days *');
    expect(html).toContain('type="number"');
    expect(html).toContain('Scope *');
    expect(html).toContain('Token *');
    expect(html).toContain('type="password"');
    expect(html).toContain('I confirm this production or elevated-permission action.');
    expect(html).toContain('Run Action');
    expect(html).toContain('disabled=""');
    expect(isProductionQuickAction(action)).toBe(true);
  });
});
