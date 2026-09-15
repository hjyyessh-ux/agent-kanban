import { describe, expect, test } from 'bun:test';
import { appendReferenceBlock, parseMentionTokens, type ResolvedReference } from './mention-reference';
import {
  DEFAULT_MENTION_LIMIT,
  buildSessionCandidateSources,
  encodeDocIdForToken,
  selectMentionCandidates,
  stripFeedbackHeader,
  stripFeedbackTitlePrefix,
  type DocEntry,
  type MentionSearchPool,
} from './mention-search';
import type { KanbanCard, Work } from './types';

function card(overrides: Partial<KanbanCard> & { id: string }): KanbanCard {
  return {
    title: 'test',
    description: '',
    status: 'complete',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  } as KanbanCard;
}

function work(overrides: Partial<Work> & { id: string }): Work {
  return {
    title: 'Work',
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as Work;
}

function pool(overrides: Partial<MentionSearchPool> = {}): MentionSearchPool {
  return { sessions: [], works: [], docs: [], ...overrides };
}

function sessionsOf(cards: KanbanCard[]): MentionSearchPool {
  return pool({ sessions: buildSessionCandidateSources(cards) });
}

describe('stripFeedbackHeader', () => {
  test('removes the generated header block and the --- that follows it', () => {
    const description = [
      '[Feedback for: 텔레그램 폴러 중복 카드 수정]',
      '[Original Card ID: k5mR0pBn]',
      '[Original Result: 폴러 dedup 키를 messageId 기준으로 변경]',
      '---',
      '이번엔 그룹 채팅도 봐줘',
    ].join('\n');

    expect(stripFeedbackHeader(description)).toBe('이번엔 그룹 채팅도 봐줘');
  });

  test('a multi-line [Original Result: …] is consumed whole', () => {
    const description = [
      '[Feedback for: 무엇]',
      '[Original Result: 첫 줄',
      '둘째 줄도 발췌에 들어간다]',
      '---',
      '실제 피드백',
    ].join('\n');

    expect(stripFeedbackHeader(description)).toBe('실제 피드백');
  });

  test('leaves an ordinary description that merely starts with a bracket alone', () => {
    const description = '[중요] 이건 사용자가 직접 쓴 본문이다';
    expect(stripFeedbackHeader(description)).toBe(description);
  });
});

describe('stripFeedbackTitlePrefix', () => {
  test('peels every legacy and numbered prefix', () => {
    expect(stripFeedbackTitlePrefix('Feedback #3: 텔레그램 폴러 수정')).toBe('텔레그램 폴러 수정');
    expect(stripFeedbackTitlePrefix('Feedback: Feedback: 텔레그램 폴러 수정')).toBe('텔레그램 폴러 수정');
    expect(stripFeedbackTitlePrefix('텔레그램 폴러 수정')).toBe('텔레그램 폴러 수정');
  });
});

describe('buildSessionCandidateSources', () => {
  test('groups cards by session and drops cards that have no session', () => {
    const sources = buildSessionCandidateSources([
      card({ id: 'a', sessionId: 's1' }),
      card({ id: 'b', sessionId: 's1' }),
      card({ id: 'c' }),
      card({ id: 'd', sessionId: 's2' }),
    ]);

    expect(sources.map((s) => [s.sessionId, s.cards.length])).toEqual([['s1', 2], ['s2', 1]]);
  });

  test('soft-deleted cards are not candidates', () => {
    const sources = buildSessionCandidateSources([
      card({ id: 'a', sessionId: 's1', deletedAt: '2026-09-11T00:00:00.000Z' }),
    ]);
    expect(sources).toEqual([]);
  });
});

describe('session matching', () => {
  test('matches on description and result, not only on title', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', title: 'test', description: '텔레그램 폴러 중복 카드를 고쳐줘' }),
      card({ id: 'c2', sessionId: 'bbbb2222', title: 'UI 수정', result: '폴러 dedup 키를 messageId 기준으로 변경' }),
      card({ id: 'c3', sessionId: 'cccc3333', title: 'test', description: '전혀 상관 없는 작업' }),
    ]);

    expect(selectMentionCandidates(board, { q: '텔레그램' }).sessions.map((c) => c.id)).toEqual(['aaaa1111']);
    expect(selectMentionCandidates(board, { q: 'dedup' }).sessions.map((c) => c.id)).toEqual(['bbbb2222']);
  });

  test('Korean substring matching needs no tokenizer', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', description: '텔레그램 폴러 중복 카드' })]);
    expect(selectMentionCandidates(board, { q: '폴러' }).sessions.length).toBe(1);
    expect(selectMentionCandidates(board, { q: '중복 카드' }).sessions.length).toBe(1);
  });

  test('matching is case-insensitive', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', description: 'TelegramPoller dedup' })]);
    expect(selectMentionCandidates(board, { q: 'telegrampoller' }).sessions.length).toBe(1);
  });

  test('a sessionId prefix matches even when no text does', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'kx9f2a1b-7c3e-4d21', description: '아무 말' })]);

    const hit = selectMentionCandidates(board, { q: 'kx9f2a' }).sessions;
    expect(hit.length).toBe(1);
    expect(hit[0].id).toBe('kx9f2a1b');
    expect(hit[0].snippet).toBeUndefined();

    // 접두사여야 한다 — 중간 일치는 세션 ID 매칭이 아니다.
    expect(selectMentionCandidates(board, { q: '9f2a1b' }).sessions.length).toBe(0);
  });

  test('three cards on one session collapse into a single row', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', title: '원본', description: '텔레그램 폴러 고쳐줘', createdAt: '2026-09-10T01:00:00.000Z', updatedAt: '2026-09-10T01:00:00.000Z' }),
      card({ id: 'c2', sessionId: 'aaaa1111', title: 'Feedback #1: 원본', description: '텔레그램 그룹 채팅도', createdAt: '2026-09-10T02:00:00.000Z', updatedAt: '2026-09-10T02:00:00.000Z', status: 'in_progress' }),
      card({ id: 'c3', sessionId: 'aaaa1111', title: 'Feedback #2: 원본', description: '텔레그램 마지막', createdAt: '2026-09-10T03:00:00.000Z', updatedAt: '2026-09-10T03:00:00.000Z', status: 'todo', agentRuntime: 'codex' }),
    ]);

    const rows = selectMentionCandidates(board, { q: '텔레그램' }).sessions;
    expect(rows.length).toBe(1);
    expect(rows[0].sublabel).toBe('카드 3장');
    // 표시 메타는 가장 최근 카드의 것.
    expect(rows[0].status).toBe('todo');
    expect(rows[0].agentRuntime).toBe('codex');
    expect(rows[0].updatedAt).toBe('2026-09-10T03:00:00.000Z');
  });

  test('a session matches through any of its cards', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', description: '첫 작업' }),
      card({ id: 'c2', sessionId: 'aaaa1111', description: '위키 백필도 해줘' }),
    ]);

    expect(selectMentionCandidates(board, { q: '위키' }).sessions.length).toBe(1);
  });

  test('an empty query lists every session', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111' }),
      card({ id: 'c2', sessionId: 'bbbb2222' }),
    ]);
    expect(selectMentionCandidates(board, {}).sessions.length).toBe(2);
  });
});

describe('noise that must not be indexed', () => {
  test("a feedback card is not found by its parent's result excerpt", () => {
    const board = sessionsOf([
      card({
        id: 'child',
        sessionId: 'bbbb2222',
        title: 'Feedback #1: 무언가',
        description: [
          '[Feedback for: 무언가]',
          '[Original Card ID: k5mR0pBn]',
          '[Original Result: 텔레그램 폴러 dedup 키를 고쳤다]',
          '---',
          '이번엔 위키 백필을 해줘',
        ].join('\n'),
      }),
    ]);

    expect(selectMentionCandidates(board, { q: '텔레그램' }).sessions.length).toBe(0);
    expect(selectMentionCandidates(board, { q: '위키 백필' }).sessions.length).toBe(1);
  });

  test('a reference block does not make its own card findable (no self-propagation)', () => {
    const reference: ResolvedReference = {
      kind: 'session',
      id: 'kx9f2a1b',
      raw: '@session:kx9f2a1b',
      title: '텔레그램 폴러 중복 카드 수정',
      sessionId: 'kx9f2a1b-7c3e',
      transcriptPath: '/tmp/kx9f2a1b.jsonl',
      transcriptSize: 1024,
    };
    const description = appendReferenceBlock('스케줄러 쪽만 손봐줘', [reference]);
    const board = sessionsOf([card({ id: 'c1', sessionId: 'cccc3333', description })]);

    // 블록 안에만 있는 단어로는 걸리지 않는다.
    expect(selectMentionCandidates(board, { q: '텔레그램' }).sessions.length).toBe(0);
    expect(selectMentionCandidates(board, { q: 'Referenced context' }).sessions.length).toBe(0);
    // 사용자가 실제로 쓴 본문으로는 걸린다.
    expect(selectMentionCandidates(board, { q: '스케줄러' }).sessions.length).toBe(1);
  });
});

describe('snippets', () => {
  test('carries ±40 characters of context and the field it matched', () => {
    const before = '가'.repeat(80);
    const after = '나'.repeat(80);
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', description: `${before}텔레그램${after}` }),
    ]);

    const snippet = selectMentionCandidates(board, { q: '텔레그램' }).sessions[0].snippet!;
    expect(snippet.field).toBe('description');
    expect(snippet.text).toBe(`…${'가'.repeat(40)}텔레그램${'나'.repeat(40)}…`);
  });

  test('omits the ellipsis when the match already sits at the edge', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', description: '텔레그램 폴러' })]);
    expect(selectMentionCandidates(board, { q: '텔레그램' }).sessions[0].snippet!.text).toBe('텔레그램 폴러');
  });

  test('reports only one field, preferring title over description over result', () => {
    const board = sessionsOf([
      card({
        id: 'c1',
        sessionId: 'aaaa1111',
        title: '텔레그램 제목',
        description: '텔레그램 본문',
        result: '텔레그램 결과',
      }),
      card({ id: 'c2', sessionId: 'bbbb2222', description: '텔레그램 본문', result: '텔레그램 결과' }),
      card({ id: 'c3', sessionId: 'cccc3333', result: '텔레그램 결과' }),
    ]);

    const byId = new Map(
      selectMentionCandidates(board, { q: '텔레그램' }).sessions.map((c) => [c.id, c.snippet!.field]),
    );
    expect(byId.get('aaaa1111')).toBe('title');
    expect(byId.get('bbbb2222')).toBe('description');
    expect(byId.get('cccc3333')).toBe('result');
  });

  test('there is no snippet when there is no query', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', description: '텔레그램' })]);
    expect(selectMentionCandidates(board, {}).sessions[0].snippet).toBeUndefined();
  });
});

describe('label fallback chain', () => {
  const LONG_TITLE = '텔레그램 폴러가 같은 메시지로 카드를 두 번 만드는 문제를 dedup 키로 정리하기';

  test('1 — sessionTitle wins when a card has one', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', sessionTitle: '세션 제목', title: LONG_TITLE }),
    ]);
    expect(selectMentionCandidates(board, {}).sessions[0].label).toBe('세션 제목');
  });

  test('2 — a long enough card title, with feedback prefixes peeled', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', title: `Feedback #2: ${LONG_TITLE}` })]);
    expect(selectMentionCandidates(board, {}).sessions[0].label).toBe(LONG_TITLE);
  });

  test('3 — a short or meaningless title falls through to the first description line', () => {
    const short = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', title: 'test', description: '\n\n텔레그램 폴러 중복 카드 고쳐줘\n나머지 줄' }),
    ]);
    expect(selectMentionCandidates(short, {}).sessions[0].label).toBe('텔레그램 폴러 중복 카드 고쳐줘');

    const notification = sessionsOf([
      card({
        id: 'c1',
        sessionId: 'bbbb2222',
        title: `<task-notification> ${'x'.repeat(80)}`,
        description: '위키 백필 돌려줘',
      }),
    ]);
    expect(selectMentionCandidates(notification, {}).sessions[0].label).toBe('위키 백필 돌려줘');
  });

  test('3 — the description line is cut at 60 characters', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'aaaa1111', description: '가'.repeat(100) })]);
    expect(selectMentionCandidates(board, {}).sessions[0].label).toBe(`${'가'.repeat(60)}…`);
  });

  test('4 — with nothing usable, the session id itself', () => {
    const board = sessionsOf([card({ id: 'c1', sessionId: 'kx9f2a1b-7c3e-4d21', title: 'test', description: '   ' })]);
    expect(selectMentionCandidates(board, {}).sessions[0].label).toBe('세션 kx9f2a1b');
  });

  test('the label comes from the oldest card, the metadata from the newest', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', description: '원래 시킨 일', createdAt: '2026-09-10T01:00:00.000Z', updatedAt: '2026-09-10T01:00:00.000Z' }),
      card({ id: 'c2', sessionId: 'aaaa1111', description: '나중 피드백', createdAt: '2026-09-10T05:00:00.000Z', updatedAt: '2026-09-10T05:00:00.000Z', status: 'todo' }),
    ]);

    const row = selectMentionCandidates(board, {}).sessions[0];
    expect(row.label).toBe('원래 시킨 일');
    expect(row.status).toBe('todo');
  });

  test('the description label is built from the cleaned body, not the feedback header', () => {
    const board = sessionsOf([
      card({
        id: 'c1',
        sessionId: 'aaaa1111',
        title: 'Feedback #1: test',
        description: ['[Feedback for: test]', '[Original Card ID: abcd1234]', '---', '그룹 채팅도 봐줘'].join('\n'),
      }),
    ]);

    expect(selectMentionCandidates(board, {}).sessions[0].label).toBe('그룹 채팅도 봐줘');
  });
});

describe('sorting', () => {
  test('currentProjectDir first, then most recently updated', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', projectDir: '/other', updatedAt: '2026-09-14T00:00:00.000Z' }),
      card({ id: 'c2', sessionId: 'bbbb2222', projectDir: '/here', updatedAt: '2026-09-10T00:00:00.000Z' }),
      card({ id: 'c3', sessionId: 'cccc3333', projectDir: '/here', updatedAt: '2026-09-12T00:00:00.000Z' }),
      card({ id: 'c4', sessionId: 'dddd4444', projectDir: '/other', updatedAt: '2026-09-13T00:00:00.000Z' }),
    ]);

    expect(selectMentionCandidates(board, { currentProjectDir: '/here' }).sessions.map((c) => c.id))
      .toEqual(['cccc3333', 'bbbb2222', 'aaaa1111', 'dddd4444']);
  });

  test('without currentProjectDir it is purely most-recent-first', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', updatedAt: '2026-09-10T00:00:00.000Z' }),
      card({ id: 'c2', sessionId: 'bbbb2222', updatedAt: '2026-09-14T00:00:00.000Z' }),
    ]);
    expect(selectMentionCandidates(board, {}).sessions.map((c) => c.id)).toEqual(['bbbb2222', 'aaaa1111']);
  });
});

describe('self reference', () => {
  test('the current session is flagged and can never outrank a usable row', () => {
    const board = sessionsOf([
      card({ id: 'c1', sessionId: 'aaaa1111', updatedAt: '2026-09-14T00:00:00.000Z', projectDir: '/here' }),
      card({ id: 'c2', sessionId: 'bbbb2222', updatedAt: '2026-09-10T00:00:00.000Z', projectDir: '/other' }),
    ]);

    const rows = selectMentionCandidates(board, {
      excludeSessionIds: ['aaaa1111'],
      currentProjectDir: '/here',
    }).sessions;

    expect(rows.map((c) => c.id)).toEqual(['bbbb2222', 'aaaa1111']);
    expect(rows[0].disabledReason).toBeUndefined();
    expect(rows[1].disabledReason).toBe('self');
  });

  test('a self row never pushes a selectable row out of the limit', () => {
    const cards = Array.from({ length: 3 }, (_, i) => card({
      id: `c${i}`,
      sessionId: `sess${i}aa`,
      updatedAt: `2026-09-1${i}T00:00:00.000Z`,
    }));
    // sess2aa 가 가장 최근이지만 자기 자신이다.
    const rows = selectMentionCandidates(sessionsOf(cards), { excludeSessionIds: ['sess2aa'], limit: 2 }).sessions;

    expect(rows.map((c) => c.id)).toEqual(['sess1aa', 'sess0aa']);
  });
});

describe('works', () => {
  const works = [
    work({ id: 'w1', title: 'Telegram 연동 안정화', updatedAt: '2026-09-14T00:00:00.000Z', sessionLinks: [
      { sessionId: 'aaaa1111', linkedAt: '2026-09-10T00:00:00.000Z' },
      { sessionId: 'bbbb2222', linkedAt: '2026-09-10T00:00:00.000Z' },
    ] }),
    work({ id: 'w2', title: '위키 파이프라인', updatedAt: '2026-09-12T00:00:00.000Z', summary: {
      lines: ['폴러 중복을 messageId dedup으로 정리', '두 번째 줄'],
      generatedAt: '2026-09-12T00:00:00.000Z',
      model: 'claude-opus-5',
    } }),
    work({ id: 'w3', title: '스케줄러', updatedAt: '2026-09-11T00:00:00.000Z', notes: '크론 표현식 파서 정리' }),
  ];

  test('matches title, summary lines and notes', () => {
    const found = (q: string) => selectMentionCandidates(pool({ works }), { q }).works.map((c) => c.id);

    expect(found('telegram')).toEqual(['w1']);
    expect(found('dedup')).toEqual(['w2']);
    expect(found('크론')).toEqual(['w3']);
  });

  test('a summary or notes hit is reported as a description snippet', () => {
    const [candidate] = selectMentionCandidates(pool({ works }), { q: '크론' }).works;
    expect(candidate.snippet).toEqual({ field: 'description', text: '크론 표현식 파서 정리' });
  });

  test('carries status and a session count sublabel', () => {
    const [candidate] = selectMentionCandidates(pool({ works }), { q: 'telegram' }).works;
    expect(candidate.label).toBe('Telegram 연동 안정화');
    expect(candidate.status).toBe('active');
    expect(candidate.sublabel).toBe('세션 2개');
  });
});

describe('docs', () => {
  const docs: DocEntry[] = [
    { path: 'troubleshooting/telegram-poller-dup.md', title: 'Telegram 폴러 중복 카드', updatedAt: '2026-09-12T00:00:00.000Z' },
    { path: 'howto/wiki-backfill.md', updatedAt: '2026-09-13T00:00:00.000Z' },
  ];

  test('matches the file name and the vault-relative path', () => {
    const found = (q: string) => selectMentionCandidates(pool({ docs }), { q }).docs.map((c) => c.id);

    expect(found('poller')).toEqual(['troubleshooting/telegram-poller-dup.md']);
    expect(found('howto/')).toEqual(['howto/wiki-backfill.md']);
  });

  test('the snippet field is path and the label falls back to the file name', () => {
    const [candidate] = selectMentionCandidates(pool({ docs }), { q: 'wiki-backfill' }).docs;
    expect(candidate.snippet!.field).toBe('path');
    expect(candidate.label).toBe('wiki-backfill');
    expect(candidate.sublabel).toBe('howto');
  });

  test('the id is a token-safe path that round-trips through the parser', () => {
    const [candidate] = selectMentionCandidates(
      pool({ docs: [{ path: 'AI_GENERATED/(2026-09-14) - 멘션 참조 설계.md' }] }),
      { q: '멘션' },
    ).docs;

    expect(candidate.id).toBe(encodeDocIdForToken('AI_GENERATED/(2026-09-14) - 멘션 참조 설계.md'));
    expect(candidate.id).not.toMatch(/[^A-Za-z0-9_\-./%]/);

    const [token] = parseMentionTokens(`@doc:${candidate.id}`);
    expect(token.id).toBe('AI_GENERATED/(2026-09-14) - 멘션 참조 설계.md');
  });
});

describe('kind filter and limit', () => {
  const fullPool = pool({
    sessions: buildSessionCandidateSources([card({ id: 'c1', sessionId: 'aaaa1111', description: '텔레그램' })]),
    works: [work({ id: 'w1', title: '텔레그램 연동' })],
    docs: [{ path: 'troubleshooting/텔레그램.md' }],
  });

  test('all returns every group', () => {
    const result = selectMentionCandidates(fullPool, { q: '텔레그램', kind: 'all' });
    expect([result.sessions.length, result.works.length, result.docs.length]).toEqual([1, 1, 1]);
  });

  test('a kind narrows to that group only', () => {
    const result = selectMentionCandidates(fullPool, { q: '텔레그램', kind: 'work' });
    expect([result.sessions.length, result.works.length, result.docs.length]).toEqual([0, 1, 0]);
  });

  test('the limit is per kind and defaults to 8', () => {
    const many = sessionsOf(
      Array.from({ length: 12 }, (_, i) => card({ id: `c${i}`, sessionId: `sess${i}aaa` })),
    );

    expect(selectMentionCandidates(many, {}).sessions.length).toBe(DEFAULT_MENTION_LIMIT);
    expect(selectMentionCandidates(many, { limit: 3 }).sessions.length).toBe(3);
  });
});
