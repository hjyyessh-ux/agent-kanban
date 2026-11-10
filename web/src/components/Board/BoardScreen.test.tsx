import { describe, expect, test, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardScreen } from './BoardScreen';
import { BoardProjectSwitcher } from './BoardProjectSwitcher';
import type { KanbanCard, Work } from '../../../../src/core/types';
import { DEFAULT_BOARD_FILTERS } from './board-filters';
import { sortCardsForColumn } from './board-utils';
import { groupCompleteCardsBySession } from './BoardCompleteSessionView';
import { BOARD_GROUP_COPY, BOARD_SESSION_COPY, BOARD_WORKS_COPY, CARD_ACTION_COPY, COLUMN_MENU_COPY, LIST_COPY, STATUS_LABELS, WORK_PICKER_COPY } from '../../constants/copy';

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

    // Needs-me first; the done pile last and folded by default.
    expect(completeIndex).toBeGreaterThan(-1);
    expect(progressIndex).toBeGreaterThan(completeIndex);
    expect(todoIndex).toBeGreaterThan(progressIndex);
    expect(doneIndex).toBeGreaterThan(todoIndex);
    expect(html).toMatch(/class="kv2-list-section is-collapsed" data-status="done"/);
    expect(html).toContain(LIST_COPY.hidden(1));
    // One column head for the whole list, not one per section.
    expect(html.match(/class="kv2-list-table-head"/g)).toHaveLength(1);
    expect(html).toContain(LIST_COPY.colTitle);
    expect(html).toContain(LIST_COPY.colMeta);
    expect(html).toContain(LIST_COPY.addTask);
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
    // Option C: the project chip leads the meta line under the divider.
    expect(html.indexOf('Card description')).toBeLessThan(html.indexOf('kv2-card-divider'));
    expect(html.indexOf('kv2-card-divider')).toBeLessThan(html.indexOf('kv2-card-meta-row'));
    expect(html.indexOf('kv2-card-meta-row')).toBeLessThan(html.indexOf('kv2-project-chip'));
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
        groupMode="session"
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
    // Turns read like comments: the prompt's first line, then `↳` its result's.
    expect(html).toContain('<span class="kv2-complete-session-card-title">Updated newer prompt first line</span>');
    expect(html).toContain('<p class="kv2-complete-session-turn-result">Updated newer result first line</p>');
    expect(html).toContain('Updated newer result first line');
    expect(html).toContain('Created newer prompt first line');
    expect(html).toContain('Created newer result first line');
    expect(html).not.toContain('updated newer hidden line');
    expect(html).not.toContain('created newer hidden line');
    // The session id chip copies the resume command (no separate resume button).
    expect(html).toContain('aria-label="Session session-a resume 명령 복사"');
    expect(html).not.toContain('kv2-resume-copy');
    expect(html.indexOf('aria-label="2. Updated newer prompt')).toBeLessThan(html.indexOf('aria-label="1. Created later prompt'));
    // A′ anatomy: ① project · runtime ··· #id ★ ● N, ② title, ③ `N턴 · … · 마지막 …`.
    expect(html.indexOf('Updated newer prompt')).toBeLessThan(html.indexOf(BOARD_SESSION_COPY.turnCount(2)));
    expect(html.indexOf('2 unread')).toBeLessThan(html.indexOf('Updated newer prompt'));
    // Bulk actions live behind the header's ⋯ menu (its title lists them in order).
    expect(html).toContain(`aria-label="${STATUS_LABELS.complete} column actions"`);
    expect(html).toContain(`title="${COLUMN_MENU_COPY.turnOrderOldest} · ${COLUMN_MENU_COPY.hideAll} · ${COLUMN_MENU_COPY.doneAll}"`);
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

  test('session meta line: turn count · run time · last run, exact stamps in the tooltip', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        groupMode="session"
        cards={[
          makeCard({
            id: 'session-updated-meta',
            title: 'Updated meta prompt',
            status: 'complete',
            sessionId: 'session-updated-meta',
            sessionTitle: 'Updated metadata session',
            startedAt: '2026-04-17T11:00:00.000Z',
            completedAt: '2026-04-17T11:01:30.000Z',
            durationMs: 90_000,
            updatedAt: '2026-04-17T12:00:00.000Z',
          }),
        ]}
      />,
    );

    const meta = html.slice(html.indexOf('kv2-complete-session-meta-row'));
    expect(meta).toContain(`<span class="kv2-complete-session-count">${BOARD_SESSION_COPY.turnCount(1)}</span>`);
    expect(meta).toContain('<span class="kv2-complete-session-duration">1m 30s</span>');
    expect(meta).toContain('kv2-complete-session-last');
    expect(html).toMatch(/kv2-complete-session-meta-row" title="마지막 수행 2026-04-17 \d\d:\d\d/);
    // The old per-turn `Updated …` line is gone.
    expect(html).not.toContain('kv2-complete-session-turn-updated');
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
    expect(html).toContain(BOARD_SESSION_COPY.unfold);
    expect(html).toContain('Done prompt one');
    expect(html).not.toContain('Done session');
    expect(html).toContain(CARD_ACTION_COPY.archive);
    // Folded: only the newest turn, in the same two-line turn shape (`n 질문` / `↳ 답`).
    expect(html.match(/class="kv2-complete-session-turn[ "]/g)).toHaveLength(1);
    expect(html).toContain('<span class="kv2-complete-session-card-title">Hidden prompt body</span>');
    expect(html).toContain('<p class="kv2-complete-session-turn-result">Hidden result body</p>');
    expect(html).not.toContain('kv2-complete-session-folded-summary');
    expect(html).not.toContain('Done prompt body');
    expect(html).not.toContain(CARD_ACTION_COPY.done);
  });

  test('session group header: project · runtime ··· #id⏎ in row ①, title + fold, meta line; no resume button', () => {
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
    // No Work field wired here → project · runtime hold row ①'s left slot.
    const top = html.slice(html.indexOf('kv2-complete-session-top'), html.indexOf('kv2-complete-session-title-row'));
    expect(top).toContain('kv2-complete-session-project');
    expect(top).toContain('kv2-runtime-badge');
    // The session id is always visible on row ①, and its click copies the resume command.
    expect(top).toContain('<span class="kv2-complete-session-id"><button type="button" class="kv2-id-chip kv2-id-chip--resume"');
    expect(top).toContain('>#done-pro</span>');
    expect(top).toContain("&amp;&amp; opencode session &#x27;done-proj-session&#x27;");
    expect(html).not.toContain('kv2-hover-reveal kv2-complete-session-id');
    const titleRow = html.slice(html.indexOf('kv2-complete-session-title-row'), html.indexOf('kv2-complete-session-meta-row'));
    expect(titleRow).toContain('class="kv2-complete-session-toggle"');
    const meta = html.slice(html.indexOf('kv2-complete-session-meta-row'), html.indexOf('kv2-complete-session-timeline'));
    expect(meta).toContain(`>${BOARD_SESSION_COPY.turnCount(1)}<`);
    expect(meta).not.toContain('kv2-id-chip');
    expect(html).not.toContain('kv2-resume-copy');
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
        groupMode="session"
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
    // Latest is position (top of the list); unread is the filled node, named in the turn's label.
    const latestTurn = html.slice(latestStart, unreadStart);
    expect(latestTurn).not.toContain(BOARD_SESSION_COPY.unreadTurn);
    expect(html.slice(unreadStart)).toContain(`title="${BOARD_SESSION_COPY.unreadTurn}"`);
    expect(html).not.toContain('kv2-complete-session-new-tag');
    expect(html).toContain('kv2-complete-session-group--unread');
    expect(html).toContain('1 unread');
  });

  test('a fully read session group carries no unread strip, pill, or tag', () => {
    const html = renderToStaticMarkup(
      <BoardScreen
        {...baseProps}
        groupMode="session"
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

  test('works mode before the Works load groups the complete column like session mode, each group under a SESSION tab', () => {
    const cards = [
      makeCard({ id: 'w-1', status: 'complete', sessionId: 'session-w', completedAt: '2026-04-17T12:30:00.000Z' }),
      makeCard({ id: 'w-2', status: 'complete', sessionId: 'session-w', completedAt: '2026-04-17T13:30:00.000Z' }),
    ];
    const works = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="works" cards={cards} />);
    const session = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="session" cards={cards} />);
    const flat = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="card" cards={cards} />);

    expect(works).toBe(session);
    expect(works).toContain('kv2-complete-session-group kv2-complete-session-group--complete');
    expect(works).toContain(`<span class="kv2-session-tab" aria-hidden="true">${BOARD_GROUP_COPY.sessionTab}</span>`);
    expect(flat).not.toContain('kv2-complete-session-group--complete');
  });

  test('works mode draws the UNASSIGNED divider and loose session groups first, then Work containers', () => {
    const works = [workFixture('W1', 'Board polish', ['session-a', 'session-b'])];
    const cards = [
      makeCard({ id: 'a-1', title: 'Turn A', status: 'complete', sessionId: 'session-a', completedAt: '2026-04-17T12:00:00.000Z' }),
      makeCard({ id: 'b-1', title: 'Turn B', status: 'complete', sessionId: 'session-b', completedAt: '2026-04-17T13:00:00.000Z' }),
      makeCard({ id: 'loose-1', title: 'Loose turn', status: 'complete', sessionId: 'session-z', completedAt: '2026-04-17T14:00:00.000Z' }),
      makeCard({ id: 'done-1', title: 'Done turn', status: 'done', sessionId: 'session-d' }),
    ];
    const html = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="works" works={works} cards={cards} />);

    const complete = html.slice(html.indexOf('kv2-column" data-status="complete"'), html.indexOf('kv2-column" data-status="done"'));
    expect(complete).toContain('class="kv2-work" data-work-id="W1" data-work-status="complete"');
    expect(complete).toContain(`<span class="kv2-column-work-count">${BOARD_WORKS_COPY.columnWorkCount(1)}</span>`);
    const workAt = complete.indexOf('data-work-id="W1"');
    const dividerAt = complete.indexOf(BOARD_WORKS_COPY.unassignedHeading);
    const looseAt = complete.indexOf('Loose turn');
    expect(dividerAt).toBeGreaterThan(-1);
    expect(looseAt).toBeGreaterThan(dividerAt);
    expect(workAt).toBeGreaterThan(looseAt);
    expect(complete).toContain('<span class="kv2-works-unassigned-count">1</span>');
    // Both Work sessions sit inside the container, below the unassigned zone.
    expect(complete.indexOf('Turn A')).toBeGreaterThan(workAt);
    expect(complete.indexOf('Turn B')).toBeGreaterThan(workAt);

    const done = html.slice(html.indexOf('kv2-column" data-status="done"'));
    expect(done).not.toContain('kv2-column-work-count');
    expect(done).toContain('Done turn');
    expect(done).toContain('<span class="kv2-works-unassigned-count">1</span>');
  });

  test('works mode hides the UNASSIGNED zone when every session has a Work — the Works move up', () => {
    const works = [workFixture('W1', 'Board polish', ['session-a'])];
    const cards = [makeCard({ id: 'a-1', status: 'complete', sessionId: 'session-a' })];
    const html = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="works" works={works} cards={cards} />);
    const complete = html.slice(html.indexOf('kv2-column" data-status="complete"'), html.indexOf('kv2-column" data-status="done"'));
    expect(complete).not.toContain(BOARD_WORKS_COPY.unassignedHeading);
    expect(complete).toContain('data-work-id="W1"');
    // A works-mode column with nothing at all reads like any other empty column.
    const done = html.slice(html.indexOf('kv2-column" data-status="done"'));
    expect(done).not.toContain(BOARD_WORKS_COPY.unassignedHeading);
    expect(done).toContain('<div class="kv2-empty">No cards</div>');
  });

  test('works mode tags todo / in-progress cards with their Work via BoardCardWorkField', () => {
    const works = [workFixture('W1', 'Board polish', ['session-a'])];
    const cards = [
      makeCard({ id: 'todo-in', status: 'todo', sessionId: 'session-a' }),
      makeCard({ id: 'prog-out', status: 'in_progress', sessionId: 'session-x' }),
    ];
    const html = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupMode="works" works={works} onWorkOpen={mock(() => undefined)} cards={cards} />,
    );
    expect(html).toContain('data-card-id="todo-in" data-work-id="W1" data-work-status="todo"');
    expect(html).toContain('kv2-card-work-field is-set');
    expect(html).toContain('<span class="kv2-work-picker-label">Board polish</span>');
    expect(html).toContain(`<span class="kv2-work-picker-label">${WORK_PICKER_COPY.add}</span>`);

    // `BoardCardWorkField` is not gated to `GROUP: WORKS` — every mode shows it once Works have loaded.
    const session = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="session" works={works} cards={cards} />);
    expect(session).toContain('kv2-card-work-field');
    expect(session).not.toContain('kv2-work"');
  });

  test('with workMutations, session headers and flat cards become drag sources and session groups get the Work field', () => {
    const works = [workFixture('W1', 'Board polish', ['session-a'])];
    const cards = [
      makeCard({ id: 'a-1', title: 'Turn A', status: 'complete', sessionId: 'session-a' }),
      makeCard({ id: 'b-1', title: 'Turn B', status: 'complete', sessionId: 'session-b' }),
      makeCard({ id: 'prog-1', title: 'Running', status: 'in_progress', sessionId: 'session-p' }),
    ];
    const mutations = {
      link: mock(async () => works[0]),
      move: mock(async () => ({ from: null, to: works[0] })),
      unlink: mock(async () => works[0]),
      createWithSession: mock(async () => works[0]),
      moveToNewWork: mock(async () => ({ from: null, to: works[0] })),
      deleteWork: mock(async () => {}),
      createWork: mock(async () => works[0]),
      notify: mock(() => undefined),
    };
    const html = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupMode="works" works={works} workMutations={mutations} cards={cards} />,
    );
    expect(html).toMatch(/class="kv2-complete-session-header"[^>]*draggable="true"/);
    // An unassigned session group carries the same Work field as a card, in row ①…
    const unassigned = html.slice(html.indexOf('data-session-group-key="session:session-b"'));
    const unassignedTop = unassigned.slice(unassigned.indexOf('kv2-complete-session-top'), unassigned.indexOf('kv2-complete-session-title-row'));
    expect(unassignedTop).toContain('kv2-complete-session-work-row');
    // …and project · runtime move down to lead the meta line.
    const unassignedMeta = unassigned.slice(unassigned.indexOf('kv2-complete-session-meta-row'), unassigned.indexOf('kv2-complete-session-count'));
    expect(unassignedMeta).toContain('kv2-complete-session-meta-chips');
    // …but inside a Work it is dropped — the container already names the Work —
    // and project · runtime take row ①'s slot so it is not left empty.
    const inWork = html.slice(html.indexOf('data-work-id="W1"'), html.indexOf('</section>'));
    expect(inWork).not.toContain('kv2-complete-session-work-row');
    expect(inWork).not.toContain('kv2-complete-session-meta-chips');
    const inWorkTop = inWork.slice(inWork.indexOf('kv2-complete-session-top'), inWork.indexOf('kv2-complete-session-title-row'));
    expect(inWorkTop).toContain('kv2-runtime-badge');
    expect(html).not.toContain('kv2-work-move-menu');
    expect(html).toMatch(/class="kv2-card[^"]*" data-id="prog-1" draggable="true"/);

    const without = renderToStaticMarkup(<BoardScreen {...baseProps} groupMode="works" works={works} cards={cards} />);
    // No mutations → no session-group Work field (nothing could run the change).
    expect(without).not.toContain('kv2-complete-session-work-row');
    expect(without).toMatch(/class="kv2-card[^"]*" data-id="prog-1" draggable="false"/);
  });

  test('the list view follows GROUP: works → Work row ▸ session row, sessions folded to one row', () => {
    const works = [workFixture('W1', 'Board polish', ['session-a'])];
    const cards = [
      makeCard({ id: 'a-1', status: 'complete', sessionId: 'session-a', title: 'Turn A' }),
      makeCard({ id: 'b-1', status: 'complete', sessionId: 'session-b', title: 'Loose turn' }),
    ];
    const html = renderToStaticMarkup(<BoardScreen {...baseProps} viewMode="list" groupMode="works" works={works} cards={cards} />);
    expect(html).toContain('class="kv2-list-table-row kv2-list-row--work is-open"');
    expect(html).toContain('data-work-id="W1"');
    expect(html).toContain('data-session-group-key="session:session-a"');
    expect(html).toContain(LIST_COPY.unassigned);
    expect(html.indexOf('data-work-id="W1"')).toBeLessThan(html.indexOf('data-session-group-key="session:session-b"'));
    // Turns stay folded until the session row is opened.
    expect(html).not.toContain('kv2-list-row--turn');
    expect(html).not.toContain('kv2-card-work-row');
  });

  test('the list view keeps flat rows in GROUP: card, project chip before runtime', () => {
    const cards = [makeCard({ id: 'c-1', status: 'complete', sessionId: 's', projectDir: '/w/agent-kanban' })];
    const html = renderToStaticMarkup(<BoardScreen {...baseProps} viewMode="list" groupMode="card" cards={cards} />);
    expect(html).toContain('data-card-id="c-1"');
    expect(html).not.toContain('kv2-list-row--session');
    const meta = html.slice(html.indexOf('kv2-list-col-meta'));
    expect(meta.indexOf('kv2-list-project')).toBeLessThan(meta.indexOf('kv2-runtime-badge'));
  });

  test('the WORK filter narrows the board in works mode only', () => {
    const works = [{
      id: 'W1',
      title: 'Work one',
      status: 'active' as const,
      sessionLinks: [{ sessionId: 'session-in', linkedAt: '2026-04-17T00:00:00.000Z' }],
      startedAt: '2026-04-17T00:00:00.000Z',
      createdAt: '2026-04-17T00:00:00.000Z',
      updatedAt: '2026-04-17T00:00:00.000Z',
    }];
    const cards = [
      makeCard({ id: 'in-work', title: 'Linked turn', status: 'complete', sessionId: 'session-in' }),
      makeCard({ id: 'loose', title: 'Loose turn', status: 'complete', sessionId: 'session-out' }),
    ];

    const onlyWork = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupMode="works" works={works} workFilter={{ workId: 'W1' }} cards={cards} />,
    );
    expect(onlyWork).toContain('Linked turn');
    expect(onlyWork).not.toContain('Loose turn');

    const unassigned = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupMode="works" works={works} workFilter="unassigned" cards={cards} />,
    );
    expect(unassigned).not.toContain('Linked turn');
    expect(unassigned).toContain('Loose turn');

    const sessionMode = renderToStaticMarkup(
      <BoardScreen {...baseProps} groupMode="session" works={works} workFilter={{ workId: 'W1' }} cards={cards} />,
    );
    expect(sessionMode).toContain('Loose turn');
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
      <BoardScreen {...baseProps} groupMode="session" cards={turns} />,
    );

    expect(html).toContain(`${BOARD_SESSION_COPY.olderTurns(2)}<span class="kv2-complete-session-more-unread" aria-label="1 unread">● 1</span>`);
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
