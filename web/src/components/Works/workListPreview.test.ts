import { describe, expect, test } from 'bun:test';
import type { KanbanCard, WorkListEntry, WorkSessionLink } from '../../../../src/core/types';
import { partitionRunningWorks, workListPreview, workProjectShares, workRunningCounts } from './workListPreview';

const link = (sessionId: string, projectDir?: string): WorkSessionLink => ({
  sessionId,
  projectDir,
  linkedAt: '2026-10-01T00:00:00.000Z',
});

const card = (id: string, overrides: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  title: id,
  description: '',
  status: 'complete',
  sessionId: 's1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('workListPreview', () => {
  const base = { sessionLinks: [link('s1')] };

  test('prefers the first Summary line', () => {
    expect(
      workListPreview({ ...base, summary: { lines: ['  ', '재시도 큐 병목 확인'], generatedAt: '2026-10-02T00:00:00.000Z', model: 'm' }, notes: '메모' }, []),
    ).toEqual({ source: 'summary', text: '재시도 큐 병목 확인' });
  });

  test('falls back to the notes first line', () => {
    expect(workListPreview({ ...base, notes: '\n## 다음: 리뷰\n세부' }, [])).toEqual({ source: 'notes', text: '다음: 리뷰' });
  });

  test('falls back to the latest finished top-level result of a linked session', () => {
    const cards = [
      card('old', { result: '오래된 결과', completedAt: '2026-10-01T00:00:00.000Z' }),
      card('new', { result: '## 새 결과\n본문', completedAt: '2026-10-03T00:00:00.000Z' }),
      card('sub', { result: '서브', parentCardId: 'new', completedAt: '2026-10-05T00:00:00.000Z' }),
      card('running', { result: '진행 중', status: 'in_progress', completedAt: '2026-10-06T00:00:00.000Z' }),
      card('other', { result: '다른 세션', sessionId: 's2', completedAt: '2026-10-07T00:00:00.000Z' }),
    ];
    expect(workListPreview(base, cards)).toEqual({ source: 'result', text: '새 결과' });
  });

  test('reports none when nothing is available', () => {
    expect(workListPreview(base, [card('empty')])).toEqual({ source: 'none', text: '' });
  });
});

describe('workProjectShares', () => {
  test('counts sessions per project, most first, then by name', () => {
    const work = {
      projectDir: '/w/agent-kanban',
      sessionLinks: [link('a', '/w/ingestion/'), link('b', '/w/mcp-server'), link('c', '/w/ingestion'), link('d', '/w/agent-kanban'), link('e')],
    };
    expect(workProjectShares(work)).toEqual([
      { projectDir: '/w/ingestion', sessionCount: 2 },
      { projectDir: '/w/agent-kanban', sessionCount: 1 },
      { projectDir: '/w/mcp-server', sessionCount: 1 },
    ]);
  });

  test('falls back to the Work projectDir when no link carries one', () => {
    expect(workProjectShares({ projectDir: '/w/x/', sessionLinks: [link('a')] })).toEqual([{ projectDir: '/w/x', sessionCount: 1 }]);
    expect(workProjectShares({ sessionLinks: [] })).toEqual([]);
  });
});

describe('workRunningCounts / partitionRunningWorks', () => {
  const work = (id: string, status: WorkListEntry['status'], sessions: string[]) =>
    ({ id, status, sessionLinks: sessions.map((s) => link(s)) }) as Pick<WorkListEntry, 'id' | 'status' | 'sessionLinks'>;
  const works = [work('a', 'active', ['s1']), work('b', 'active', ['s2', 's3']), work('c', 'done', ['s4']), work('d', 'active', ['s5'])];

  test('counts only top-level in_progress cards of active Works', () => {
    const cards = [
      card('1', { sessionId: 's2', status: 'in_progress' }),
      card('2', { sessionId: 's3', status: 'in_progress' }),
      card('3', { sessionId: 's1', status: 'todo' }),
      card('4', { sessionId: 's4', status: 'in_progress' }),
      card('5', { sessionId: 's5', status: 'in_progress', parentCardId: 'x' }),
      card('6', { sessionId: 's5', status: 'in_progress' }),
    ];
    expect([...workRunningCounts(works, cards)]).toEqual([['b', 2], ['d', 1]]);
  });

  test('lifts running Works, keeping order inside each group', () => {
    const { running, rest } = partitionRunningWorks(works, new Map([['d', 1], ['b', 2]]));
    expect(running.map((x) => x.id)).toEqual(['b', 'd']);
    expect(rest.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
