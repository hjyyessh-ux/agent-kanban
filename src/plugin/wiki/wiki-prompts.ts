import type { KanbanCard, WikiDocType } from '../../core/types';
import { WIKI_INTERNAL_MARKER } from '../../core/types';

export const WIKI_DOC_TYPES: WikiDocType[] = [
  'troubleshooting',
  'howto',
  'decision',
  'concept',
  'reference',
];

/** One wiki processing unit: all archived cards that share a session. */
export interface WikiSourceGroup {
  key: string;             // sessionId, or `card:<id>` for sessionless cards
  sessionId?: string;
  sessionTitle?: string;
  projectDir?: string;
  cards: KanbanCard[];     // sorted by createdAt ascending
  transcript?: string;     // optional enrichment from the runtime transcript
}

export interface TriageResult {
  decision: 'keep' | 'skip';
  reason: string;
  confidence: number;
}

export interface ClassifyResult {
  type: WikiDocType;
  title: string;
  slug: string;
  topics: string[];
  summary: string;
  body: string;
}

const DESCRIPTION_MAX = 3000;
const RESULT_MAX = 5000;
const PROGRESS_MAX = 1000;

// Re-exported from core so existing importers (chat-message.ts, wiki-sweep.ts,
// tests) keep their import path. The canonical definition lives in core/types.
export { WIKI_INTERNAL_MARKER };

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

/** Render a session group as the source material both prompts share. */
export function buildGroupContext(group: WikiSourceGroup): string {
  const lines: string[] = [
    `세션 제목: ${group.sessionTitle?.trim() || '(제목 없음)'}`,
    `프로젝트: ${group.projectDir ?? '-'}`,
    `카드 수: ${group.cards.length}`,
    '',
  ];

  group.cards.forEach((card, i) => {
    lines.push(`### 카드 ${i + 1}: ${card.title}`);
    if (card.description.trim()) {
      lines.push(`요청:\n${truncate(card.description.trim(), DESCRIPTION_MAX)}`);
    }
    if (card.result?.trim()) {
      lines.push(`결과:\n${truncate(card.result.trim(), RESULT_MAX)}`);
    } else if (card.progressSummary?.trim()) {
      lines.push(`진행 요약:\n${truncate(card.progressSummary.trim(), PROGRESS_MAX)}`);
    }
    lines.push('');
  });

  if (group.transcript) {
    lines.push('### 대화 원문 발췌');
    lines.push(group.transcript);
    lines.push('');
  }

  return lines.join('\n');
}

export function buildTriagePrompt(group: WikiSourceGroup): string {
  return `${WIKI_INTERNAL_MARKER}
당신은 AI 에이전트 작업 기록을 지식 위키로 옮길지 선별하는 분류자다.
아래는 하나의 작업 세션에서 나온 칸반 카드 기록이다.

[작업 기록]
${buildGroupContext(group)}

이 기록이 장기 보존 가치가 있는 지식인지 판단하라.

skip 기준 (하나라도 강하게 해당하면 skip):
- 단순 실행 지시(빌드/테스트/배포 실행 등)라서 재사용할 지식이 없음
- 일회성 오타 수정, 사소한 변경이라 서사가 없음
- 결과가 비어 있거나 실패로 끝나 배울 내용이 없음
- 특정 시점에만 유효한 일회성 상태 확인/조회

keep 기준:
- 문제 → 원인 → 해결 서사가 있는 트러블슈팅
- 재사용 가능한 절차, 명령어, 설정 방법
- 설계·기술 선택과 그 근거
- 도메인 지식이나 시스템 구조에 대한 이해

판단이 애매하면 keep을 선택하라 (잘못 보존하는 것이 누락보다 낫다).

다음 JSON 한 개만 출력하라. 그 외 텍스트는 절대 출력하지 마라:
{"decision": "keep" 또는 "skip", "reason": "한 문장 이유 (한국어)", "confidence": 0.0에서 1.0 사이 숫자}`;
}

export function buildClassifyPrompt(group: WikiSourceGroup): string {
  return `${WIKI_INTERNAL_MARKER}
당신은 AI 에이전트 작업 기록을 Obsidian 위키 문서로 변환하는 기술 문서 작성자다.
아래 작업 기록 전체를 하나의 위키 문서로 정제하라.

[작업 기록]
${buildGroupContext(group)}

규칙:
- type은 다음 중 하나만: "troubleshooting"(문제→원인→해결), "howto"(재사용 가능한 절차), "decision"(설계/기술 선택과 근거), "concept"(도메인/시스템 지식), "reference"(명령어/설정값/URL 모음)
- title: 한국어, 나중에 검색하기 좋은 구체적인 제목
- slug: 영문 소문자 kebab-case, 60자 이내
- topics: 1~5개의 영문 kebab-case 태그
- summary: 한 문장 요약 (한국어)
- body: 마크다운 본문. 한국어로 쓰되 기술 용어·명령어·코드는 영어 원문 유지. 명령어와 코드는 코드블록으로. H1 제목은 넣지 말 것(시스템이 추가함). 대화를 그대로 옮기지 말고 재사용 가능한 지식만 정제해서 담아라.

다음 JSON 한 개만 출력하라. 그 외 텍스트는 절대 출력하지 마라:
{"type": "...", "title": "...", "slug": "...", "topics": ["..."], "summary": "...", "body": "..."}`;
}

/**
 * Escape literal newlines/tabs/carriage-returns inside JSON string values.
 * gpt-5.5 sometimes emits unescaped control characters in multi-line fields
 * (e.g. `body`), which breaks standard JSON.parse().
 */
function sanitizeJsonLiterals(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { /* ignored */ }
  return JSON.parse(sanitizeJsonLiterals(s));
}

/** Extract the first JSON object from an LLM response (tolerates code fences / prose). */
export function extractJsonObject(text: string): unknown {
  // Strip optional markdown code fences
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  // Try the full stripped text first (direct + sanitized)
  try { return tryParse(stripped); } catch { /* fall through */ }

  // Fall back to first-`{` … last-`}` substring
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in LLM response: ${stripped.slice(0, 200)}`);
  }
  return tryParse(stripped.slice(start, end + 1));
}

export function parseTriageResult(text: string): TriageResult {
  const raw = extractJsonObject(text) as Partial<TriageResult>;
  if (raw.decision !== 'keep' && raw.decision !== 'skip') {
    throw new Error(`Invalid triage decision: ${String(raw.decision)}`);
  }
  return {
    decision: raw.decision,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
  };
}

export function parseClassifyResult(text: string): ClassifyResult {
  const raw = extractJsonObject(text) as Partial<ClassifyResult>;
  if (!raw.type || !WIKI_DOC_TYPES.includes(raw.type)) {
    throw new Error(`Invalid wiki doc type: ${String(raw.type)}`);
  }
  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    throw new Error('Classify result missing title');
  }
  if (typeof raw.body !== 'string' || !raw.body.trim()) {
    throw new Error('Classify result missing body');
  }
  return {
    type: raw.type,
    title: raw.title.trim(),
    slug: typeof raw.slug === 'string' ? raw.slug : raw.title,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t): t is string => typeof t === 'string').slice(0, 5) : [],
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    body: raw.body.trim(),
  };
}
