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
  test('keeps each agent runtime badge for non-script cards', () => {
    for (const [runtime, label] of [
      ['opencode', 'OPENCODE'],
      ['codex', 'CODEX'],
      ['claude', 'CLAUDE'],
    ] as const) {
      const html = renderToStaticMarkup(
        <BoardCard
          vm={makeVm({ agentRuntime: runtime, executionKind: 'agent' })}
          draggable={false}
          onClick={mock(() => undefined)}
        />,
      );

      expect(html).toContain(`>${label}</span>`);
      expect(html).toContain(`title="${label[0]}${label.slice(1).toLowerCase()} runtime"`);
      expect(html).not.toContain('>SCRIPT</span>');
    }
  });

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

  test('renders Quick Action and Script provenance with the script snapshot', () => {
    const html = renderToStaticMarkup(
      <BoardCard
        vm={makeVm({
          originChannel: 'quick_action',
          executionKind: 'script',
          quickActionId: 'qa-deploy',
          scriptName: 'Deploy service',
        })}
        draggable={false}
        onClick={mock(() => undefined)}
      />,
    );

    expect(html).toContain('Quick Action');
    expect(html).toContain('>SCRIPT</span>');
    expect(html).toContain('Quick Action origin · qa-deploy');
    expect(html).toContain('Script execution · Deploy service');
    expect(html).not.toContain('OPENCODE');
    expect(html.match(/>SCRIPT<\/span>/g)).toHaveLength(1);
  });
});
