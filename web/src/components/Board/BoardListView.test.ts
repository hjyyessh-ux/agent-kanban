import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCard } from '../../../../src/core/types';
import { BoardListView, orderColumnsForList } from './BoardListView';
import type { V2ColumnViewModel } from './board-selectors';

function makeColumn(status: V2ColumnViewModel['status']): V2ColumnViewModel {
  return {
    status,
    label: status,
    cards: [],
    count: 0,
  };
}

describe('BoardListView', () => {
  test('orders list sections as done -> complete -> in_progress -> todo', () => {
    const input: V2ColumnViewModel[] = [
      makeColumn('todo'),
      makeColumn('in_progress'),
      makeColumn('complete'),
      makeColumn('done'),
    ];

    const ordered = orderColumnsForList(input);

    expect(ordered.map((column) => column.status)).toEqual([
      'done',
      'complete',
      'in_progress',
      'todo',
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
});
