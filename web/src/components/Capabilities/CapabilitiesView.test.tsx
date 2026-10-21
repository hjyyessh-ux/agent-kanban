import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilitiesView, type CapabilitiesViewProps } from './CapabilitiesView';

const noop = async () => {};

function render(overrides: Partial<CapabilitiesViewProps>): string {
  const props: CapabilitiesViewProps = {
    skills: [],
    skillsLoading: false,
    skillsSyncing: false,
    onSyncSkills: async () => null,
    onRefreshSkills: noop,
    scripts: [],
    scriptsLoading: false,
    onUpdateScript: noop,
    onDeleteScript: noop,
    onRunScript: noop,
    onRefreshScripts: noop,
    onSyncScripts: async () => ({ created: 0, updated: 0, removed: 0, total: 0 }),
    skillRoots: [],
    skillRootsLoading: false,
    onAddRoot: async (input) => ({ id: 'root-1', ...input }),
    onUpdateRoot: noop,
    onRemoveRoot: noop,
    onRefreshRoots: noop,
    ...overrides,
  };
  return renderToStaticMarkup(<CapabilitiesView {...props} />);
}

describe('CapabilitiesView errors', () => {
  test('a failed sync shows an alert instead of only an empty list', () => {
    const html = render({
      skillsError: 'Failed to sync skills',
      onClearSkillsError: () => {},
      scriptsError: 'Failed to fetch scripts',
    });
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    expect(html).toContain('Failed to sync skills');
    expect(html).toContain('Failed to fetch scripts');
    expect(html).toContain('다시 시도');
  });

  test('no errors → no alert', () => {
    expect(render({})).not.toContain('role="alert"');
  });
});
