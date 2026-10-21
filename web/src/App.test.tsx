import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import App from './App';
import { TOOLBAR_COPY } from './constants/copy';

describe('App header board view toggle', () => {
  test('does not render board/list toggle outside board tab on initial render assumptions are board-only gated', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Board');
    expect(html).toContain('Wiki');
    expect(html).toContain('Capabilities');
    expect(html).toContain('Scheduler');
    expect(html).toContain('Settings');
    expect(html).toContain('Board view mode');
    expect(html).toContain(TOOLBAR_COPY.groupLegend);
    expect(html).toContain(TOOLBAR_COPY.groupWorks);
    expect(html).toContain(TOOLBAR_COPY.filter);
    expect(html).toContain('kv2-board-workspace');
    expect(html).toContain('kv2-quick-actions-drawer--collapsed');
    expect(html).toContain('aria-label="Open Quick Actions"');
    expect(html).not.toContain('kv2-quick-actions-launcher');
    expect(html).not.toContain('app-main--with-quick-actions');
  });
});
