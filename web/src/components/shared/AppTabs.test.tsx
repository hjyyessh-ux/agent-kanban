import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppTabs } from './AppTabs';

describe('AppTabs badges', () => {
  test('names each tab badge by what it counts', () => {
    const html = renderToStaticMarkup(
      <AppTabs activeTab="board" onActivate={() => undefined} badges={{ board: 12, works: 3 }} />,
    );

    expect(html).toContain('class="app-tab-badge app-tab-badge--board" aria-label="12 unread"');
    expect(html).toContain('class="app-tab-badge app-tab-badge--works" aria-label="3 unassigned"');
  });

  test('renders no badge for a zero count', () => {
    const html = renderToStaticMarkup(
      <AppTabs activeTab="board" onActivate={() => undefined} badges={{ board: 0 }} />,
    );

    expect(html).not.toContain('app-tab-badge');
  });
});
