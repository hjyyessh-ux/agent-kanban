import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import App from './App';

describe('App header board view toggle', () => {
  test('does not render board/list toggle outside board tab on initial render assumptions are board-only gated', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Board');
    expect(html).toContain('Wiki');
    expect(html).toContain('Capabilities');
    expect(html).toContain('Scheduler');
    expect(html).toContain('Settings');
    expect(html).toContain('Board view mode');
    expect(html).toContain('Session 모아보기');
    expect(html).toContain('Filter');
  });
});
