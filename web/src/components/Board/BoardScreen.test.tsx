import { describe, expect, test, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardScreen } from './BoardScreen';
import { BoardProjectSwitcher } from './BoardProjectSwitcher';
import type { KanbanCard } from '../../../../src/core/types';
import { DEFAULT_BOARD_FILTERS } from './board-filters';
import { sortCardsForColumn } from './board-utils';
import { groupCompleteCardsBySession } from './BoardCompleteSessionView';

let cardSeq = 1;

function makeCard(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    id: `card-${cardSeq++}`,
    title: 'Card title',
    description: 'Card description',
    status: 'todo',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
    ...overrides,
  };
}

const baseProps = {
  onCardClick: mock(() => undefined),
  onStatusChange: mock(() => undefined),
  onFavoriteToggle: mock(() => undefined),
  onDispatch: mock(() => undefined),
  onCreate: mock(() => undefined),
  onArchiveCards: mock(() => undefined),
  filters: DEFAULT_BOARD_FILTERS,
};

describe('BoardScreen', () => {
  test('defaults to board mode and renders board columns', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({ id: 'todo-1', status: 'todo' }),
          makeCard({ id: 'prog-1', status: 'in_progress' }),
          makeCard({ id: 'comp-1', status: 'complete' }),
          makeCard({ id: 'done-1', status: 'done' }),
        ]}
      />,
    );

    expect(html).toContain('kv2-board');
    expect(html).toContain('To Do');
    expect(html).toContain('In Progress');
    expect(html).toContain('Complete');
    expect(html).toContain('Done');
    expect(html).not.toContain('Board view mode');
  });

  test('renders list mode when viewMode=list and keeps section order', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        viewMode="list"
        cards={[
          makeCard({ id: 'todo-1', status: 'todo', title: 'Todo card' }),
          makeCard({ id: 'prog-1', status: 'in_progress', title: 'Progress card' }),
          makeCard({ id: 'comp-1', status: 'complete', title: 'Complete card' }),
          makeCard({ id: 'done-1', status: 'done', title: 'Done card' }),
        ]}
      />,
    );

    const doneIndex = html.indexOf('data-status="done"');
    const completeIndex = html.indexOf('data-status="complete"');
    const progressIndex = html.indexOf('data-status="in_progress"');
    const todoIndex = html.indexOf('data-status="todo"');

    expect(doneIndex).toBeGreaterThan(-1);
    expect(completeIndex).toBeGreaterThan(doneIndex);
    expect(progressIndex).toBeGreaterThan(completeIndex);
    expect(todoIndex).toBeGreaterThan(progressIndex);
    expect(html).toContain('Title');
    expect(html).toContain('Runtime');
    expect(html).toContain('Action');
    expect(html).toContain('Queue');
    expect(html).toContain('Created');
    expect(html).toContain('+ Add Task');
    expect(html).toContain('Card description');
    expect(html).not.toContain('#todo-1');
  });

  test('renders favorite toggles in board and list views', () => {
    const boardHtml = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[makeCard({ id: 'favorite-board', status: 'todo', favorite: true })]}
      />,
    );

    const listHtml = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        viewMode="list"
        cards={[makeCard({ id: 'favorite-list', status: 'todo', favorite: false })]}
      />,
    );

    expect(boardHtml).toContain('kv2-favorite-toggle--board');
    expect(boardHtml).toContain('aria-label="Unstar card"');
    expect(listHtml).toContain('kv2-favorite-toggle--list');
    expect(listHtml).toContain('aria-label="Star card"');
  });

  test('marks complete cards that have not been opened since completion', () => {
    const unreadCard = makeCard({
      id: 'unread-complete',
      status: 'complete',
      title: 'Unread complete',
      completedAt: '2026-04-17T12:00:00.000Z',
    });
    const readCard = makeCard({
      id: 'read-complete',
      status: 'complete',
      title: 'Read complete',
      completedAt: '2026-04-17T12:00:00.000Z',
      completedSeenAt: '2026-04-17T12:05:00.000Z',
    });

    const boardHtml = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[unreadCard, readCard]}
      />,
    );
    const listHtml = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        viewMode="list"
        cards={[unreadCard, readCard]}
      />,
    );

    expect(boardHtml).toContain('kv2-card-unread-dot');
    expect(listHtml).toContain('kv2-list-unread-dot');
    expect((boardHtml.match(/kv2-card-unread-dot/g) ?? [])).toHaveLength(1);
    expect((listHtml.match(/kv2-list-unread-dot/g) ?? [])).toHaveLength(1);
  });

  test('renders card directory badge between prompt and footer metadata', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'dir-card',
            title: 'Directory card',
            projectDir: '/Users/user/workspace/agent-kanban',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-card-directory');
    expect(html).toContain('Proj:');
    expect(html).toContain('agent-kanban');
    expect(html.indexOf('Card description')).toBeLessThan(html.indexOf('kv2-card-divider'));
    expect(html.indexOf('kv2-card-divider')).toBeLessThan(html.indexOf('kv2-card-directory'));
    expect(html.indexOf('kv2-card-directory')).toBeLessThan(html.indexOf('Created 2026-04-15'));
  });

  test('renders project switcher options with duplicate directory disambiguation', () => {
    const html = renderToStaticMarkup(
      <BoardProjectSwitcher
        cards={[
          makeCard({ id: 'workspace-a', projectDir: '/Users/user/workspace/agent-kanban' }),
          makeCard({ id: 'workspace-b', projectDir: '/Users/user/workspace/agent-kanban' }),
          makeCard({ id: 'archive-a', projectDir: '/Users/user/archive/agent-kanban' }),
        ]}
        selectedDirectory="/Users/user/workspace/agent-kanban"
        onDirectoryChange={mock(() => undefined)}
      />,
    );

    expect(html).toContain('All');
    expect(html).toContain('agent-kanban · workspace');
    expect(html).toContain('agent-kanban · archive');
    expect(html).toContain('aria-pressed="true"');
  });

  test('hides Done All when complete cards are all favorite', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({ id: 'fav-complete-1', status: 'complete', favorite: true }),
          makeCard({ id: 'fav-complete-2', status: 'complete', favorite: true }),
        ]}
      />,
    );

    expect(html).not.toContain('Done All');
  });

  test('hides Archive All when done cards are all favorite', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({ id: 'fav-done-1', status: 'done', favorite: true }),
          makeCard({ id: 'fav-done-2', status: 'done', favorite: true }),
        ]}
      />,
    );

    expect(html).not.toContain('Archive All');
  });

  test('sorts complete cards by newest updatedAt first', () => {
    const cards = [
      makeCard({ id: 'first', status: 'complete', updatedAt: '2026-04-17T10:00:00.000Z' }),
      makeCard({ id: 'second', status: 'complete', updatedAt: '2026-04-17T12:00:00.000Z' }),
      makeCard({ id: 'third', status: 'complete', updatedAt: '2026-04-17T14:00:00.000Z' }),
    ];

    expect(sortCardsForColumn('complete', cards).map((card) => card.id)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  test('sorts complete cards by newest responseAt before updatedAt', () => {
    const cards = [
      makeCard({
        id: 'updated-later',
        status: 'complete',
        responseAt: '2026-04-17T10:00:00.000Z',
        updatedAt: '2026-04-17T14:00:00.000Z',
      }),
      makeCard({
        id: 'responded-later',
        status: 'complete',
        responseAt: '2026-04-17T12:00:00.000Z',
        updatedAt: '2026-04-17T11:00:00.000Z',
      }),
    ];

    expect(sortCardsForColumn('complete', cards).map((card) => card.id)).toEqual([
      'responded-later',
      'updated-later',
    ]);
  });

  test('groups complete cards by session when session grouping is enabled', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        onCompleteAll={mock(() => undefined)}
        groupCompleteSessions
        cards={[
          makeCard({
            id: 'session-created-later',
            title: 'Created later prompt',
            description: 'Created newer prompt first line\ncreated newer hidden line',
            result: 'Created newer result first line\ncreated newer hidden line',
            status: 'complete',
            sessionId: 'session-a',
            sessionTitle: 'Shared session',
            createdAt: '2026-04-17T11:00:00.000Z',
            updatedAt: '2026-04-17T10:20:00.000Z',
          }),
          makeCard({
            id: 'session-updated-newer',
            title: 'Updated newer prompt',
            description: 'Updated newer prompt first line\nupdated newer hidden line',
            result: 'Updated newer result first line\nupdated newer hidden line',
            status: 'complete',
            sessionId: 'session-a',
            sessionTitle: 'Shared session',
            createdAt: '2026-04-17T10:00:00.000Z',
            updatedAt: '2026-04-17T12:00:00.000Z',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-complete-session-view');
    expect(html).toContain('Updated newer prompt');
    expect(html).not.toContain('Shared session');
    expect(html).toContain('Prompt');
    expect(html).toContain('Result');
    expect(html).toContain('Updated newer prompt first line');
    expect(html).toContain('Updated newer result first line');
    expect(html).toContain('Created newer prompt first line');
    expect(html).toContain('Created newer result first line');
    expect(html).not.toContain('updated newer hidden line');
    expect(html).not.toContain('created newer hidden line');
    expect(html).toContain('Session ID');
    expect(html).toContain('session-a');
    expect(html.indexOf('2. Updated newer prompt')).toBeLessThan(html.indexOf('1. Created later prompt'));
    expect(html.indexOf('2 cards')).toBeLessThan(html.indexOf('Updated newer prompt'));
    expect(html.indexOf('2 unread')).toBeLessThan(html.indexOf('Updated newer prompt'));
    expect(html).toContain('Hide All');
    expect(html.indexOf('Hide All')).toBeLessThan(html.indexOf('Done All'));
    expect(html).toContain('DONE');
  });

  test('orders grouped session turns by responseAt even when updatedAt changes later', () => {
    const groups = groupCompleteCardsBySession([
      makeCard({
        id: 'updated-later',
        title: 'Updated later',
        status: 'complete',
        sessionId: 'session-response-order',
        createdAt: '2026-04-17T10:00:00.000Z',
        responseAt: '2026-04-17T10:10:00.000Z',
        updatedAt: '2026-04-17T14:00:00.000Z',
      }),
      makeCard({
        id: 'responded-later',
        title: 'Responded later',
        status: 'complete',
        sessionId: 'session-response-order',
        createdAt: '2026-04-17T10:05:00.000Z',
        responseAt: '2026-04-17T10:20:00.000Z',
        updatedAt: '2026-04-17T11:00:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((card) => card.id)).toEqual([
      'responded-later',
      'updated-later',
    ]);
    expect(groups[0].lastUpdatedAt).toBe('2026-04-17T10:20:00.000Z');
  });

  test('renders complete session card updated metadata below the card surface', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        groupCompleteSessions
        cards={[
          makeCard({
            id: 'session-updated-meta',
            title: 'Updated meta prompt',
            status: 'complete',
            sessionId: 'session-updated-meta',
            sessionTitle: 'Updated metadata session',
            updatedAt: '2026-04-17T12:00:00.000Z',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-complete-session-turn-updated');
    expect(html).toContain('Updated 2026-04-17');
    expect(html).not.toContain('kv2-complete-session-card-meta');
    expect(html.indexOf('kv2-complete-session-turn-body')).toBeLessThan(
      html.indexOf('kv2-complete-session-turn-updated'),
    );
  });

  test('does not group complete cards by default', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'plain-complete',
            title: 'Plain complete',
            status: 'complete',
            sessionId: 'session-a',
          }),
        ]}
      />,
    );

    expect(html).not.toContain('kv2-complete-session-view');
    expect(html).toContain('kv2-card');
  });

  test('always groups done cards by session and keeps them collapsed by default', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'done-session-1',
            title: 'Done prompt one',
            description: 'Done prompt body',
            result: 'Done result body',
            status: 'done',
            sessionId: 'done-session',
            sessionTitle: 'Done session',
          }),
          makeCard({
            id: 'done-session-2',
            title: 'Done prompt two',
            description: 'Hidden prompt body',
            result: 'Hidden result body',
            status: 'done',
            sessionId: 'done-session',
            sessionTitle: 'Done session',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-complete-session-group--done');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Done prompt one');
    expect(html).not.toContain('Done session');
    expect(html).toContain('ARCHIVE');
    expect(html).not.toContain('Hidden prompt body');
    expect(html).not.toContain('DONE');
  });

  test('keeps cards without a session as separate complete session groups', () => {
    const groups = groupCompleteCardsBySession([
      makeCard({
        id: 'no-session-a',
        title: 'No session A',
        status: 'complete',
        createdAt: '2026-04-17T10:00:00.000Z',
        updatedAt: '2026-04-17T11:00:00.000Z',
      }),
      makeCard({
        id: 'no-session-b',
        title: 'No session B',
        status: 'complete',
        createdAt: '2026-04-17T10:05:00.000Z',
        updatedAt: '2026-04-17T11:05:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.cards)).toEqual([
      [expect.objectContaining({ id: 'no-session-b' })],
      [expect.objectContaining({ id: 'no-session-a' })],
    ]);
  });

  test('matches search against description, progressSummary, result, and session id', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({ id: 'desc-1', title: 'Alpha card', description: 'alpha token' }),
          makeCard({ id: 'progress-1', title: 'Beta card', progressSummary: 'beta progress' }),
          makeCard({ id: 'result-1', title: 'Gamma card', result: 'gamma result' }),
          makeCard({ id: 'session-1', title: 'Session card', sessionId: 'ses_lookup_target' }),
          makeCard({ id: 'miss-1', title: 'Totally different', description: 'zzz' }),
        ]}
        filters={{ ...DEFAULT_BOARD_FILTERS, search: 'lookup_target' }}
      />,
    );

    expect(html).toContain('Session card');
    expect(html).not.toContain('Gamma card');
    expect(html).not.toContain('Beta card');
    expect(html).not.toContain('Alpha card');
    expect(html).not.toContain('Totally different');
  });

  test('applies directory, session name, and session id filters together', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'match-1',
            title: 'Matched card',
            projectDir: '/workspace/opencode',
            sessionTitle: 'Planner Session',
            sessionId: 'ses_1234',
          }),
          makeCard({
            id: 'miss-dir',
            title: 'Wrong dir',
            projectDir: '/workspace/other',
            sessionTitle: 'Planner Session',
            sessionId: 'ses_1234',
          }),
        ]}
        filters={{
          ...DEFAULT_BOARD_FILTERS,
          directory: '/workspace/opencode',
          sessionName: 'planner',
          sessionId: '1234',
        }}
      />,
    );

    expect(html).toContain('Matched card');
    expect(html).not.toContain('Wrong dir');
  });

  test('applies created/updated date range filters', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'in-range',
            title: 'In range',
            createdAt: '2026-04-15T10:00:00.000Z',
            updatedAt: '2026-04-16T11:00:00.000Z',
          }),
          makeCard({
            id: 'out-range',
            title: 'Out range',
            createdAt: '2026-04-10T10:00:00.000Z',
            updatedAt: '2026-04-20T11:00:00.000Z',
          }),
        ]}
        filters={{
          ...DEFAULT_BOARD_FILTERS,
          createdFrom: '2026-04-14',
          createdTo: '2026-04-16',
          updatedFrom: '2026-04-15',
          updatedTo: '2026-04-17',
        }}
      />,
    );

    expect(html).toContain('In range');
    expect(html).not.toContain('Out range');
  });

  test('combines filters with AND logic and supports reset callback', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'and-match',
            title: 'Find me',
            description: 'target text',
            projectDir: '/root/a',
            sessionTitle: 'Main Session',
            sessionId: 'ses_target',
            createdAt: '2026-04-15T01:00:00.000Z',
            updatedAt: '2026-04-15T02:00:00.000Z',
          }),
          makeCard({
            id: 'and-miss',
            title: 'Find me too',
            description: 'target text',
            projectDir: '/root/b',
            sessionTitle: 'Main Session',
            sessionId: 'ses_target',
            createdAt: '2026-04-15T01:00:00.000Z',
            updatedAt: '2026-04-15T02:00:00.000Z',
          }),
        ]}
        filters={{
          search: 'target',
          directory: '/root/a',
          sessionName: 'main',
          sessionId: 'target',
          createdFrom: '2026-04-15',
          createdTo: '2026-04-15',
          updatedFrom: '2026-04-15',
          updatedTo: '2026-04-15',
        }}
      />,
    );

    expect(html).toContain('Find me');
    expect(html).not.toContain('Find me too');
  });

  test('does not render header-owned filter controls inside BoardScreen', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[makeCard({ id: 'todo-1', status: 'todo' })]}
      />,
    );

    expect(html).not.toContain('kv2-filter-trigger');
    expect(html).toContain('kv2-board');
  });
});
