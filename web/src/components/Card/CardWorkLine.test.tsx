import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardWorkLine, resolveCardWorkLine } from './CardWorkLine';
import type { Work } from '../../../../src/core/types';

function workFixture(id: string, title: string, sessionIds: string[], status: Work['status'] = 'active'): Work {
  return {
    id,
    title,
    status,
    sessionLinks: sessionIds.map((sessionId) => ({ sessionId, linkedAt: '2026-04-17T00:00:00.000Z' })),
    startedAt: '2026-04-17T00:00:00.000Z',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };
}

const works = [workFixture('W1', 'Board polish', ['s1']), workFixture('W2', 'Old work', ['s2'], 'done')];

describe('resolveCardWorkLine', () => {
  test('todo, no session, editable: the reservation is editable', () => {
    expect(resolveCardWorkLine({ id: 'c', plannedWorkId: 'W1' }, works, true, true))
      .toEqual({ kind: 'planned-editable', value: 'W1' });
    expect(resolveCardWorkLine({ id: 'c' }, works, true, true))
      .toEqual({ kind: 'planned-editable', value: '' });
  });

  test('todo but not editable: read-only none', () => {
    expect(resolveCardWorkLine({ id: 'c', plannedWorkId: 'W1' }, works, true, false)).toEqual({ kind: 'none' });
  });

  test('with a session the line follows the session link, even on a closed Work', () => {
    expect(resolveCardWorkLine({ id: 'c', sessionId: 's1' }, works, false, true)).toEqual({ kind: 'linked', work: works[0] });
    expect(resolveCardWorkLine({ id: 'c', sessionId: 's2' }, works, true, true)).toEqual({ kind: 'linked', work: works[1] });
    expect(resolveCardWorkLine({ id: 'c', sessionId: 's9', plannedWorkId: 'W1' }, works, true, true)).toEqual({ kind: 'none' });
  });
});

describe('CardWorkLine', () => {
  test('a linked closed Work renders read-only with its title', () => {
    const html = renderToStaticMarkup(<CardWorkLine card={{ id: 'c', sessionId: 's2' }} works={works} isTodo={false} canEdit />);
    expect(html).toContain('class="kv2-detail-work-line"');
    expect(html).toContain('<span class="kv2-work-picker-label">Old work</span>');
    expect(html).toContain('disabled=""');
  });

  test('a reservation renders an enabled planned picker', () => {
    const html = renderToStaticMarkup(<CardWorkLine card={{ id: 'c', plannedWorkId: 'W1' }} works={works} isTodo canEdit />);
    expect(html).toContain('kv2-work-picker-trigger--line is-set is-planned');
    expect(html).not.toContain('disabled=""');
  });
});

describe('CardWorkLine reservation on a closed Work', () => {
  test('shows the closed Work title, not its raw id', () => {
    const html = renderToStaticMarkup(<CardWorkLine card={{ id: 'c', plannedWorkId: 'W2' }} works={works} isTodo canEdit />);
    expect(html).toContain('<span class="kv2-work-picker-label">Old work</span>');
    expect(html).not.toContain('>W2<');
  });
});
