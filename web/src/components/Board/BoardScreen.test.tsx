import { describe, expect, test, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardScreen } from './BoardScreen';
import { BoardProjectSwitcher } from './BoardProjectSwitcher';
import type { KanbanCard } from '../../../../src/core/types';
import { DEFAULT_BOARD_FILTERS } from './board-filters';
import { sortCardsForColumn } from './board-utils';
import { groupCompleteCardsBySession } from './BoardCompleteSessionView';
import { CARD_ACTION_COPY, COLUMN_MENU_COPY, STATUS_LABELS } from '../../constants/copy';

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
    for (const label of Object.values(STATUS_LABELS)) expect(html).toContain(label);
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

  test('renders the project chip on row 1 and the runtime/time line under the divider', () => {
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

    expect(html).toContain('kv2-project-chip');
    expect(html).toContain('title="/Users/user/workspace/agent-kanban"');
    expect(html).not.toContain('kv2-card-directory');
    expect(html).not.toContain('Proj:');
    expect(html.indexOf('kv2-project-chip')).toBeLessThan(html.indexOf('Directory card'));
    expect(html.indexOf('Card description')).toBeLessThan(html.indexOf('kv2-card-divider'));
    expect(html.indexOf('kv2-card-divider')).toBeLessThan(html.indexOf('kv2-card-meta-row'));
    expect(html.indexOf('kv2-card-meta-row')).toBeLessThan(html.indexOf('Created 2026-04-15'));
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

    expect(html).not.toContain(COLUMN_MENU_COPY.doneAll);
    expect(html).not.toContain('Complete column actions');
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

    expect(html).not.toContain(COLUMN_MENU_COPY.archiveAll);
    expect(html).not.toContain('Done column actions');
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
    // Bulk actions live behind the header's ⋯ menu (its title lists them in order).
    expect(html).toContain(`aria-label="${STATUS_LABELS.complete} column actions"`);
    expect(html).toContain(`title="${COLUMN_MENU_COPY.hideAll} · ${COLUMN_MENU_COPY.doneAll}"`);
    expect(html).toContain(CARD_ACTION_COPY.done);
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
    expect(html).toContain(CARD_ACTION_COPY.archive);
    expect(html).not.toContain('Hidden prompt body');
    expect(html).not.toContain(CARD_ACTION_COPY.done);
  });

  test('session group header shows the project chip above the runtime badge', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'done-proj-1',
            title: 'Done prompt',
            status: 'done',
            sessionId: 'done-proj-session',
            projectDir: '/Users/user/workspace/mcp-server',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-complete-session-project');
    expect(html).toContain('title="/Users/user/workspace/mcp-server"');
    expect(html).not.toContain('Proj:');
    expect(html.indexOf('kv2-complete-session-project')).toBeLessThan(
      html.indexOf('kv2-complete-session-runtime-row'),
    );
  });

  test('shows Script instead of the legacy runtime in grouped done cards', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({
            id: 'done-script',
            title: 'Archived script run',
            status: 'done',
            agentRuntime: 'opencode',
            executionKind: 'script',
            scriptName: 'Deploy service',
          }),
        ]}
      />,
    );

    expect(html).toContain('>SCRIPT</span>');
    expect(html).toContain('Script execution · Deploy service');
    expect(html).not.toContain('OPENCODE');
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
  test('separates the latest turn from unread turns in a session group', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        groupCompleteSessions
        cards={[
          makeCard({
            id: 'latest-read',
            title: 'Latest read turn',
            status: 'complete',
            sessionId: 'session-latest',
            createdAt: '2026-04-17T12:00:00.000Z',
            completedAt: '2026-04-17T12:30:00.000Z',
            completedSeenAt: '2026-04-17T12:31:00.000Z',
          }),
          makeCard({
            id: 'older-unread',
            title: 'Older unread turn',
            status: 'complete',
            sessionId: 'session-latest',
            createdAt: '2026-04-17T11:00:00.000Z',
            completedAt: '2026-04-17T11:30:00.000Z',
          }),
        ]}
      />,
    );

    const latestStart = html.indexOf('kv2-complete-session-turn kv2-complete-session-turn--current"');
    const unreadStart = html.indexOf('kv2-complete-session-turn kv2-complete-session-turn--unread"');
    expect(latestStart).toBeGreaterThan(-1);
    expect(unreadStart).toBeGreaterThan(latestStart);
    // Latest is marked by text only; the NEW tag belongs to the unread turn.
    const latestTurn = html.slice(latestStart, unreadStart);
    expect(latestTurn).toContain('LATEST · ');
    expect(latestTurn).not.toContain('NEW');
    expect(html.slice(unreadStart)).toContain('kv2-complete-session-new-tag');
    expect(html).toContain('kv2-complete-session-group--unread');
    expect(html).toContain('1 unread');
  });

  test('a fully read session group carries no unread strip, pill, or tag', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        groupCompleteSessions
        cards={[
          makeCard({
            id: 'read-only',
            status: 'complete',
            sessionId: 'session-read',
            completedAt: '2026-04-17T12:30:00.000Z',
            completedSeenAt: '2026-04-17T12:31:00.000Z',
          }),
        ]}
      />,
    );

    expect(html).toContain('kv2-complete-session-turn--current');
    expect(html).not.toContain('kv2-complete-session-group--unread');
    expect(html).not.toContain('kv2-complete-session-unread');
    expect(html).not.toContain('kv2-complete-session-new-tag');
    expect(html).not.toContain('kv2-column-unread');
  });

  test('counts unread turns hidden behind Show N more', () => {
    const turns = Array.from({ length: 7 }, (_, index) => makeCard({
      id: `hidden-turn-${index}`,
      title: `Turn ${index}`,
      status: 'complete',
      sessionId: 'session-long',
      createdAt: `2026-04-17T0${index}:00:00.000Z`,
      completedAt: `2026-04-17T0${index}:30:00.000Z`,
      // Only the oldest turn (folded away) is unread.
      completedSeenAt: index === 0 ? undefined : `2026-04-17T0${index}:45:00.000Z`,
    }));
    const html = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupCompleteSessions cards={turns} />,
    );

    expect(html).toContain('Show 2 more · <span class="kv2-complete-session-more-unread">1 unread</span>');
    expect(html).not.toContain('kv2-complete-session-new-tag');
  });

  test('shows the complete column unread count in its header', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        cards={[
          makeCard({ id: 'u1', status: 'complete', completedAt: '2026-04-17T12:00:00.000Z' }),
          makeCard({ id: 'u2', status: 'complete', completedAt: '2026-04-17T12:00:00.000Z' }),
          makeCard({
            id: 'r1',
            status: 'complete',
            completedAt: '2026-04-17T12:00:00.000Z',
            completedSeenAt: '2026-04-17T12:05:00.000Z',
          }),
        ]}
      />,
    );

    // The pill is the column's "next unread" jump button.
    expect(html).toContain('class="kv2-column-unread kv2-column-unread--jump" aria-label="2 unread — jump to next"');
  });

  test('Unread only keeps unread completions and marks jump targets with data-card-id', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        unreadOnly
        cards={[
          makeCard({ id: 'todo-1', status: 'todo' }),
          makeCard({ id: 'u1', status: 'complete', completedAt: '2026-04-17T12:00:00.000Z' }),
          makeCard({
            id: 'r1',
            status: 'complete',
            completedAt: '2026-04-17T12:00:00.000Z',
            completedSeenAt: '2026-04-17T12:05:00.000Z',
          }),
        ]}
      />,
    );

    expect(html).toContain('data-card-id="u1"');
    expect(html).not.toContain('data-card-id="r1"');
    expect(html).not.toContain('data-card-id="todo-1"');
  });
});
