import { describe, expect, test } from 'bun:test';
import { parseMentionTokens } from '../../../../src/core/mention-reference';
import {
  MAX_MENTION_QUERY_LENGTH,
  buildMentionToken,
  encodeMentionTokenId,
  findActiveMention,
  removeMentionToken,
  replaceActiveMention,
} from './mentionCaret';

describe('findActiveMention', () => {
  test('`@` 직후 — 빈 검색어로 구간이 열린다', () => {
    const text = '참고: @';
    expect(findActiveMention(text, text.length)).toEqual({ start: 4, end: 5, query: '' });
  });

  test('검색어를 이어 치면 구간이 늘어난다', () => {
    const text = '참고: @텔레그램';
    expect(findActiveMention(text, text.length)).toEqual({
      start: 4,
      end: text.length,
      query: '텔레그램',
    });
  });

  test('문자열 맨 앞의 `@`도 연다', () => {
    expect(findActiveMention('@abc', 4)).toEqual({ start: 0, end: 4, query: 'abc' });
  });

  test('`(` 와 `[` 뒤의 `@`도 연다', () => {
    expect(findActiveMention('(@abc', 5)?.query).toBe('abc');
    expect(findActiveMention('[@abc', 5)?.query).toBe('abc');
  });

  test('캐럿이 구간 중간에 있으면 거기까지만 검색어다', () => {
    const text = '@telegram';
    expect(findActiveMention(text, 5)).toEqual({ start: 0, end: 5, query: 'tele' });
  });

  // ── 중단 조건 4종 ────────────────────────────────────────────────
  test('중단 ①: `@` 앞 문자가 경계가 아니면 열지 않는다 (이메일)', () => {
    const text = 'junyeong@naverz-corp.com';
    expect(findActiveMention(text, text.length)).toBeNull();
  });

  test('중단 ②: 구간이 40자를 넘으면 열지 않는다 (문단 위의 옛날 `@`)', () => {
    const text = `@${'가'.repeat(MAX_MENTION_QUERY_LENGTH + 1)}`;
    expect(findActiveMention(text, text.length)).toBeNull();
    // 딱 40자는 아직 살아 있다.
    const edge = `@${'가'.repeat(MAX_MENTION_QUERY_LENGTH)}`;
    expect(findActiveMention(edge, edge.length)?.query.length).toBe(MAX_MENTION_QUERY_LENGTH);
  });

  test('중단 ③: 구간에 개행이 있으면 닫는다 (`@` 치고 엔터)', () => {
    const text = '@검색\n다음 줄';
    expect(findActiveMention(text, text.length)).toBeNull();
  });

  test('중단 ④: 구간에 `:` 가 있으면 닫는다 (이미 완성된 토큰)', () => {
    const text = '참고: @session:kx9f2a1b';
    expect(findActiveMention(text, text.length)).toBeNull();
  });

  test('`@` 가 없으면 null', () => {
    expect(findActiveMention('그냥 문장', 5)).toBeNull();
  });

  test('캐럿 오른쪽의 `@` 는 보지 않는다', () => {
    expect(findActiveMention('앞 @tail', 2)).toBeNull();
  });
});

describe('replaceActiveMention', () => {
  test('구간을 토큰으로 갈고 캐럿을 토큰 뒤 공백 다음에 둔다', () => {
    const text = '참고: @텔레';
    const active = findActiveMention(text, text.length);
    expect(active).not.toBeNull();
    const { next, caret } = replaceActiveMention(text, active!, '@session:kx9f2a1b');
    expect(next).toBe('참고: @session:kx9f2a1b ');
    expect(caret).toBe(next.length);
    expect(next[caret - 1]).toBe(' ');
  });

  test('뒤 문장은 보존되고 캐럿은 삽입분 끝에 선다', () => {
    const text = '@텔레 나머지 문장';
    const active = findActiveMention(text, 4)!;
    const { next, caret } = replaceActiveMention(text, active, '@work:wTg4hN2');
    expect(next).toBe('@work:wTg4hN2 나머지 문장');
    expect(next.slice(caret)).toBe('나머지 문장');
  });

  test('바로 뒤가 이미 공백이면 두 칸을 만들지 않는다', () => {
    const text = '@텔레 뒤';
    const active = { start: 0, end: 3, query: '텔레' };
    const { next } = replaceActiveMention(text, active, '@doc:a.md');
    expect(next).toBe('@doc:a.md 뒤');
  });

  test('치환 결과는 core 파서가 토큰으로 읽어낸다', () => {
    const text = '참고: @텔레';
    const active = findActiveMention(text, text.length)!;
    const { next } = replaceActiveMention(text, active, buildMentionToken('session', 'kx9f2a1b'));
    const tokens = parseMentionTokens(next);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'session', id: 'kx9f2a1b' });
  });
});

describe('encodeMentionTokenId', () => {
  test('경로 구분자와 `.`·`-`·`_` 는 읽히도록 그대로 둔다', () => {
    expect(encodeMentionTokenId('troubleshooting/telegram-poller_dup.md'))
      .toBe('troubleshooting/telegram-poller_dup.md');
  });

  test('공백·한글·괄호는 퍼센트 인코딩한다', () => {
    expect(encodeMentionTokenId('a b')).toBe('a%20b');
    expect(encodeMentionTokenId('(x)')).toBe('%28x%29');
    expect(encodeMentionTokenId('가')).toBe('%EA%B0%80');
  });

  test('`%` 자신도 인코딩해 왕복이 깨지지 않는다', () => {
    const encoded = encodeMentionTokenId('50%.md');
    expect(encoded).toBe('50%25.md');
    expect(decodeURIComponent(encoded)).toBe('50%.md');
  });

  test('공백 있는 문서 경로도 core 파서를 통과하고 원본으로 디코딩된다', () => {
    const path = 'AI GENERATED/(2026-09-14) - 설계.md';
    const token = buildMentionToken('doc', path);
    const [parsed] = parseMentionTokens(token);
    expect(parsed?.id).toBe(path);
  });
});

describe('removeMentionToken', () => {
  test('토큰과 뒤따르는 공백 하나를 함께 지운다', () => {
    const text = '참고: @session:kx9f2a1b 그리고 나머지';
    const { next } = removeMentionToken(text, '@session:kx9f2a1b');
    expect(next).toBe('참고: 그리고 나머지');
  });

  test('줄 맨 앞의 토큰을 지우면 다음 단어가 들여쓰기되지 않는다', () => {
    const text = '첫 줄\n@work:wTg4hN2 둘째 줄';
    const { next } = removeMentionToken(text, '@work:wTg4hN2');
    expect(next).toBe('첫 줄\n둘째 줄');
  });

  test('남은 토큰은 그대로 있고 칩도 그대로 남는다', () => {
    const text = '@session:kx9f2a1b @work:wTg4hN2';
    const { next } = removeMentionToken(text, '@session:kx9f2a1b');
    expect(parseMentionTokens(next).map((token) => token.raw)).toEqual(['@work:wTg4hN2']);
  });

  test('없는 토큰이면 본문을 건드리지 않는다', () => {
    const text = '참고: @session:kx9f2a1b';
    expect(removeMentionToken(text, '@work:nope').next).toBe(text);
  });

  test('캐럿은 지워진 자리에 남는다', () => {
    const text = '앞 @doc:a.md 뒤';
    const { next, caret } = removeMentionToken(text, '@doc:a.md');
    expect(next).toBe('앞 뒤');
    expect(next.slice(caret)).toBe('뒤');
  });
});
