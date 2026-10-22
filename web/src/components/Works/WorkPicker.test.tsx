import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { filterWorkPickerOptions, WorkPicker, workPickerActiveAfterQuery, workPickerRows } from './WorkPicker';
import { WORK_PICKER_COPY } from '../../constants/copy';
import type { Work } from '../../../../src/core/types';

function workFixture(id: string, title: string): Work {
  return {
    id,
    title,
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-04-17T00:00:00.000Z',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };
}

const works = [workFixture('W1', 'Board polish'), workFixture('W2', 'Telegram poller'), workFixture('W3', 'board DnD')];

describe('filterWorkPickerOptions', () => {
  test('an empty or blank query keeps every Work in order', () => {
    expect(filterWorkPickerOptions(works, '').map((work) => work.id)).toEqual(['W1', 'W2', 'W3']);
    expect(filterWorkPickerOptions(works, '   ').map((work) => work.id)).toEqual(['W1', 'W2', 'W3']);
  });

  test('matches titles case-insensitively, trimming the query', () => {
    expect(filterWorkPickerOptions(works, ' BOARD ').map((work) => work.id)).toEqual(['W1', 'W3']);
    expect(filterWorkPickerOptions(works, 'poll').map((work) => work.id)).toEqual(['W2']);
    expect(filterWorkPickerOptions(works, 'nope')).toEqual([]);
  });
});

describe('workPickerRows', () => {
  test('새 Work 만들기 leads, then Work 없음, then the Works', () => {
    expect(workPickerRows(works, true)).toEqual(['__new', '', 'W1', 'W2', 'W3']);
  });

  test('without a create handler there is no 새 Work row', () => {
    expect(workPickerRows(works.slice(0, 1), false)).toEqual(['', 'W1']);
  });
});

describe('workPickerActiveAfterQuery', () => {
  test('empty search rests on Work 없음', () => {
    expect(workPickerActiveAfterQuery(works, '', true)).toBe(1);
    expect(workPickerActiveAfterQuery(works, '  ', false)).toBe(0);
  });

  test('a matching search lands on the first match — Enter assigns it', () => {
    expect(workPickerActiveAfterQuery(works, 'board', true)).toBe(2);
    expect(workPickerActiveAfterQuery(works, 'board', false)).toBe(1);
  });

  test('no match lands on 새 Work 만들기 — Enter creates a Work by that name', () => {
    expect(workPickerActiveAfterQuery(works, 'Brand new', true)).toBe(0);
    // Nothing to create with: stay on Work 없음.
    expect(workPickerActiveAfterQuery(works, 'Brand new', false)).toBe(0);
  });
});

describe('WorkPicker trigger', () => {
  test('no Work: shows Work 없음, no 예약 badge', () => {
    const html = renderToStaticMarkup(<WorkPicker value="" works={works} planned onChange={() => undefined} />);
    expect(html).toContain('kv2-work-picker-trigger kv2-work-picker-trigger--pill is-planned');
    expect(html).toContain(`<span class="kv2-work-picker-label">${WORK_PICKER_COPY.none}</span>`);
    expect(html).not.toContain('kv2-work-picker-state');
  });

  test('a planned Work shows its title and the 예약 badge', () => {
    const html = renderToStaticMarkup(<WorkPicker value="W2" works={works} planned variant="input" onChange={() => undefined} />);
    expect(html).toContain('kv2-work-picker-trigger--input is-set is-planned');
    expect(html).toContain('<span class="kv2-work-picker-label">Telegram poller</span>');
    expect(html).toContain(`<span class="kv2-work-picker-state">${WORK_PICKER_COPY.planned}</span>`);
  });

  test('a Work missing from the list falls back to fallbackTitle; disabled stays disabled', () => {
    const html = renderToStaticMarkup(
      <WorkPicker value="W9" works={works} fallbackTitle="Closed work" variant="line" disabled onChange={() => undefined} />,
    );
    expect(html).toContain('<span class="kv2-work-picker-label">Closed work</span>');
    expect(html).toMatch(/<button type="button" class="kv2-work-picker-trigger kv2-work-picker-trigger--line is-set" disabled=""/);
  });
});
