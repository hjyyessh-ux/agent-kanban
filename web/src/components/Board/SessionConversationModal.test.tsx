import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCard } from '../../../../src/core/types';
import {
  SessionConversationModal,
  isTurnOpen,
  previewLine,
  turnMatchesQuery,
} from './SessionConversationModal';
import type { CompleteSessionGroup } from './BoardCompleteSessionView';

function makeTurn(id: string, createdAt: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `title ${id}`,
    description: `prompt ${id}`,
    result: `result ${id}`,
    status: 'complete',
    sessionId: 'session-1',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeGroup(cards: KanbanCard[]): CompleteSessionGroup {
  return {
    key: 'session-1',
    sessionId: 'session-1',
    title: 'Session title',
    agentRuntime: 'claude',
    executionKind: undefined,
    scriptName: undefined,
    projectDir: undefined,
    startedAt: '2026-10-01T00:00:00.000Z',
    lastUpdatedAt: '2026-10-03T00:00:00.000Z',
    cards,
    unreadCount: 0,
  };
}

function render(group: CompleteSessionGroup): string {
  return renderToStaticMarkup(
    <SessionConversationModal
      group={group}
      status="complete"
      onClose={() => undefined}
      onCreateFeedback={async () => undefined}
    />,
  );
}

function renderedTurnOrder(html: string): number[] {
  return [...html.matchAll(/<article data-turn="(\d+)"/g)].map((match) => Number(match[1]));
}

// group.cards arrives newest-first, as the board groups it.
const threeTurns = () =>
  makeGroup([
    makeTurn('c3', '2026-10-03T00:00:00.000Z'),
    makeTurn('c2', '2026-10-02T00:00:00.000Z'),
    makeTurn('c1', '2026-10-01T00:00:00.000Z', { result: '## 첫 결과\n\n본문' }),
  ]);

describe('SessionConversationModal', () => {
  test('renders turns newest-first by default while keeping chronological turn numbers', () => {
    const html = render(threeTurns());

    expect(renderedTurnOrder(html)).toEqual([3, 2, 1]);
    expect(html).toMatch(/aria-pressed="true"[^>]*>↓ 최신순/);
    // The outline lists the same order and starts on the newest turn.
    expect(html).toMatch(/data-outline-turn="3"[^>]*aria-current="true"/);
  });

  test('opens the two most recent turns and folds older ones to a result preview', () => {
    const html = render(threeTurns());

    expect(html).toContain('result c3');
    expect(html).toContain('result c2');
    // T1 is folded: its body is not rendered, but the first result line is.
    expect(html).not.toContain('prompt c1');
    expect(html).toContain('session-conversation-turnPreview">첫 결과</p>');
  });

  test('reads in conversation order inside a turn: Prompt before Result', () => {
    const html = render(threeTurns());
    const turn3 = html.slice(html.indexOf('<article data-turn="3"'), html.indexOf('<article data-turn="2"'));

    expect(turn3.indexOf('prompt c3')).toBeGreaterThan(-1);
    expect(turn3.indexOf('prompt c3')).toBeLessThan(turn3.indexOf('result c3'));
  });

  test('the outline carries its own close button instead of a toolbar toggle', () => {
    const html = render(threeTurns());

    expect(html).toMatch(/session-conversation-outlineHead[\s\S]*aria-label="목차 닫기"/);
    expect(html).not.toContain('목차 접기');
  });

  test('the collapsed outline rail still lists every turn number', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const stored: Record<string, string> = { 'kanban-session-outline-collapsed': '1' };
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (key: string) => stored[key] ?? null, setItem: () => undefined, removeItem: () => undefined },
      configurable: true,
    });
    try {
      const html = render(threeTurns());
      const rail = html.slice(html.indexOf('session-conversation-outlineRail'), html.indexOf('session-conversation-scroll'));

      expect(rail).toContain('aria-label="목차 열기"');
      expect([...rail.matchAll(/session-conversation-railItem[^>]*>T(\d+)</g)].map((m) => Number(m[1]))).toEqual([3, 2, 1]);
      expect(html).not.toContain('aria-label="목차 닫기"');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  test('names the feedback target turn and keeps the draft per session', () => {
    const html = render(threeTurns());

    expect(html).toContain('→ T3에 이어붙임');
    expect(html).toContain('📎 스크린샷 첨부');
  });

  test('hides the toolbar and outline for a single-turn session', () => {
    const html = render(makeGroup([makeTurn('c1', '2026-10-01T00:00:00.000Z')]));

    expect(html).not.toContain('session-conversation-toolbar');
    expect(html).not.toContain('session-conversation-outline');
  });
});

describe('isTurnOpen', () => {
  test('recent mode opens only the last RECENT_OPEN_COUNT turns', () => {
    expect([1, 2, 3, 4].map((n) => isTurnOpen(n, 4, 'recent', undefined, false))).toEqual([false, false, true, true]);
  });

  test('a manual toggle wins over the mode, and a search hit wins over both', () => {
    expect(isTurnOpen(1, 4, 'all', false, false)).toBe(false);
    expect(isTurnOpen(4, 4, 'none', true, false)).toBe(true);
    expect(isTurnOpen(1, 4, 'none', false, true)).toBe(true);
  });
});

describe('previewLine', () => {
  test('strips markdown markers and skips blank/rule lines', () => {
    expect(previewLine('\n---\n## **결과** 요약\n- 다음')).toBe('결과 요약');
    expect(previewLine(undefined)).toBe('');
  });

  test('truncates long lines', () => {
    expect(previewLine('가'.repeat(200))).toHaveLength(161);
  });
});

describe('turnMatchesQuery', () => {
  test('matches title, prompt, result and subagent text case-insensitively', () => {
    const card = {
      ...makeTurn('c1', '2026-10-01T00:00:00.000Z', { title: 'Fix Telegram poller' }),
      childCards: [makeTurn('sub', '2026-10-01T00:00:00.000Z', { result: 'ClickHouse merge' })],
    };
    expect(turnMatchesQuery(card, 'telegram')).toBe(true);
    expect(turnMatchesQuery(card, 'clickhouse')).toBe(true);
    expect(turnMatchesQuery(card, 'nope')).toBe(false);
    expect(turnMatchesQuery(card, '  ')).toBe(true);
  });
});
