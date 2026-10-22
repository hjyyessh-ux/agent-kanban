import { describe, expect, test, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveWorkFieldChange, BoardCardWorkField } from './BoardCardWorkField';
import type { Work } from '../../../../src/core/types';

function workFixture(id: string, title: string, sessionIds: string[]): Work {
  return {
    id,
    title,
    status: 'active',
    sessionLinks: sessionIds.map((sessionId) => ({ sessionId, linkedAt: '2026-04-17T00:00:00.000Z' })),
    startedAt: '2026-04-17T00:00:00.000Z',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };
}

const baseCard = {
  id: 'card-1',
  status: 'todo' as const,
  title: 'Fix the thing',
  sessionTitle: undefined,
  projectDir: '/repo',
};

describe('resolveWorkFieldChange', () => {
  test('a sessionless card picking a Work reserves plannedWorkId', () => {
    const change = resolveWorkFieldChange({ ...baseCard, sessionId: undefined }, undefined, '', 'W1');
    expect(change).toEqual({ kind: 'setPlanned', cardId: 'card-1', workId: 'W1' });
  });

  test('a sessionless card clearing its reservation sets plannedWorkId to null', () => {
    const change = resolveWorkFieldChange({ ...baseCard, sessionId: undefined }, undefined, 'W1', '');
    expect(change).toEqual({ kind: 'setPlanned', cardId: 'card-1', workId: null });
  });

  test('re-selecting the current value is a no-op', () => {
    expect(resolveWorkFieldChange({ ...baseCard, sessionId: undefined }, undefined, 'W1', 'W1')).toBeNull();
    expect(resolveWorkFieldChange({ ...baseCard, sessionId: 'sess-1' }, undefined, '', '')).toBeNull();
  });

  test('a card with a session and no Work yet resolves to a link drop', () => {
    const change = resolveWorkFieldChange({ ...baseCard, sessionId: 'sess-1' }, undefined, '', 'W1');
    expect(change).toEqual({
      kind: 'drop',
      source: { cardId: 'card-1', sessionId: 'sess-1', workId: undefined, status: 'todo', projectDir: '/repo', title: 'Fix the thing' },
      target: { kind: 'work', workId: 'W1' },
    });
  });

  test('a card already linked, picking a different Work resolves to a move drop', () => {
    const linked = workFixture('W1', 'Current', ['sess-1']);
    const change = resolveWorkFieldChange({ ...baseCard, sessionId: 'sess-1' }, linked, 'W1', 'W2');
    expect(change).toEqual({
      kind: 'drop',
      source: { cardId: 'card-1', sessionId: 'sess-1', workId: 'W1', status: 'todo', projectDir: '/repo', title: 'Fix the thing' },
      target: { kind: 'work', workId: 'W2' },
    });
  });

  test('a card already linked, clearing it resolves to an unassigned drop', () => {
    const linked = workFixture('W1', 'Current', ['sess-1']);
    const change = resolveWorkFieldChange({ ...baseCard, sessionId: 'sess-1' }, linked, 'W1', '');
    expect(change).toEqual({
      kind: 'drop',
      source: { cardId: 'card-1', sessionId: 'sess-1', workId: 'W1', status: 'todo', projectDir: '/repo', title: 'Fix the thing' },
      target: { kind: 'unassigned' },
    });
  });
});

describe('BoardCardWorkField', () => {
  test('shows the empty label with no Work, planned, or linked state', () => {
    const html = renderToStaticMarkup(
      <BoardCardWorkField
        card={{ ...baseCard, sessionId: undefined, plannedWorkId: undefined }}
        works={[workFixture('W1', 'Some Work', [])]}
        linkedWork={undefined}
        onSetPlanned={mock(() => undefined)}
        onDrop={mock(() => undefined)}
      />,
    );
    expect(html).toContain('kv2-card-work-field');
    expect(html).not.toContain('is-set');
    expect(html).toContain('Work 없음');
  });

  test('marks a reservation with the planned suffix and the is-planned class', () => {
    const work = workFixture('W1', 'Reserved Work', []);
    const html = renderToStaticMarkup(
      <BoardCardWorkField
        card={{ ...baseCard, sessionId: undefined, plannedWorkId: 'W1' }}
        works={[work]}
        linkedWork={undefined}
        onSetPlanned={mock(() => undefined)}
        onDrop={mock(() => undefined)}
      />,
    );
    expect(html).toContain('kv2-card-work-field is-planned is-set');
    expect(html).toContain('<span class="kv2-work-picker-label">Reserved Work</span>');
    expect(html).toContain('<span class="kv2-work-picker-state">예약</span>');
  });

  test('shows a linked Work\'s plain title with no suffix', () => {
    const work = workFixture('W1', 'Linked Work', ['sess-1']);
    const html = renderToStaticMarkup(
      <BoardCardWorkField
        card={{ ...baseCard, sessionId: 'sess-1', plannedWorkId: undefined }}
        works={[work]}
        linkedWork={work}
        onSetPlanned={mock(() => undefined)}
        onDrop={mock(() => undefined)}
      />,
    );
    expect(html).toContain('kv2-card-work-field is-set');
    expect(html).not.toContain('is-planned');
    expect(html).toContain('<span class="kv2-work-picker-label">Linked Work</span>');
    expect(html).not.toContain('kv2-work-picker-state');
  });
});
