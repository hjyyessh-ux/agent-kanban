import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { countUnread, isUnreadCompletion, selectColumns } from './board-selectors';
import { groupCompleteCardsBySession } from './BoardCompleteSessionView';

function makeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    status: 'todo',
    agentRuntime: 'claude',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function getTodoCard(cards: KanbanCard[], id: string) {
  const cols = selectColumns(cards);
  return cols.find((c) => c.status === 'todo')!.cards.find((vm) => vm.id === id)!;
}

describe('selectColumns — nested child tree', () => {
  test('single-runtime card has empty nestedChildren and no children', () => {
    const card = makeCard('standalone');
    const vm = getTodoCard([card], 'standalone');
    expect(vm.nestedChildren).toHaveLength(0);
    expect(vm.hasChildren).toBe(false);
    expect(vm.workerChildCount).toBe(0);
  });

  test('nested child populates nestedChildren on parent', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const vm = getTodoCard([parent, child], 'p1');
    expect(vm.nestedChildren).toHaveLength(1);
    expect(vm.nestedChildren[0].id).toBe('c1');
    expect(vm.nestedChildren[0].status).toBe('in_progress');
    expect(vm.nestedChildren[0].linkKind).toBe('nested');
  });

  test('nested child does not appear as a column-level card', () => {
    const parent = makeCard('p1');
    const child = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'todo' });
    const allIds = selectColumns([parent, child]).flatMap((c) => c.cards.map((vm) => vm.id));
    expect(allIds).toContain('p1');
    expect(allIds).not.toContain('c1');
  });

  test('child counts are accurate across statuses', () => {
    const parent = makeCard('p1');
    const c1 = makeCard('c1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const c2 = makeCard('c2', { parentCardId: 'p1', linkKind: 'nested', status: 'complete' });
    const c3 = makeCard('c3', { parentCardId: 'p1', linkKind: 'nested', status: 'todo' });
    const vm = getTodoCard([parent, c1, c2, c3], 'p1');
    expect(vm.childCount).toBe(3);
    expect(vm.childInProgressCount).toBe(1);
    expect(vm.childDoneCount).toBe(1);
    expect(vm.childTodoCount).toBe(1);
    expect(vm.nestedChildren).toHaveLength(3);
  });

  test('worker child increments workerChildCount but not nestedChildren', () => {
    const parent = makeCard('p1');
    const worker = makeCard('w1', { parentCardId: 'p1', linkKind: 'worker', status: 'in_progress' });
    const vm = getTodoCard([parent, worker], 'p1');
    expect(vm.workerChildCount).toBe(1);
    expect(vm.nestedChildren).toHaveLength(0);
    expect(vm.childCount).toBe(1);
  });

  test('mixed nested+worker children are correctly split', () => {
    const parent = makeCard('p1');
    const nested = makeCard('n1', { parentCardId: 'p1', linkKind: 'nested', status: 'in_progress' });
    const worker = makeCard('w1', { parentCardId: 'p1', linkKind: 'worker', status: 'todo' });
    const vm = getTodoCard([parent, nested, worker], 'p1');
    expect(vm.nestedChildren).toHaveLength(1);
    expect(vm.nestedChildren[0].id).toBe('n1');
    expect(vm.workerChildCount).toBe(1);
    expect(vm.childCount).toBe(2);
  });

  test('derives scheduled fields for scheduled todo cards in KST', () => {
    const vm = getTodoCard([
      makeCard('scheduled', {
        scheduledDispatch: {
          scheduledAt: '2026-07-18T00:30:00.000Z',
          status: 'scheduled',
          updatedAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    ], 'scheduled');

    expect(vm.hasScheduledBadge).toBe(true);
    expect(vm.scheduledStatus).toBe('scheduled');
    expect(vm.scheduledAtLabel).toBe('2026-07-18 09:30 KST');
    expect(vm.scheduledBadgeLabel).toBe('예약됨 · 2026-07-18 09:30 KST');
  });

  test('preserves Quick Action execution provenance for board and list renderers', () => {
    const vm = getTodoCard([
      makeCard('quick-action', {
        originChannel: 'quick_action',
        executionKind: 'script',
        quickActionId: 'qa-1',
        scriptName: 'Deploy service',
      }),
    ], 'quick-action');

    expect(vm).toMatchObject({
      originChannel: 'quick_action',
      executionKind: 'script',
      quickActionId: 'qa-1',
      scriptName: 'Deploy service',
    });
  });
});

describe('selectColumns — board summary', () => {
  test('a feedback card is summarized by its instruction, not by the generated header', () => {
    const card = makeCard('fb', {
      description: [
        '[Feedback for: 원본 카드]',
        '[Original Card ID: abc12345]',
        '[Original Result: 부모 카드의 결과 발췌]',
        '---',
        '이번엔 그룹 채팅도 봐줘',
      ].join('\n'),
    });

    expect(getTodoCard([card], 'fb').boardSummary).toBe('이번엔 그룹 채팅도 봐줘');
  });

  test('an ordinary description is still summarized from its own first line', () => {
    const card = makeCard('plain', { description: '첫 줄\n둘째 줄' });
    expect(getTodoCard([card], 'plain').boardSummary).toBe('첫 줄 둘째 줄');
  });

  test('falls back to progressSummary when a feedback card has only the header', () => {
    const card = makeCard('header-only', {
      description: ['[Feedback for: 원본 카드]', '[Original Card ID: abc12345]', '---'].join('\n'),
      progressSummary: '진행 중',
    });

    expect(getTodoCard([card], 'header-only').boardSummary).toBe('진행 중');
  });
});

describe('isUnreadCompletion / countUnread', () => {
  const COMPLETED = '2026-06-01T10:00:00.000Z';
  const RESPONDED = '2026-06-01T12:00:00.000Z';

  function completeCard(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
    return makeCard(id, { status: 'complete', completedAt: COMPLETED, ...overrides });
  }

  test('a completion never opened is unread', () => {
    expect(isUnreadCompletion(completeCard('never-seen'))).toBe(true);
  });

  test('seen before the completion is unread again', () => {
    const card = completeCard('seen-before', { completedSeenAt: '2026-06-01T09:00:00.000Z' });
    expect(isUnreadCompletion(card)).toBe(true);
  });

  test('seen at exactly the completion moment is read', () => {
    expect(isUnreadCompletion(completeCard('seen-same', { completedSeenAt: COMPLETED }))).toBe(false);
  });

  test('responseAt wins over completedAt as the completion moment', () => {
    // Seen after the card entered complete, but before the latest response
    // landed: the response is what the user has not seen.
    const newer = completeCard('response-newer', {
      responseAt: RESPONDED,
      completedSeenAt: '2026-06-01T11:00:00.000Z',
    });
    expect(isUnreadCompletion(newer)).toBe(true);

    // And a stale completedAt does not resurrect a response already seen.
    const seen = completeCard('response-seen', {
      responseAt: '2026-06-01T09:00:00.000Z',
      completedSeenAt: '2026-06-01T09:30:00.000Z',
    });
    expect(isUnreadCompletion(seen)).toBe(false);
  });

  test('falls back to updatedAt when there is no response or completion stamp', () => {
    const card = makeCard('legacy', { status: 'complete', updatedAt: COMPLETED });
    expect(isUnreadCompletion(card)).toBe(true);
    expect(isUnreadCompletion({ ...card, completedSeenAt: COMPLETED })).toBe(false);
  });

  test('a completion with no usable moment at all is never unread', () => {
    // The App.tsx copy lacked this guard and called such a card unread; the
    // board badge and session count did not. The unified rule sides with them.
    const card = makeCard('no-moment', { status: 'complete', updatedAt: '' });
    expect(isUnreadCompletion(card)).toBe(false);
  });

  test('only complete cards can be unread', () => {
    for (const status of ['todo', 'in_progress', 'done'] as const) {
      expect(isUnreadCompletion(completeCard(`s-${status}`, { status }))).toBe(false);
    }
  });

  test('countUnread counts exactly the cards isUnreadCompletion flags', () => {
    const cards = [
      completeCard('a'),
      completeCard('b', { completedSeenAt: COMPLETED }),
      completeCard('c', { responseAt: RESPONDED, completedSeenAt: COMPLETED }),
      makeCard('d'),
    ];
    expect(countUnread(cards)).toBe(2);
    expect(countUnread([])).toBe(0);
  });

  test('board badge and session group count agree', () => {
    const cards = [
      completeCard('g1', { sessionId: 'ses-1' }),
      completeCard('g2', { sessionId: 'ses-1', completedSeenAt: COMPLETED }),
      completeCard('g3', { sessionId: 'ses-1', responseAt: RESPONDED, completedSeenAt: COMPLETED }),
    ];
    const [group] = groupCompleteCardsBySession(cards);
    const column = selectColumns(cards).find((c) => c.status === 'complete')!;
    const badged = column.cards.filter((vm) => vm.hasUnreadCompletion).length;
    expect(group.unreadCount).toBe(2);
    expect(badged).toBe(group.unreadCount);
  });
});
