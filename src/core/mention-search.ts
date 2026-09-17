import { stripReferenceBlock, type MentionKind } from './mention-reference';
import type { AgentRuntime, KanbanCard, Work } from './types';

/**
 * `@` 멘션 후보 검색 (순수 함수).
 *
 * `work-list.ts`의 `selectWorks`와 같은 위치·같은 성격이다 — 라우트는 데이터를
 * 모아 넘기기만 하고, 규칙은 전부 여기에 있다. 풀은 **현재 보드**(`active.json`)
 * 와 `works.json`, wiki vault 스캔 결과로만 이뤄진다. 아카이브(71MB·9,483장)는
 * 어느 경로로도 읽지 않는다 — 지나간 작업의 참조는 `@doc:`이 담당한다.
 *
 * 이 모듈이 제목만 보지 않는 이유는 실측이다: 현재 보드에서 세션 보유 카드의
 * **제목**으로 `텔레그램`·`works`·`위키`·`폴러`를 찾으면 전부 0건이고,
 * `description`·`result`까지 보면 5·22·5·1건이다. 제목 매칭만 구현하면 이
 * 기능은 아무것도 찾지 못한다.
 */

/** 탭별 기본 노출 개수. */
export const DEFAULT_MENTION_LIMIT = 8;

/** 토큰에 박히는 세션 ID 접두사 길이 (§4 — UUID 36자는 본문에서 읽을 수 없다). */
export const SESSION_ID_TOKEN_LENGTH = 8;

/** 스니펫이 매칭 구간 앞뒤로 보여주는 문맥 길이. */
const SNIPPET_CONTEXT = 40;

/**
 * 카드 제목을 그대로 라벨로 쓰기 위한 최소 길이.
 *
 * 보드 실측에서 카드 제목은 `test` · `UI 수정` 수준이고 `sessionTitle` 보유
 * 카드는 0건이다. 이 길이를 넘지 못하는 제목은 사람이 그 세션을 알아볼 근거가
 * 못 되므로 `description` 첫 줄로 한 단계 내려간다.
 */
const MIN_TITLE_LABEL_LENGTH = 40;

/** `description` 첫 줄을 라벨로 쓸 때의 절단 길이. */
const DESCRIPTION_LABEL_LENGTH = 60;

/** 라벨로서 아무 정보가 없는 제목 — 훅이 찍는 알림 본문이다. */
const MEANINGLESS_TITLE_PREFIXES = ['<task-notification>'];

export interface MentionCandidate {
  kind: MentionKind;
  id: string;              // 토큰에 박힐 값 (세션은 8자 접두사)
  label: string;           // 행 제목 — 폴백 체인으로 만든다
  status?: string;
  agentRuntime?: AgentRuntime;
  projectDir?: string;
  updatedAt: string;
  sublabel?: string;       // '세션 4개 · 카드 11개' 등
  /** 검색 시 매칭된 위치의 앞뒤 문맥 (±40자). 어느 필드에서 걸렸는지도 담는다. */
  snippet?: { field: 'title' | 'description' | 'result' | 'path'; text: string };
  disabledReason?: 'self';
}

export interface MentionSearchInput {
  q?: string;
  kind?: MentionKind | 'all';
  limit?: number;              // 기본 8, kind별
  currentProjectDir?: string;  // 이 디렉토리 항목을 먼저 정렬
  excludeSessionIds?: string[];  // 자기 참조 제외 — 카드가 아니라 세션 단위로 건다
}

/** 한 세션과 그 세션에 붙은 보드 카드 전부. 카드가 여러 장이어도 행은 하나다. */
export interface SessionCandidateSource {
  sessionId: string;
  cards: KanbanCard[];
}

/** wiki vault 스캔 한 건. `path`는 vault 상대 경로다. */
export interface DocEntry {
  path: string;
  title?: string;
  updatedAt?: string;   // 파일 mtime (ISO 8601)
}

export interface MentionSearchPool {
  sessions: SessionCandidateSource[];
  works: Work[];
  docs: DocEntry[];
}

export interface MentionSearchResult {
  sessions: MentionCandidate[];
  works: MentionCandidate[];
  docs: MentionCandidate[];
}

/** `GET /api/mentions` 응답. `totals`는 `limit`으로 자르기 **전** 개수다. */
export interface MentionSearchResponse {
  q: string;
  groups: MentionSearchResult;
  totals: { sessions: number; works: number; docs: number };
}

type SnippetField = NonNullable<MentionCandidate['snippet']>['field'];

/**
 * 피드백 카드의 생성 헤더를 걷어낸다.
 *
 * `App.tsx`의 `handleCreateFeedback`이 본문 앞에 붙이는
 * `[Feedback for: …]` / `[Original Card ID: …]` / `[Original Result: …]` + `---`
 * 블록이다(현재 보드에 27장). 이걸 그대로 색인하면 **부모 카드의 내용으로 자식
 * 피드백 카드가 검색에 걸려** 같은 결과가 두 번 뜬다.
 *
 * `[Original Result: …]`는 부모 `result` 200자를 그대로 싣기 때문에 줄바꿈을
 * 품을 수 있다. 그래서 "대괄호로 시작한 줄"이 아니라 "대괄호가 닫힐 때까지"를
 * 한 항목으로 소비한다 — 줄 단위로 지우면 발췌의 둘째 줄부터가 본문에 남는다.
 */
export function splitFeedbackHeader(text: string): { header: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !/^\[(Feedback for|Original Card ID|Original Result):/.test(lines[i])) {
    return { header: '', body: text };
  }

  while (i < lines.length && lines[i].startsWith('[')) {
    while (i < lines.length && !lines[i].trimEnd().endsWith(']')) i++;
    i++;
  }
  if (i < lines.length && lines[i].trim() === '---') i++;
  return {
    header: lines.slice(0, i).join('\n').trim(),
    body: lines.slice(i).join('\n').replace(/^\s+/, ''),
  };
}

export function stripFeedbackHeader(text: string): string {
  return splitFeedbackHeader(text).body;
}

/**
 * `Feedback: ` / `Feedback #N: ` 접두사를 모두 벗겨 원본 제목을 돌려준다.
 * 웹의 `extractFeedbackBase`와 같은 규칙 — 그쪽은 누적 깊이까지 세지만,
 * 검색이 필요한 건 원본 제목뿐이다.
 */
export function stripFeedbackTitlePrefix(title: string): string {
  let base = title;
  for (;;) {
    const numbered = base.match(/^Feedback #(\d+):\s*/);
    if (numbered) {
      base = base.slice(numbered[0].length);
      continue;
    }
    if (base.startsWith('Feedback: ')) {
      base = base.slice('Feedback: '.length);
      continue;
    }
    return base.trim();
  }
}

/** 카드 본문에서 검색 대상이 되는 부분 — 참조 블록과 피드백 헤더를 걷어낸 것. */
function searchableDescription(card: KanbanCard): string {
  return stripFeedbackHeader(stripReferenceBlock(card.description ?? ''));
}

/**
 * 보드 카드를 세션 단위로 묶는다. `sessionId`가 없거나 소프트 삭제된 카드는
 * 후보가 아니다 — 실행되지 않은 todo에는 참조할 내용 자체가 없다.
 */
export function buildSessionCandidateSources(cards: KanbanCard[]): SessionCandidateSource[] {
  const grouped = new Map<string, KanbanCard[]>();
  for (const card of cards) {
    if (!card.sessionId || card.deletedAt) continue;
    const bucket = grouped.get(card.sessionId);
    if (bucket) bucket.push(card);
    else grouped.set(card.sessionId, [card]);
  }
  return [...grouped.entries()].map(([sessionId, sessionCards]) => ({ sessionId, cards: sessionCards }));
}

/**
 * doc 경로를 토큰에 박을 수 있는 형태로 만든다.
 *
 * `MENTION_TOKEN_RE`가 허용하는 문자는 `[A-Za-z0-9_\-./%]`뿐인데 vault 문서명은
 * 한글·공백·괄호를 흔히 쓴다. `encodeURIComponent`는 `!'()*~`를 남겨 두므로
 * 남은 것들은 직접 퍼센트 인코딩한다. 디코딩은 `parseMentionTokens`가 한다.
 */
export function encodeDocIdForToken(path: string): string {
  return path.replace(/[^A-Za-z0-9_\-./]/g, (char) => {
    const encoded = encodeURIComponent(char);
    if (encoded !== char) return encoded;
    return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function instant(iso: string | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 최근 갱신이 먼저. 같으면 id로 총순서를 만든다(`work-list.ts`와 같은 규약). */
function byRecency(a: MentionCandidate, b: MentionCandidate): number {
  const diff = instant(b.updatedAt) - instant(a.updatedAt);
  return diff !== 0 ? diff : a.id.localeCompare(b.id);
}

function makeSnippet(field: SnippetField, source: string, needle: string): MentionCandidate['snippet'] {
  const index = source.toLowerCase().indexOf(needle);
  if (index < 0) return undefined;
  const from = Math.max(0, index - SNIPPET_CONTEXT);
  const to = Math.min(source.length, index + needle.length + SNIPPET_CONTEXT);
  const body = source.slice(from, to).replace(/\s+/g, ' ').trim();
  return { field, text: `${from > 0 ? '…' : ''}${body}${to < source.length ? '…' : ''}` };
}

/**
 * 매칭 필드가 여러 개면 하나만 보여준다. 우선순위는 `title → description → result`
 * — 사용자가 기억하는 건 대개 자기가 시킨 말이다.
 */
function firstSnippet(
  fields: Array<{ field: SnippetField; text: string }>,
  needle: string,
): MentionCandidate['snippet'] {
  for (const { field, text } of fields) {
    const snippet = makeSnippet(field, text, needle);
    if (snippet) return snippet;
  }
  return undefined;
}

function isMeaninglessTitle(title: string): boolean {
  return MEANINGLESS_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * 세션 행의 제목. 아래 순서로 내려간다:
 *
 * 1. `sessionTitle` — 있으면 최우선 (보드 실측 보유 0건이라 사실상 마지막 수단이다)
 * 2. 피드백 접두사를 벗긴 카드 제목 중 **충분히 긴 것**
 * 3. `description`의 첫 비어있지 않은 줄 60자
 * 4. `세션 <id 8자>`
 *
 * 2·3단계는 세션의 **가장 오래된 카드부터** 훑는다 — 세션을 시작시킨 카드가 그
 * 세션이 무엇이었는지 가장 잘 말한다. 표시 메타(상태·런타임·시각)만 가장 최근
 * 카드에서 가져온다.
 */
function sessionLabel(sessionId: string, oldestFirst: KanbanCard[], newestFirst: KanbanCard[]): string {
  const titled = newestFirst.find((card) => card.sessionTitle?.trim());
  if (titled?.sessionTitle) return titled.sessionTitle.trim();

  for (const card of oldestFirst) {
    const title = stripFeedbackTitlePrefix(card.title ?? '');
    if (title.length >= MIN_TITLE_LABEL_LENGTH && !isMeaninglessTitle(title)) return title;
  }

  for (const card of oldestFirst) {
    const line = firstNonEmptyLine(searchableDescription(card));
    if (!line) continue;
    return line.length > DESCRIPTION_LABEL_LENGTH ? `${line.slice(0, DESCRIPTION_LABEL_LENGTH)}…` : line;
  }

  return `세션 ${sessionId.slice(0, SESSION_ID_TOKEN_LENGTH)}`;
}

function sessionCandidate(
  source: SessionCandidateSource,
  needle: string,
  selfSessions: Set<string>,
): MentionCandidate | undefined {
  const oldestFirst = [...source.cards].sort(
    (a, b) => instant(a.createdAt) - instant(b.createdAt) || a.id.localeCompare(b.id),
  );
  const newestFirst = [...oldestFirst].reverse();
  const latest = newestFirst[0];
  if (!latest) return undefined;

  // 한 세션에 붙은 카드 전체를 합쳐 매칭한다 — 피드백 체인이면 카드가 여러 장이다.
  let snippet: MentionCandidate['snippet'];
  if (needle) {
    const idMatch = source.sessionId.toLowerCase().startsWith(needle);
    const fields: Array<{ field: SnippetField; text: string }> = [];
    for (const card of newestFirst) fields.push({ field: 'title', text: card.title ?? '' });
    for (const card of newestFirst) fields.push({ field: 'description', text: searchableDescription(card) });
    for (const card of newestFirst) fields.push({ field: 'result', text: card.result ?? '' });
    snippet = firstSnippet(fields, needle);
    if (!snippet && !idMatch) return undefined;
  }

  const cardCount = source.cards.length;
  return {
    kind: 'session',
    id: source.sessionId.slice(0, SESSION_ID_TOKEN_LENGTH),
    label: sessionLabel(source.sessionId, oldestFirst, newestFirst),
    status: latest.status,
    agentRuntime: latest.agentRuntime,
    projectDir: latest.projectDir,
    updatedAt: latest.updatedAt,
    sublabel: `카드 ${cardCount}장`,
    ...(snippet ? { snippet } : {}),
    ...(selfSessions.has(source.sessionId) ? { disabledReason: 'self' as const } : {}),
  };
}

function workCandidate(work: Work, needle: string): MentionCandidate | undefined {
  const summary = (work.summary?.lines ?? []).join('\n');
  let snippet: MentionCandidate['snippet'];
  if (needle) {
    snippet = firstSnippet(
      [
        { field: 'title', text: work.title ?? '' },
        { field: 'description', text: [summary, work.notes ?? ''].filter(Boolean).join('\n') },
      ],
      needle,
    );
    if (!snippet) return undefined;
  }

  const sessionCount = work.sessionLinks?.length ?? 0;
  return {
    kind: 'work',
    id: work.id,
    label: work.title,
    status: work.status,
    projectDir: work.projectDir,
    updatedAt: work.updatedAt,
    sublabel: `세션 ${sessionCount}개`,
    ...(snippet ? { snippet } : {}),
  };
}

function docBaseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

function docDirectory(path: string): string | undefined {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : undefined;
}

function docCandidate(doc: DocEntry, needle: string): MentionCandidate | undefined {
  let snippet: MentionCandidate['snippet'];
  if (needle) {
    // 파일명과 상대경로가 곧 검색 대상이다 — 본문은 읽지 않는다(1,572개 glob).
    snippet = firstSnippet([{ field: 'path', text: doc.path }], needle);
    if (!snippet && !(doc.title ?? '').toLowerCase().includes(needle)) return undefined;
  }

  return {
    kind: 'doc',
    id: encodeDocIdForToken(doc.path),
    label: doc.title?.trim() || docBaseName(doc.path),
    updatedAt: doc.updatedAt ?? '',
    sublabel: docDirectory(doc.path),
    ...(snippet ? { snippet } : {}),
  };
}

/**
 * 정렬: ① 선택 불가(자기 참조)는 맨 뒤 → ② `currentProjectDir` 일치 우선 →
 * ③ `updatedAt` 내림차순 → ④ id.
 *
 * 자기 참조를 먼저 떨어뜨리는 이유는 `limit`이다. 행 자체는 남겨 UI가 "현재
 * 세션"이라고 말해 줄 수 있어야 하지만, 고를 수 없는 행이 고를 수 있는 행을
 * 목록 밖으로 밀어내면 안 된다.
 */
function sortCandidates(candidates: MentionCandidate[], currentProjectDir?: string): MentionCandidate[] {
  return candidates.sort((a, b) => {
    const disabled = Number(Boolean(a.disabledReason)) - Number(Boolean(b.disabledReason));
    if (disabled !== 0) return disabled;
    if (currentProjectDir) {
      const match = Number(b.projectDir === currentProjectDir) - Number(a.projectDir === currentProjectDir);
      if (match !== 0) return match;
    }
    return byRecency(a, b);
  });
}

export function selectMentionCandidates(
  pool: MentionSearchPool,
  input: MentionSearchInput,
): MentionSearchResult {
  const needle = (input.q ?? '').trim().toLowerCase();
  const kind = input.kind ?? 'all';
  const limit = Math.max(0, input.limit ?? DEFAULT_MENTION_LIMIT);
  const selfSessions = new Set(input.excludeSessionIds ?? []);

  const wants = (target: MentionKind) => kind === 'all' || kind === target;
  const take = (candidates: MentionCandidate[]) =>
    sortCandidates(candidates, input.currentProjectDir).slice(0, limit);

  const sessions = wants('session')
    ? take(
      (pool.sessions ?? [])
        .map((source) => sessionCandidate(source, needle, selfSessions))
        .filter((candidate): candidate is MentionCandidate => Boolean(candidate)),
    )
    : [];

  const works = wants('work')
    ? take(
      (pool.works ?? [])
        .map((work) => workCandidate(work, needle))
        .filter((candidate): candidate is MentionCandidate => Boolean(candidate)),
    )
    : [];

  const docs = wants('doc')
    ? take(
      (pool.docs ?? [])
        .map((doc) => docCandidate(doc, needle))
        .filter((candidate): candidate is MentionCandidate => Boolean(candidate)),
    )
    : [];

  return { sessions, works, docs };
}
