import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardFilterBar } from './BoardFilterBar';
import { DEFAULT_BOARD_FILTERS } from './board-filters';
import { TOOLBAR_COPY } from '../../constants/copy';

const props = {
  cards: [],
  filters: DEFAULT_BOARD_FILTERS,
  onFiltersChange: mock(() => undefined),
  onFiltersReset: mock(() => undefined),
};

describe('BoardFilterBar WORK filter', () => {
  test('a chosen Work counts as an active filter on the trigger', () => {
    const html = renderToStaticMarkup(
      <BoardFilterBar {...props} workFilter={{ works: [], value: 'unassigned', onChange: mock(() => undefined) }} />,
    );
    expect(html).toContain(`${TOOLBAR_COPY.filter} (1)`);
    expect(html).toContain('kv2-filter-trigger is-active');
  });

  test('All, or no WORK section at all, adds nothing', () => {
    const all = renderToStaticMarkup(
      <BoardFilterBar {...props} workFilter={{ works: [], value: 'all', onChange: mock(() => undefined) }} />,
    );
    const none = renderToStaticMarkup(<BoardFilterBar {...props} />);
    expect(all).not.toContain(`${TOOLBAR_COPY.filter} (`);
    expect(none).not.toContain(`${TOOLBAR_COPY.filter} (`);
  });
});
