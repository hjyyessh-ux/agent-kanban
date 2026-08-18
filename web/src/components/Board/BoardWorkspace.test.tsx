import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardWorkspace } from './BoardWorkspace';

describe('BoardWorkspace', () => {
  test('keeps the launcher before Board content without changing modal state', () => {
    const html = renderToStaticMarkup(
      <BoardWorkspace
        leadingPanel={<aside>Quick Actions rail</aside>}
        leadingPanelExpanded={false}
      >
        <div className="kv2-board">Board content</div>
      </BoardWorkspace>,
    );

    expect(html).toContain('data-quick-actions-expanded="false"');
    expect(html.indexOf('Quick Actions rail')).toBeLessThan(html.indexOf('Board content'));
    expect(html).not.toContain('kv2-board-workspace--quick-actions-open');
    expect(html).not.toContain('inert=""');
  });

  test('marks shared Board/List content inert while the modal side sheet is open', () => {
    const html = renderToStaticMarkup(
      <BoardWorkspace
        leadingPanel={<aside>Quick Actions panel</aside>}
        leadingPanelExpanded
      >
        <div className="kv2-board-list">List content</div>
      </BoardWorkspace>,
    );

    expect(html).toContain('kv2-board-workspace--quick-actions-open');
    expect(html).toContain('data-quick-actions-expanded="true"');
    expect(html).toContain('class="kv2-board-workspace-content" inert="" aria-hidden="true"');
    expect(html.indexOf('Quick Actions panel')).toBeLessThan(html.indexOf('List content'));
  });
});
