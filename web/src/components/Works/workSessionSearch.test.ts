import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../../../../src/core/types';
import { searchHighlight, searchSnippet, searchWorkSessions, splitOnQuery } from './workSessionSearch';

const card = (id: string, sessionId: string, createdAt: string, overrides: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  title: `title ${id}`,
  description: '',
  status: 'complete',
  sessionId,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

describe('searchWorkSessions', () => {
  const cards = new Map<string, KanbanCard[]>([
    ['s1', [
      // newest first, as the board hands them over — numbering must not care
      card('c3', 's1', '2026-10-03T00:00:00Z', { result: '재시도 간격이 고정 1s' }),
      card('c2', 's1', '2026-10-02T00:00:00Z', { description: '아무 것도 없음' }),
      card('c1', 's1', '2026-10-01T00:00:00Z', { description: '재시도 큐 처리량 측정' }),
      card('sub', 's1', '2026-10-02T01:00:00Z', { parentCardId: 'c2', linkKind: 'subagent', result: '재시도 backoff' }),
    ]],
    ['s2', [card('d1', 's2', '2026-10-04T00:00:00Z', { result: 'lag' })]],
    ['s3', [card('e1', 's3', '2026-10-05T00:00:00Z', { title: 'Retry 재시도 정리' })]],
  ]);

  test('groups hits per session in chronological turn order with the matched field', () => {
    const groups = searchWorkSessions(['s3', 's1', 's2'], cards, ' 재시도 ');
    expect(groups.map((g) => g.sessionId)).toEqual(['s3', 's1']);
    expect(groups[1].hits.map((h) => [h.turnNumber, h.cardId, h.field])).toEqual([
      [1, 'c1', 'prompt'],
      [2, 'c2', 'subagent'],
      [3, 'c3', 'result'],
    ]);
    expect(groups[0].hits[0].field).toBe('title');
  });

  test('empty query returns nothing and the highlight collects ids', () => {
    expect(searchWorkSessions(['s1'], cards, '  ')).toEqual([]);
    const highlight = searchHighlight(searchWorkSessions(['s1', 's2'], cards, 'lag'));
    expect([...highlight.sessionIds]).toEqual(['s2']);
    expect([...highlight.cardIds]).toEqual(['d1']);
  });
});

describe('searchSnippet / splitOnQuery', () => {
  test('windows the text around the match', () => {
    const text = `${'앞'.repeat(60)} 재시도 ${'뒤'.repeat(300)}`;
    const snippet = searchSnippet(text, '재시도');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('재시도');
  });

  test('splits case-insensitively', () => {
    expect(splitOnQuery('Retry and retry', 'RETRY')).toEqual([
      { text: 'Retry', match: true },
      { text: ' and ', match: false },
      { text: 'retry', match: true },
    ]);
  });
});
