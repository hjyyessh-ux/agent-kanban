import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCard } from '../../../../src/core/types';
import { BoardListView, orderColumnsForList } from './BoardListView';
import { selectColumns, type V2ColumnViewModel } from './board-selectors';

function makeColumn(status: V2ColumnViewModel['status']): V2ColumnViewModel {
  return {
    status,
    label: status,
    cards: [],
    count: 0,
    unreadCount: 0,
  };
}

describe('BoardListView', () => {
  test('orders list sections as complete -> in_progress -> todo -> done (needs-me first)', () => {
    const input: V2ColumnViewModel[] = [
      makeColumn('todo'),
      makeColumn('in_progress'),
      makeColumn('complete'),
      makeColumn('done'),
    ];

    const ordered = orderColumnsForList(input);

    expect(ordered.map((column) => column.status)).toEqual([
      'complete',
      'in_progress',
      'todo',
      'done',
    ]);
  });

  test('renders scheduled icon metadata in list mode', () => {
    const card: KanbanCard = {
      id: 'card-1',
      title: 'Scheduled card',
      description: 'Prompt body',
      status: 'todo',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      scheduledDispatch: {
        scheduledAt: '2026-07-18T00:30:00.000Z',
        status: 'scheduled',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    const columns: V2ColumnViewModel[] = [{
      status: 'todo',
      label: 'To Do',
      count: 1,
      unreadCount: 0,
      cards: [{
        id: card.id,
        title: card.title,
        boardSummary: card.description,
        status: card.status,
        agentLabel: null,
        agentColor: 'var(--kv2-agent-default)',
        agentEmoji: null,
        agentRuntime: 'opencode',
        hasChildren: false,
        childCount: 0,
        childTodoCount: 0,
        childInProgressCount: 0,
        childDoneCount: 0,
        isChild: false,
        linkKind: undefined,
        nestedChildren: [],
        workerChildCount: 0,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        startedAt: undefined,
        completedAt: undefined,
        durationMs: undefined,
        sessionId: undefined,
        projectDir: undefined,
        hasQuestion: false,
        queuedAfterCardId: undefined,
        queuePosition: undefined,
        queueSessionMode: undefined,
        queueTargetTitle: undefined,
        parentCardId: undefined,
        sourceContext: undefined,
        originChannel: undefined,
        requestedBy: undefined,
        schedulerName: undefined,
        telegramMessageId: undefined,
        telegramChatId: undefined,
        telegramReplyStatus: undefined,
        telegramReplyMessageId: undefined,
        telegramReplyError: undefined,
        favorite: false,
        hasUnreadCompletion: false,
        hasScheduledBadge: true,
        scheduledStatus: 'scheduled',
        scheduledAt: '2026-07-18T00:30:00.000Z',
        scheduledAtLabel: '2026-07-18 09:30 KST',
        scheduledBadgeLabel: '예약됨 · 2026-07-18 09:30 KST',
        scheduledFailureReason: undefined,
        scheduledDispatchedAtLabel: undefined,
      }],
    }];

    const html = renderToStaticMarkup(
      React.createElement(BoardListView, {
        columns,
        allCards: [card],
        onCardClick: mock(() => undefined),
        onStatusChange: mock(() => undefined),
        onFavoriteToggle: mock(() => undefined),
      }),
    );

    expect(html).toContain('aria-label="예약됨 · 2026-07-18 09:30 KST"');
    expect(html).toContain('Scheduled card');
  });

  test('shows Script instead of the legacy runtime in the runtime column', () => {
    const card: KanbanCard = {
      id: 'script-card',
      title: 'Deploy from Quick Action',
      description: 'Deploy the service',
      status: 'todo',
      agentRuntime: 'opencode',
      originChannel: 'quick_action',
      executionKind: 'script',
      quickActionId: 'qa-deploy',
      scriptName: 'Deploy service',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    const html = renderToStaticMarkup(
      React.createElement(BoardListView, {
        columns: selectColumns([card]),
        allCards: [card],
        onCardClick: mock(() => undefined),
        onStatusChange: mock(() => undefined),
        onFavoriteToggle: mock(() => undefined),
      }),
    );

    expect(html).toContain('>SCRIPT</span>');
    expect(html).toContain('Script execution · Deploy service');
    expect(html).toContain('Quick Action origin · qa-deploy');
    expect(html).not.toContain('OPENCODE');
    expect(html.match(/>SCRIPT<\/span>/g)).toHaveLength(1);
  });

  test('shows the Dots badge in the list row when requestedBy is dots', () => {
    const card: KanbanCard = {
      id: 'requested-card',
      title: 'API registered card',
      description: 'Registered by Dot',
      status: 'todo',
      agentRuntime: 'codex',
      requestedBy: 'dots',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    const html = renderToStaticMarkup(
      React.createElement(BoardListView, {
        columns: selectColumns([card]),
        allCards: [card],
        onCardClick: mock(() => undefined),
        onStatusChange: mock(() => undefined),
        onFavoriteToggle: mock(() => undefined),
      }),
    );

    expect(html).toContain('kv2-dots-badge');
    expect(html).toContain('aria-label="Dots"');
    expect(html).toMatch(/<img[^>]*src="[^"]*dots-felipe[^"]*"[^>]*class="kv2-dots-icon"/);
  });

  test('omits the Dots badge in the list row when requestedBy is user or unspecified', () => {
    const userCard: KanbanCard = {
      id: 'user-card',
      title: 'Web-created card',
      description: 'Created via the new-card form',
      status: 'todo',
      agentRuntime: 'codex',
      requestedBy: 'user',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const unspecifiedCard: KanbanCard = {
      id: 'unspecified-card',
      title: 'Legacy card',
      description: 'No requester set',
      status: 'todo',
      agentRuntime: 'codex',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const cards = [userCard, unspecifiedCard];

    const html = renderToStaticMarkup(
      React.createElement(BoardListView, {
        columns: selectColumns(cards),
        allCards: cards,
        onCardClick: mock(() => undefined),
        onStatusChange: mock(() => undefined),
        onFavoriteToggle: mock(() => undefined),
      }),
    );

    expect(html).not.toContain('kv2-dots-badge');
    expect(html).not.toContain('요청자');
  });

  test('a folded SESSION row carries no request-origin badge (turn rows do)', () => {
    const at = (hour: number) => `2026-11-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const base = { status: 'complete' as const, sessionId: 'sess-list', agentRuntime: 'claude' as const };
    const cards: KanbanCard[] = [
      { ...base, id: 'l-dots', title: 'Dots turn', description: 'p1', requestedBy: 'dots', createdAt: at(3), updatedAt: at(3), completedAt: at(3) },
      { ...base, id: 'l-tg', title: 'Telegram turn', description: 'p2', originChannel: 'telegram', createdAt: at(2), updatedAt: at(2), completedAt: at(2) },
    ];
    const html = renderToStaticMarkup(
      React.createElement(BoardListView, {
        columns: selectColumns(cards),
        allCards: cards,
        groupMode: 'session',
        onCardClick: mock(() => undefined),
        onStatusChange: mock(() => undefined),
        onFavoriteToggle: mock(() => undefined),
      }),
    );
    expect(html).toContain('kv2-list-row--session');
    expect(html).not.toContain('kv2-dots-badge');
    expect(html).not.toContain('kv2-telegram-badge');
  });
});
