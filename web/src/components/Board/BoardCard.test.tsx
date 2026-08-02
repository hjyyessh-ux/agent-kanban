import { afterEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DELETE_CARD_CONFIRM_MESSAGE,
  BoardCard,
  confirmBoardCardDelete,
} from './BoardCard';
import type { V2CardViewModel } from './board-selectors';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  });
});

describe('confirmBoardCardDelete', () => {
  test('asks before deleting a board card', () => {
    const confirm = mock((message: string) => {
      expect(message).toBe(DELETE_CARD_CONFIRM_MESSAGE);
      return true;
    });
    Object.defineProperty(globalThis, 'window', {
      value: { confirm },
      configurable: true,
    });

    expect(confirmBoardCardDelete()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test('returns false when the user cancels', () => {
    const confirm = mock(() => false);
    Object.defineProperty(globalThis, 'window', {
      value: { confirm },
      configurable: true,
    });

    expect(confirmBoardCardDelete()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

function makeVm(overrides: Partial<V2CardViewModel> = {}): V2CardViewModel {
  return {
    id: 'card-1',
    title: 'Card title',
    boardSummary: 'Prompt body',
    status: 'todo',
    agentLabel: 'Sisyphus',
    agentColor: 'var(--kv2-agent-default)',
    agentEmoji: null,
    agentRuntime: 'claude',
    hasChildren: false,
    childCount: 0,
    childTodoCount: 0,
    childInProgressCount: 0,
    childDoneCount: 0,
    isChild: false,
    linkKind: undefined,
    nestedChildren: [],
    workerChildCount: 0,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
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
    hasScheduledBadge: false,
    scheduledStatus: undefined,
    scheduledAt: undefined,
    scheduledAtLabel: undefined,
    scheduledBadgeLabel: undefined,
    scheduledFailureReason: undefined,
    scheduledDispatchedAtLabel: undefined,
    ...overrides,
  };
}

describe('BoardCard scheduled metadata', () => {
  test('renders the scheduled time visibly with aria-label and title', () => {
    const html = renderToStaticMarkup(
      <BoardCard
        vm={makeVm({
          hasScheduledBadge: true,
          scheduledBadgeLabel: '예약됨 · 2026-07-18 09:30 KST',
        })}
        draggable={false}
        onClick={mock(() => undefined)}
      />,
    );

    expect(html).toContain('aria-label="예약됨 · 2026-07-18 09:30 KST"');
    expect(html).toContain('title="예약됨 · 2026-07-18 09:30 KST"');
    expect(html).toContain('kv2-scheduled-badge');
    expect(html).toContain('kv2-scheduled-time-label');
    expect(html).toContain('예약됨 · 2026-07-18 09:30 KST</span>');
  });

  test('renders the scheduler origin badge when the card came from Scheduler', () => {
    const html = renderToStaticMarkup(
      <BoardCard
        vm={makeVm({
          originChannel: 'scheduler',
          schedulerName: 'Nightly Summary',
        })}
        draggable={false}
        onClick={mock(() => undefined)}
      />,
    );

    expect(html).toContain('aria-label="Scheduler"');
    expect(html).toContain('title="Scheduler origin · Nightly Summary"');
    expect(html).toContain('kv2-scheduler-badge');
  });
});
