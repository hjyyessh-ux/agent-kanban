import { afterEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DELETE_CARD_CONFIRM_MESSAGE,
  BoardCard,
  confirmBoardCardDelete,
} from './BoardCard';
import type { V2CardViewModel } from './board-selectors';
import { CardActions } from './BoardCardSections';
import { CARD_ACTION_COPY } from '../../constants/copy';
import { primaryActionFor, secondaryActionFor } from '../../constants/card-actions';

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

describe('BoardCard layout', () => {
  const render = (overrides: Partial<V2CardViewModel> = {}) => renderToStaticMarkup(
    <BoardCard
      vm={makeVm(overrides)}
      draggable={false}
      onClick={mock(() => undefined)}
      onFavoriteToggle={mock(() => undefined)}
    />,
  );

  test('row 1 holds the project chip and the #ID, with the full path on the chip title', () => {
    const projectDir = '/Users/user/workspace/ghe-migration-tools-v1.0.5-darwin-arm64';
    const html = render({ id: 'NoLXQ2abcdef', projectDir });
    const top = html.slice(html.indexOf('kv2-card-top'), html.indexOf('kv2-card-surface'));

    expect(top).toContain('kv2-project-chip');
    expect(top).toMatch(/works-dir-c[1-8]/);
    expect(top).toContain(`title="${projectDir}"`);
    expect(top).toContain('>ghe-migration-tools-v1.0.5-darwin-arm64</span>');
    expect(top).toContain('>#NoLXQ2</button>');
    expect(top).toContain('kv2-favorite-toggle--board');
    expect(html).not.toContain('kv2-card-header-meta--floating');
  });

  test('moves the runtime badge to the meta line under the divider', () => {
    const html = render({ agentRuntime: 'codex', executionKind: 'agent' });
    const meta = html.slice(html.indexOf('kv2-card-meta-row'));

    expect(html.indexOf('kv2-card-divider')).toBeLessThan(html.indexOf('kv2-card-meta-row'));
    expect(meta).toContain('>CODEX</span>');
  });

  test('always shows the prompt, without a label, even when it repeats the title', () => {
    const html = render({ title: 'GHES dry-run 정리', boardSummary: 'GHES dry-run 정리' });

    expect(html).toContain('kv2-card-prompt">GHES dry-run 정리</div>');
    expect(html).not.toContain('kv2-card-section-label');
    expect(html).not.toContain('kv2-card-prompt-shell');
  });

  test('drops the Session, Proj and Created/Updated lines from the card face', () => {
    const html = render({
      status: 'in_progress',
      sessionId: 'f76971a7-92d2-4300-86c2-234ec6fc0000',
      projectDir: '/Users/user/workspace/mcp-server',
    });

    expect(html).not.toContain('Session:');
    expect(html).not.toContain('kv2-card-session-command');
    expect(html).not.toContain('f76971a7');
    expect(html).not.toContain('Proj:');
    expect(html).not.toContain('kv2-card-directory');
  });

  test('todo shows how long ago the card was touched', () => {
    const updatedAt = new Date(Date.now() - 27 * 86_400_000).toISOString();
    const html = render({ status: 'todo', createdAt: updatedAt, updatedAt });

    expect(html).toContain('>27d ago</span>');
  });

  test('in_progress shows the live elapsed time from startedAt', () => {
    const startedAt = new Date(Date.now() - (12 * 60 + 34) * 1000 - 200).toISOString();
    const html = render({ status: 'in_progress', startedAt });

    expect(html).toContain('kv2-card-time--live');
    expect(html).toContain('kv2-card-live-dot');
    expect(html).toContain('12분 34초째 실행 중');
  });

  test('in_progress without startedAt falls back to Updated …', () => {
    const updatedAt = new Date(Date.now() - 7 * 60_000).toISOString();
    const html = render({ status: 'in_progress', updatedAt });

    expect(html).not.toContain('kv2-card-time--live');
    expect(html).toContain('Updated 7m ago');
  });

  test('complete shows run length and time since it ended', () => {
    const completedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const html = render({ status: 'complete', completedAt, durationMs: (18 * 60 + 2) * 1000 });

    expect(html).toContain('⏱ 18m 2s · 3h ago');
  });

  test('done derives the run length from startedAt/completedAt when durationMs is missing', () => {
    const completedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const startedAt = new Date(Date.now() - 2 * 3_600_000 - 4 * 60_000).toISOString();
    const html = render({ status: 'done', startedAt, completedAt });

    expect(html).toContain('⏱ 4m · 2h ago');
  });
});

describe('CardActions mapping', () => {
  const render = (vm: V2CardViewModel) =>
    renderToStaticMarkup(
      <CardActions
        vm={vm}
        onStatusChange={mock(() => undefined)}
        onDispatch={mock(() => undefined)}
        onQueueOpen={mock(() => undefined)}
      />,
    );

  test('todo offers start (or start-now when scheduled) and queue', () => {
    const html = render(makeVm({ status: 'todo' }));
    expect(html).toContain(`>${CARD_ACTION_COPY.start}</button>`);
    expect(html).toContain(`>${CARD_ACTION_COPY.queue}</button>`);

    const scheduled = render(makeVm({ status: 'todo', hasScheduledBadge: true }));
    expect(scheduled).toContain(`>${CARD_ACTION_COPY.startNow}</button>`);
  });

  test('in_progress finishes the run and complete signs it off — never the same label', () => {
    const inProgress = render(makeVm({ status: 'in_progress' }));
    expect(inProgress).toContain(`kv2-card-action--finish">${CARD_ACTION_COPY.finish}</button>`);
    expect(inProgress).toContain(`>${CARD_ACTION_COPY.reopen}</button>`);
    expect(inProgress).not.toContain(CARD_ACTION_COPY.done);

    const complete = render(makeVm({ status: 'complete' }));
    expect(complete).toContain(`kv2-card-action--done">${CARD_ACTION_COPY.done}</button>`);
    expect(complete).toContain(`>${CARD_ACTION_COPY.reopen}</button>`);
    expect(complete).not.toContain(CARD_ACTION_COPY.finish);
  });

  test('done only reopens', () => {
    const html = render(makeVm({ status: 'done' }));
    expect(html).toContain(`>${CARD_ACTION_COPY.reopen}</button>`);
    expect(html.match(/<button/g)?.length).toBe(1);
  });

  test('BoardCard, List row and Card detail share primaryActionFor', () => {
    expect(primaryActionFor('in_progress')).toMatchObject({ kind: 'finish', target: 'complete' });
    expect(primaryActionFor('complete')).toMatchObject({ kind: 'done', target: 'done' });
    expect(primaryActionFor('done')).toMatchObject({ kind: 'reopen', target: 'todo' });
    expect(primaryActionFor('todo', { surface: 'detail' }).label).toBe(CARD_ACTION_COPY.startTask);
    expect(secondaryActionFor('todo')).toBeNull();
    expect(secondaryActionFor('done')).toBeNull();
  });
});
