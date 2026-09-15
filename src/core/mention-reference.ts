import type { AgentRuntime, WorkStatus } from './types';

/**
 * `@` 멘션 참조 — 토큰 파서와 참조 블록 렌더러 (순수 함수).
 *
 * 참조는 **본문 텍스트 안에만** 산다. 카드 모델에는 필드가 하나도 늘지 않고,
 * dispatch 경로도 바뀌지 않는다: 클라이언트가 제출 직전 본문 끝에
 * `appendReferenceBlock()`의 결과를 붙이면, 그 뒤로는 사용자가 직접 타이핑한
 * 텍스트와 구분되지 않는 `description` 문자열일 뿐이다.
 *
 * `core/`에 두는 이유는 `work-list.ts`와 같다 — 웹과 서버가 같은 구현을 써야
 * 하고(웹이 블록을 만들고 서버·에이전트가 그걸 읽는다), 어느 쪽도 이 규칙을
 * 소유하면 안 된다.
 */

export type MentionKind = 'session' | 'work' | 'doc';

/**
 * 본문에 박히는 토큰. 전역 플래그가 붙어 있으므로 `exec` 루프에 그대로 쓰지
 * 말 것 — `lastIndex`가 호출자 사이에 새어 나간다. `parseMentionTokens`는
 * 매번 복제본을 만든다.
 */
export const MENTION_TOKEN_RE = /@(session|work|doc):([A-Za-z0-9_\-./%]+)/g;

/** 한 본문이 실어 보낼 수 있는 참조 개수. 초과분은 렌더에서 잘린다. */
export const MAX_REFERENCES = 8;

export const REFERENCE_BLOCK_OPEN = '<!-- agent-kanban:references v1 — 자동 생성. 수정하지 마세요 -->';
export const REFERENCE_BLOCK_CLOSE = '<!-- /agent-kanban:references -->';

/**
 * `Read`로 그대로 열어도 되는 transcript 크기 상한.
 *
 * 실측 분포상 transcript 536개 중 39개가 이 선을 넘고 최대 28.4MB다. 크기를
 * 적어 주지 않으면 에이전트가 28MB짜리를 `Read`로 열다 실패하므로, 블록의
 * 모든 transcript 줄은 크기와 이 임계 기준 지시를 함께 달고 나간다.
 */
export const TRANSCRIPT_READ_LIMIT_BYTES = 2 * 1024 * 1024;

/** Work 참조가 나열하는 세션 줄의 상한. 초과분은 `… 외 N개`로 접는다. */
const MAX_WORK_SESSION_LINES = 8;

/** `result` 발췌 길이 — `handleCreateFeedback`의 기존 관례와 같은 200자. */
const RESULT_EXCERPT_LIMIT = 200;

/**
 * 토큰 바로 앞에 올 수 있는 문자: 문자열 시작 · 공백 · 개행 · `(` · `[`.
 * 이 가드가 `junyeong@naverz-corp.com` 같은 이메일이 토큰으로 오인되는 것을 막는다.
 */
const TOKEN_BOUNDARY_RE = /[\s([]/;

/** 프로젝트 공통 규약(`scheduling.ts`)과 같은 고정 KST 오프셋. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface MentionToken {
  kind: MentionKind;
  id: string;        // 퍼센트 디코딩된 원본
  raw: string;       // '@session:kx9f2a1b'
  start: number;     // 본문 내 인덱스
  end: number;
}

export type TranscriptMissingReason = 'runtime_unsupported' | 'no_project_dir' | 'file_missing';

/**
 * 찾아낸 transcript 파일의 **형식**. 카드의 `agentRuntime`과 별개다 — 경로 탐색은
 * 파일 존재로 판정하므로 codex 카드가 claude 경로의 파일을 물고 올 수 있고,
 * 블록이 찍는 `jq` 예시는 카드가 아니라 파일 형식을 따라가야 한다.
 */
export type TranscriptFormat = 'claude' | 'codex';

export interface ResolvedReferenceWorkSession {
  sessionId: string;
  agentRuntime?: AgentRuntime;
  transcriptPath?: string;
  /** `statSync(transcriptPath).size` — 없으면 크기 미상으로 렌더한다. */
  transcriptSize?: number;
  transcriptFormat?: TranscriptFormat;
  transcriptMissing?: string;
}

export interface ResolvedReference {
  kind: MentionKind;
  id: string;
  raw: string;
  title: string;
  unresolved?: 'not_found' | 'ambiguous';
  // session (소유 카드의 메타를 함께 싣는다)
  sessionId?: string;
  cardId?: string;
  cardStatus?: string;
  agentRuntime?: AgentRuntime;
  model?: string;
  projectDir?: string;
  startedAt?: string;
  completedAt?: string;
  resultExcerpt?: string;
  transcriptPath?: string;
  /**
   * `statSync(transcriptPath).size`. 렌더에 필수 입력이다 — 이 값이 없으면
   * 블록은 크기 미상으로 표기하고 에이전트에게 먼저 크기를 재라고 지시한다.
   */
  transcriptSize?: number;
  transcriptFormat?: TranscriptFormat;
  transcriptMissing?: TranscriptMissingReason;
  // work
  workStatus?: WorkStatus;
  sessionCount?: number;
  cardCount?: number;
  summaryLines?: string[];
  workSessions?: ResolvedReferenceWorkSession[];
  // doc
  docPath?: string;      // vault 상대
  docAbsPath?: string;
}

/** `GET /api/mentions/resolve` 응답. */
export interface MentionResolveResponse {
  references: ResolvedReference[];
}

/**
 * 블록 머리말. **지시형**이다 — "필요하면 읽으세요"가 아니라 "읽은 뒤에
 * 시작하라"이고, 읽지 못했으면 그 사실을 보고하라고 명령한다. A안(링크만
 * 전달)에서 참조가 실제로 읽히게 만들 수 있는 최대치가 이 문구다.
 */
const BLOCK_HEADER = [
  '## Referenced context — 작업 시작 전 반드시 읽을 것',
  '',
  '사용자가 @ 멘션으로 **명시적으로 지정한 참조**입니다. 본문은 이 블록에',
  '포함돼 있지 않습니다. 아래 각 항목의 경로를 **직접 열어 읽은 뒤에**',
  '본 작업을 시작하세요. 읽지 않고 추측으로 답하지 마세요.',
  '',
  '경로는 절대경로이며 현재 작업 디렉토리 밖일 수 있습니다(의도된 동작).',
  '파일이 존재하지 않으면 그 사실을 사용자에게 보고하고, 같은 항목의',
  '메타데이터(제목·상태·result)만으로 진행하세요.',
  '',
  '**읽기 전략** — 각 transcript 줄 옆에 파일 크기가 적혀 있습니다.',
  '- **2MB 이하** → `Read`로 그대로 열어도 됩니다.',
  '- **2MB 초과** → `Read` 금지. 각 transcript 줄 아래의 형식 설명에 적힌',
  '  `jq` 예시로 먼저 좁히세요.',
].join('\n');

/**
 * transcript 경로 바로 아래에 붙는 형식 설명 + `jq` 예시.
 *
 * 형식별로 다른 이유는 파일 구조가 실제로 다르기 때문이다. claude는 한 줄이
 * `.message.role`/`.message.content`이고, codex rollout은 봉투가 한 겹 더 있어
 * `.payload.type=="message"` 줄의 `.payload.role`/`.payload.content[].text`다.
 * claude용 필터를 codex 파일에 쓰면 오류 없이 **빈 출력**이 나오므로, 예시를
 * 하나로 뭉뚱그리면 에이전트가 "대화가 비어 있다"고 잘못 보고한다.
 */
const TRANSCRIPT_FORMAT_HINTS: Record<TranscriptFormat, string[]> = {
  claude: [
    '  JSONL(claude). 줄마다 `.message.role`(user|assistant) 과 `.message.content`.',
    '  `jq -r \'select(.message.role=="user") | .message.content\' <path> | head -100`',
  ],
  codex: [
    '  JSONL(codex rollout). `.type=="response_item"` 이고 `.payload.type=="message"` 인',
    '  줄이 대화다 — `.payload.role`(user|assistant|developer) 과 `.payload.content[].text`.',
    '  `jq -r \'select(.type=="response_item" and .payload.type=="message" and .payload.role=="user") | .payload.content[].text\' <path> | head -100`',
  ],
};

function transcriptFormatHint(format: TranscriptFormat | undefined): string[] {
  return TRANSCRIPT_FORMAT_HINTS[format ?? 'claude'];
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // `%zz` 처럼 깨진 인코딩은 디코딩하지 않고 그대로 둔다.
    return value;
  }
}

/**
 * 본문에서 토큰을 순서대로 추출. 중복 토큰은 첫 등장만 남긴다.
 *
 * 앞 문자 가드(시작/공백/개행/`(`/`[`)를 통과하지 못한 매치는 버린다.
 */
export function parseMentionTokens(text: string): MentionToken[] {
  const scanner = new RegExp(MENTION_TOKEN_RE.source, MENTION_TOKEN_RE.flags);
  const tokens: MentionToken[] = [];
  const seen = new Set<string>();
  let match = scanner.exec(text);
  while (match !== null) {
    const start = match.index;
    const previous = start > 0 ? text[start - 1] : '';
    const id = decodeId(match[2]);
    const key = `${match[1]}:${id}`;
    if ((!previous || TOKEN_BOUNDARY_RE.test(previous)) && id && !seen.has(key)) {
      seen.add(key);
      tokens.push({
        kind: match[1] as MentionKind,
        id,
        raw: match[0],
        start,
        end: start + match[0].length,
      });
    }
    match = scanner.exec(text);
  }
  return tokens;
}

/** 한 줄짜리 메타 값으로 안전하게 만든다 — 개행 접기 + HTML 주석 구분자 제거. */
function oneLine(value: string): string {
  return value
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(value: string, limit = RESULT_EXCERPT_LIMIT): string {
  const flat = oneLine(value);
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * transcript 경로 뒤에 붙는 괄호 내용 — 크기와 크기별 읽기 지시.
 * 크기를 모르면 `Read`를 허가하지 않고 먼저 재라고 시킨다.
 */
function sizeHint(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '크기 미상 — 먼저 `ls -l`로 크기를 확인하세요';
  }
  return bytes <= TRANSCRIPT_READ_LIMIT_BYTES
    ? `${formatBytes(bytes)} — Read 가능`
    : `${formatBytes(bytes)} — **Read 금지, jq 선행**`;
}

function missingLabel(reason: string | undefined): string {
  switch (reason) {
    case 'runtime_unsupported':
      return '로컬 transcript를 남기지 않는 런타임';
    case 'no_project_dir':
      return 'projectDir 없음';
    case 'file_missing':
      return '파일 없음';
    default:
      return '경로를 확인할 수 없음';
  }
}

/** UTC ISO → `2026-09-12 14:20` (KST). 파싱 불가면 `undefined`. */
function kstParts(iso: string | undefined): { date: string; time: string } | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  const shifted = new Date(parsed + KST_OFFSET_MS);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

/** `(2026-09-12 14:20 ~ 15:58)` — 같은 날이면 끝은 시각만 적는다. */
function formatSpan(startedAt: string | undefined, completedAt: string | undefined): string {
  const start = kstParts(startedAt);
  const end = kstParts(completedAt);
  if (!start && !end) return '';
  if (!start) return ` (~ ${end!.date} ${end!.time})`;
  const head = `${start.date} ${start.time}`;
  if (!end) return ` (${head} ~ 진행 중)`;
  const tail = end.date === start.date ? end.time : `${end.date} ${end.time}`;
  return ` (${head} ~ ${tail})`;
}

function tokenText(ref: ResolvedReference): string {
  return `@${ref.kind}:${ref.id}`;
}

function heading(ref: ResolvedReference): string {
  // doc은 제목을 `- kind:` 줄에 싣는다 — 경로가 이미 제목만큼 길다.
  const title = ref.kind === 'doc' ? '' : oneLine(ref.title ?? '');
  return title ? `### ${tokenText(ref)} — ${title}` : `### ${tokenText(ref)}`;
}

function renderUnresolved(ref: ResolvedReference): string {
  const reason = ref.unresolved === 'ambiguous'
    ? '**접두사가 여러 항목에 매칭됩니다** — 더 긴 접두사가 필요합니다'
    : '**참조 대상을 찾지 못했습니다** — 현재 보드에 없습니다';
  return [
    heading(ref),
    `- kind: ${ref.kind} · ${reason}. 이 사실을 사용자에게 보고하세요.`,
  ].join('\n');
}

function renderSession(ref: ResolvedReference): string {
  const meta = ['kind: session'];
  if (ref.cardStatus) meta.push(`status: ${ref.cardStatus}`);
  if (ref.agentRuntime) meta.push(`runtime: ${ref.agentRuntime}`);
  if (ref.model) meta.push(`model: ${ref.model}`);

  const lines = [heading(ref), `- ${meta.join(' · ')}`];
  if (ref.sessionId) lines.push(`- sessionId: \`${ref.sessionId}\``);
  if (ref.projectDir) lines.push(`- projectDir: \`${ref.projectDir}\``);

  if (ref.transcriptPath) {
    lines.push(`- transcript: \`${ref.transcriptPath}\` (${sizeHint(ref.transcriptSize)})`);
    lines.push(...transcriptFormatHint(ref.transcriptFormat));
  } else {
    lines.push(`- transcript: 없음 (${missingLabel(ref.transcriptMissing)}) — 아래 메타데이터만 사용`);
  }

  if (ref.cardId) {
    const title = oneLine(ref.title ?? '');
    const label = title ? ` "${title}"` : '';
    lines.push(`- card: \`${ref.cardId}\`${label}${formatSpan(ref.startedAt, ref.completedAt)}`);
  }
  if (ref.resultExcerpt) lines.push(`- result: ${excerpt(ref.resultExcerpt)}`);
  return lines.join('\n');
}

function renderWorkSessionLine(session: ResolvedReferenceWorkSession): string {
  if (!session.transcriptPath) {
    return `  - \`${session.sessionId}\` → transcript 파일 없음 — 아래 메타데이터만 사용`;
  }
  // 형식 이름만 붙인다. Work 하나가 세션 8개를 실을 수 있어 줄마다 jq 예시를
  // 반복하면 블록이 예시로 뒤덮인다 — 상세 필터는 세션 참조 쪽에 있다.
  const format = session.transcriptFormat ?? 'claude';
  return `  - \`${session.sessionId}\` → \`${session.transcriptPath}\` (${format} · ${sizeHint(session.transcriptSize)})`;
}

function renderWork(ref: ResolvedReference): string {
  const meta = ['kind: work'];
  if (ref.workStatus) meta.push(`status: ${ref.workStatus}`);
  if (typeof ref.sessionCount === 'number') meta.push(`세션 ${ref.sessionCount}개`);
  if (typeof ref.cardCount === 'number') meta.push(`카드 ${ref.cardCount}개`);

  const lines = [heading(ref), `- ${meta.join(' · ')}`];

  const summary = (ref.summaryLines ?? []).map(oneLine).filter(Boolean);
  if (summary.length) {
    lines.push('- summary:');
    for (const line of summary) lines.push(`  - ${line}`);
  }

  const sessions = ref.workSessions ?? [];
  if (sessions.length) {
    lines.push('- sessions:');
    for (const session of sessions.slice(0, MAX_WORK_SESSION_LINES)) {
      lines.push(renderWorkSessionLine(session));
    }
    if (sessions.length > MAX_WORK_SESSION_LINES) {
      lines.push(`  - … 외 ${sessions.length - MAX_WORK_SESSION_LINES}개`);
    }
  }
  return lines.join('\n');
}

function renderDoc(ref: ResolvedReference): string {
  const meta = ['kind: doc'];
  const title = oneLine(ref.title ?? '');
  if (title) meta.push(`title: "${title}"`);

  const lines = [heading(ref), `- ${meta.join(' · ')}`];
  if (ref.docAbsPath) {
    lines.push(`- path: \`${ref.docAbsPath}\``);
  } else if (ref.docPath) {
    lines.push(`- path: \`${ref.docPath}\` (vault 상대 경로 — 절대경로를 확인할 수 없습니다)`);
  }
  return lines.join('\n');
}

function renderReference(ref: ResolvedReference): string {
  if (ref.unresolved) return renderUnresolved(ref);
  if (ref.kind === 'work') return renderWork(ref);
  if (ref.kind === 'doc') return renderDoc(ref);
  return renderSession(ref);
}

/**
 * 참조 블록 문자열. `MAX_REFERENCES`를 넘는 참조는 잘린다(칩 쪽에서 경고).
 * 참조가 하나도 없으면 빈 문자열 — 붙일 블록 자체가 없다.
 */
export function renderReferenceBlock(refs: ResolvedReference[]): string {
  const kept = refs.slice(0, MAX_REFERENCES);
  if (!kept.length) return '';
  const sections = kept.map(renderReference);
  return [REFERENCE_BLOCK_OPEN, BLOCK_HEADER, '', sections.join('\n\n'), REFERENCE_BLOCK_CLOSE].join('\n');
}

/**
 * 기존 블록(주석 쌍 포함)을 제거. 블록이 없으면 원본 그대로.
 *
 * 여는 주석은 있는데 닫는 주석이 없으면(사람이 손으로 반을 지운 경우) 여는
 * 주석부터 끝까지를 블록으로 본다 — 블록은 항상 본문 맨 끝에 붙기 때문이다.
 */
export function stripReferenceBlock(text: string): string {
  let out = text;
  for (;;) {
    const open = out.indexOf(REFERENCE_BLOCK_OPEN);
    if (open < 0) return out;
    const close = out.indexOf(REFERENCE_BLOCK_CLOSE, open);
    const end = close < 0 ? out.length : close + REFERENCE_BLOCK_CLOSE.length;
    const head = out.slice(0, open).trimEnd();
    const tail = out.slice(end).trimStart();
    out = tail ? (head ? `${head}\n\n${tail}` : tail) : head;
  }
}

/**
 * strip 후 append. `refs`가 비면 strip만 수행한다.
 *
 * 멱등이다 — 같은 참조로 다시 부르면 앞 블록을 걷어내고 같은 결과를 만든다.
 * 피드백 라운드마다 같은 본문을 다시 제출해도 블록이 쌓이지 않는 근거.
 */
export function appendReferenceBlock(body: string, refs: ResolvedReference[]): string {
  const stripped = stripReferenceBlock(body);
  const block = renderReferenceBlock(refs);
  if (!block) return stripped;
  const base = stripped.trimEnd();
  return base ? `${base}\n\n${block}` : block;
}
