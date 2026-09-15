import { parseMentionTokens, type MentionKind } from '../../../../src/core/mention-reference';

/**
 * 캐럿 기준 `@` 구간 계산과 본문 치환 (순수 함수).
 *
 * 본문 텍스트가 참조의 단일 진실이므로 여기서 하는 일은 전부 **문자열 수술**이다
 * — 선택하면 구간을 토큰으로 갈아끼우고, 칩의 `×`는 본문에서 토큰을 도려낸다.
 * 별도의 `references[]` state가 없으니 desync가 구조적으로 불가능하다.
 *
 * 토큰 문법·앞 문자 가드의 단일 소스는 `src/core/mention-reference.ts`다. 이
 * 모듈은 그 규칙의 **역방향**(만들기·지우기)만 담당한다.
 */

export interface ActiveMention {
  /** `@`의 인덱스. */
  start: number;
  /** 캐럿 위치(= 구간의 끝, exclusive). */
  end: number;
  /** `@`와 캐럿 사이 문자열. 빈 문자열이면 방금 `@`만 친 상태다. */
  query: string;
}

/**
 * 검색어로 인정하는 최대 길이.
 *
 * 이 선이 없으면 문단 위쪽에 남아 있던 옛날 `@` 하나 때문에 한참 뒤에서 타이핑
 * 하는 내내 팝오버가 떠 있게 된다.
 */
export const MAX_MENTION_QUERY_LENGTH = 40;

/**
 * `@` 바로 앞에 올 수 있는 문자: 문자열 시작 · 공백/개행 · `(` · `[`.
 * `mention-reference.ts`의 `TOKEN_BOUNDARY_RE`와 같은 집합이며, 이것이
 * `junyeong@naverz-corp.com`에서 팝오버가 뜨지 않는 이유다.
 */
const BOUNDARY_RE = /[\s([]/;

/** 토큰 ID에 그대로 실을 수 있는 문자 — core의 `MENTION_TOKEN_RE` 문자 집합. */
const TOKEN_UNSAFE_RE = /[^A-Za-z0-9_\-./]/g;

/**
 * 캐럿 왼쪽에서 가장 가까운 `@`를 찾아 활성 멘션 구간을 돌려준다. 없으면 `null`.
 *
 * 중단 조건 네 가지 — 하나라도 걸리면 팝오버를 띄우지 않는다:
 *
 * | 조건 | 예 |
 * |---|---|
 * | `@` 앞 문자가 시작/공백/`(`/`[` 가 아님 | `junyeong@naverz-corp.com` |
 * | 구간이 `MAX_MENTION_QUERY_LENGTH` 초과 | 문단 위쪽에 남은 옛날 `@` |
 * | 구간에 개행 포함 | `@` 치고 엔터 |
 * | 구간에 `:` 포함 | `@session:kx9f2a1b` — 이미 완성된 토큰 |
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null;

  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0) return null;

  const previous = start > 0 ? text[start - 1] : '';
  if (previous && !BOUNDARY_RE.test(previous)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length > MAX_MENTION_QUERY_LENGTH) return null;
  if (/[\r\n]/.test(query)) return null;
  // 완성된 토큰 위에 캐럿이 있는 것뿐이다 — 다시 검색을 시작할 이유가 없다.
  if (query.includes(':')) return null;

  return { start, end: caret, query };
}

/**
 * 토큰 ID를 본문에 실을 수 있는 형태로 인코딩한다.
 *
 * 경로 구분자 `/`와 `.`·`-`·`_`는 그대로 둔다 — 토큰은 사람이 읽는 본문 안에
 * 남으므로 `@doc:troubleshooting/telegram-poller-dup.md`가 읽혀야 한다. 나머지
 * (공백·한글·괄호…)는 퍼센트 인코딩한다. `encodeURIComponent`를 쓰지 않는 이유는
 * 그것이 `(`·`)`·`!`·`*`·`'`를 남겨 두는데, 그 문자들이 core의 토큰 문자 집합에는
 * 없어서 결국 파싱되지 않는 토큰이 되기 때문이다.
 */
export function encodeMentionTokenId(id: string): string {
  const encoder = new TextEncoder();
  return id.replace(TOKEN_UNSAFE_RE, (char) =>
    Array.from(encoder.encode(char))
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(''),
  );
}

/** `@session:kx9f2a1b` 같은 본문 토큰 문자열. */
export function buildMentionToken(kind: MentionKind, id: string): string {
  return `@${kind}:${encodeMentionTokenId(id)}`;
}

export interface MentionEdit {
  next: string;
  caret: number;
}

/**
 * 활성 구간을 토큰으로 치환하고 뒤에 공백 하나를 붙인다.
 *
 * 공백은 장식이 아니다 — 없으면 이어서 친 글자가 토큰 ID에 그대로 흡수된다
 * (`@session:kx9f2a1b` + `그` → `@session:kx9f2a1b그`는 여전히 토큰 문법에
 * 맞는다). 단, 바로 뒤가 이미 공백이면 두 칸이 되지 않게 넣지 않는다.
 */
export function replaceActiveMention(
  text: string,
  active: ActiveMention,
  token: string,
): MentionEdit {
  const tail = text.slice(active.end);
  const needsSpace = !tail.startsWith(' ');
  const inserted = needsSpace ? `${token} ` : token;
  return {
    next: text.slice(0, active.start) + inserted + tail,
    caret: active.start + inserted.length,
  };
}

/**
 * 본문에서 토큰 하나를 지운다 — 칩의 `×`가 하는 일 전부다.
 *
 * `raw`가 여러 번 나오면 첫 등장만 지운다. `parseMentionTokens`가 중복을 이미
 * 접어 두므로 칩은 어차피 하나뿐이고, 두 번째 등장은 남은 칩이 계속 가리킨다.
 * 토큰을 들어내면서 양옆 공백이 붙어 두 칸이 되는 것도 함께 정리한다.
 */
export function removeMentionToken(text: string, raw: string): MentionEdit {
  const token = parseMentionTokens(text).find((candidate) => candidate.raw === raw);
  if (!token) return { next: text, caret: text.length };

  const head = text.slice(0, token.start);
  let tail = text.slice(token.end);
  // 토큰 앞에 공백이 있으면 뒤따르는 공백 하나를 흡수한다. 앞이 줄 시작이면
  // 반대로 뒤쪽 공백을 버려야 다음 단어가 들여쓰기된 것처럼 보이지 않는다.
  if (/[^\S\r\n]$/.test(head) && tail.startsWith(' ')) {
    tail = tail.slice(1);
  } else if (!head || /[\r\n]$/.test(head)) {
    tail = tail.replace(/^[^\S\r\n]+/, '');
  }
  return { next: head + tail, caret: head.length };
}
