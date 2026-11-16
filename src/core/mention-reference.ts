import type { AgentRuntime, WorkStatus } from './types';
import type {
  SkillInvocation,
  SkillMentionScope,
  SkillRuntime,
  SkillUnavailableReason,
} from './mention-skills';
import { SKILL_UNAVAILABLE_LABEL } from './mention-skills';

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

export type MentionKind = 'session' | 'work' | 'doc' | 'skill';

/**
 * 본문에 박히는 토큰. 전역 플래그가 붙어 있으므로 `exec` 루프에 그대로 쓰지
 * 말 것 — `lastIndex`가 호출자 사이에 새어 나간다. `parseMentionTokens`는
 * 매번 복제본을 만든다.
 *
 * id 안의 `:`는 **사이에만** 허용한다(`@skill:egm:egm-review`). 끝에 붙은 `:`는
 * 토큰이 아니라 문장 부호다 — `@skill:consensus: 로 검증` 같은 본문이 흔하다.
 */
export const MENTION_TOKEN_RE = /@(session|work|doc|skill):([A-Za-z0-9_\-./%]+(?::[A-Za-z0-9_\-./%]+)*)/g;

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
  /**
   * `unavailable` — skill 전용. 스킬은 존재하지만 이 카드(runtime × projectDir ×
   * 입력 위치)에서는 호출되지 않는다. 이유는 `skillUnavailable`.
   */
  unresolved?: 'not_found' | 'ambiguous' | 'unavailable';
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
  // skill
  skillRuntime?: SkillRuntime;
  skillScope?: SkillMentionScope;
  skillPlugin?: string;
  skillInvocation?: SkillInvocation;
  /** SKILL.md 절대경로. 블록에는 싣지 않는다 — 스킬은 경로가 아니라 이름으로 부른다. */
  skillPath?: string;
  /** 스킬 소속 프로젝트(project scope일 때). */
  skillProjectDir?: string;
  /**
   * `unresolved === 'unavailable'`의 이유. `SkillUnavailableReason`에 더해
   * `launch_only` — claude 첫 줄 실행 전용 스킬을 본문 토큰으로 넣은 경우(E2b·E3b:
   * 모델이 호출을 거부하므로 블록 지시로는 실행되지 않는다).
   */
  skillUnavailable?: SkillUnavailableReason | 'launch_only';
}

/**
 * 첫 줄 실행 라인(`/name`)의 검증 결과. 토큰이 아니라 본문 첫 줄이라 참조 목록과
 * 따로 돈다. `ok === false`인 채로 보내면 claude는 오류 없이 평문으로 받아
 * 스킬 없이 진행한다(E2f) — 그래서 UI가 제출을 막는 근거가 이 값이다.
 */
export interface SkillLaunchStatus {
  name: string;
  ok: boolean;
  /** `ok === false`일 때. `not_found`는 어디에서도 찾지 못한 이름. */
  reason?: SkillUnavailableReason | 'not_found' | 'not_launch';
  invocation?: SkillInvocation;
  scope?: SkillMentionScope;
  description?: string;
  /** `other_project`일 때 그 스킬이 있는 프로젝트. */
  projectDir?: string;
}

/** `GET /api/mentions/resolve` 응답. */
export interface MentionResolveResponse {
  references: ResolvedReference[];
  /** `launch` 쿼리를 보냈을 때만. */
  launch?: SkillLaunchStatus;
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
    const kind = match[1] as MentionKind;
    // skill 이름은 `.`으로 끝나지 않는다 — 문장 끝 마침표(`@skill:consensus.`)를
    // id로 먹으면 존재하지 않는 스킬이 된다. 다른 kind는 기존 동작 그대로(doc은
    // `.md`로 끝나는 게 정상이다).
    const rawId = kind === 'skill' ? match[2].replace(/\.+$/, '') : match[2];
    const raw = `@${kind}:${rawId}`;
    const id = decodeId(rawId);
    const key = `${kind}:${id}`;
    if ((!previous || TOKEN_BOUNDARY_RE.test(previous)) && id && !seen.has(key)) {
      seen.add(key);
      tokens.push({
        kind,
        id,
        raw,
        start,
        end: start + raw.length,
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

/** 스킬을 이 세션에서 쓸 수 없는 이유 — 블록·칩이 같은 문구를 쓴다. */
export function skillUnavailableText(reason: ResolvedReference['skillUnavailable']): string {
  if (reason === 'launch_only') return '첫 줄 실행 전용 스킬이라 참조로는 호출되지 않습니다';
  if (reason) return SKILL_UNAVAILABLE_LABEL[reason];
  return '이 세션에서 사용할 수 없습니다';
}

function renderUnresolved(ref: ResolvedReference): string {
  if (ref.unresolved === 'unavailable') {
    // 스킬은 있지만 이 세션에서는 보이지 않는다. 없는 스킬을 부르면 claude는
    // 평문으로 흘려보내고(E2f) codex는 이름이 비슷한 다른 스킬을 실행한 사례가
    // 있다(C10) — 그래서 "흉내 내지 말라"를 명시한다.
    return [
      heading(ref),
      `- kind: skill · **이 세션에서 사용할 수 없는 스킬입니다** — ${skillUnavailableText(ref.skillUnavailable)}.`,
      '- 호출하거나 비슷한 이름의 다른 스킬로 대신하지 말고, 이 사실을 사용자에게 보고하세요.',
    ].join('\n');
  }
  const reason = ref.unresolved === 'ambiguous'
    ? '**접두사가 여러 항목에 매칭됩니다** — 더 긴 접두사가 필요합니다'
    : ref.kind === 'skill'
      ? '**스킬을 찾지 못했습니다** — 이 세션의 스킬 목록에 없습니다. 비슷한 이름의 다른 스킬로 대신하지 마세요'
      : '**참조 대상을 찾지 못했습니다** — 현재 보드에 없습니다';
  return [
    heading(ref),
    `- kind: ${ref.kind} · ${reason}. 이 사실을 사용자에게 보고하세요.`,
  ].join('\n');
}

/**
 * 스킬 항목. 런타임마다 호출 문법이 다르다:
 *
 * - codex: `$name`을 본문에 적으면 위치·개수와 무관하게 스킬 본문이 주입된다
 *   (C6 3/3, C7). 지시 문장 안에 `$name`을 그대로 싣는 것이 곧 호출이다.
 * - claude: `Skill` 도구 호출 지시 (E5 3/3). 첫 줄 실행 전용(`launch`)은 여기 오지
 *   않는다 — 해석 단계에서 `unavailable`로 떨어진다.
 */
function renderSkill(ref: ResolvedReference): string {
  const meta = ['kind: skill'];
  if (ref.skillRuntime) meta.push(`runtime: ${ref.skillRuntime}`);
  if (ref.skillScope) meta.push(`scope: ${ref.skillPlugin ? `plugin(${ref.skillPlugin})` : ref.skillScope}`);
  if (ref.skillInvocation) meta.push(`invocation: ${ref.skillInvocation}`);

  const lines = [heading(ref), `- ${meta.join(' · ')}`];
  if (ref.skillRuntime === 'codex') {
    lines.push(`- 호출: 이 작업에 \`$${ref.id}\` 스킬을 사용하세요.`);
  } else {
    lines.push(`- 호출: 이 작업의 해당 단계에서 \`Skill\` 도구로 \`${ref.id}\` 스킬을 호출하고 그 지시를 따르세요.`);
    lines.push('- 호출이 거부되면 같은 절차를 다른 방법으로 흉내 내지 말고 그 사실을 보고하세요.');
  }
  return lines.join('\n');
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
  if (ref.kind === 'skill') return renderSkill(ref);
  return renderSession(ref);
}

/**
 * 스킬이 섞인 블록에만 붙는 머리말 보충. 기존 머리말은 "경로를 열어 읽어라"라서
 * 스킬 항목을 파일로 착각하지 않게 한 줄 구분해 준다. 스킬이 없는 블록은 기존과
 * 바이트 단위로 같다.
 */
const SKILL_HEADER_NOTE = [
  '',
  '**`kind: skill` 항목은 읽을 파일이 아니라 사용할 스킬입니다** — 각 항목의 호출 지시를 따르세요.',
].join('\n');

/**
 * 참조 블록 문자열. `MAX_REFERENCES`를 넘는 참조는 잘린다(칩 쪽에서 경고).
 * 참조가 하나도 없으면 빈 문자열 — 붙일 블록 자체가 없다.
 */
export function renderReferenceBlock(refs: ResolvedReference[]): string {
  const kept = refs.slice(0, MAX_REFERENCES);
  if (!kept.length) return '';
  const sections = kept.map(renderReference);
  const header = kept.some((ref) => ref.kind === 'skill') ? `${BLOCK_HEADER}${SKILL_HEADER_NOTE}` : BLOCK_HEADER;
  return [REFERENCE_BLOCK_OPEN, header, '', sections.join('\n\n'), REFERENCE_BLOCK_CLOSE].join('\n');
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
 * 본문과 참조 블록을 나눈다. 블록은 주석 쌍을 포함한 원문 그대로(여러 개면
 * 빈 줄로 이어 붙인다), 본문은 `stripReferenceBlock`과 같은 결과다.
 *
 * 카드 상세처럼 **저장된** 프롬프트를 다시 보여 주는 화면이 쓴다 — 사람이 쓴
 * 본문과 에이전트가 받은 지시문을 따로 렌더하기 위해서다.
 */
export function splitReferenceBlock(text: string): { body: string; block: string } {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf(REFERENCE_BLOCK_OPEN, from);
    if (open < 0) break;
    const close = text.indexOf(REFERENCE_BLOCK_CLOSE, open);
    const end = close < 0 ? text.length : close + REFERENCE_BLOCK_CLOSE.length;
    blocks.push(text.slice(open, end).trim());
    from = end;
  }
  return { body: stripReferenceBlock(text), block: blocks.join('\n\n') };
}

/** 저장된 블록의 한 항목 — 칩 하나를 그리는 데 필요한 만큼만. */
export interface ReferenceBlockEntry {
  kind: MentionKind;
  id: string;
  /** `parseMentionTokens`의 `kind:id`와 같은 키(디코딩된 id). */
  key: string;
  title: string;
  /** 칩 옆에 붙는 짧은 메타 — `세션 3개 · 카드 45개`, `812.0KB` 등. */
  meta?: string;
  unresolved?: 'not_found' | 'ambiguous' | 'unavailable';
  transcriptMissing?: boolean;
}

const BLOCK_HEADING_RE = /^### @(session|work|doc|skill):(.+)$/;
const TITLE_SEPARATOR = ' — ';

/**
 * `renderReferenceBlock`이 만든 블록을 역으로 읽는다 (저장 당시 스냅샷).
 *
 * 렌더러와 같은 파일에 두는 이유: 헤딩·메타 줄 형식을 바꾸면 이 파서도 같이
 * 고쳐야 한다. 모르는 줄은 무시하므로, 형식이 조금 어긋나도 칩은 토큰과
 * 제목만으로 그려진다.
 */
export function parseReferenceBlock(block: string): ReferenceBlockEntry[] {
  const entries: ReferenceBlockEntry[] = [];
  let current: ReferenceBlockEntry | null = null;

  for (const line of block.split('\n')) {
    const heading = BLOCK_HEADING_RE.exec(line.trim());
    if (heading) {
      const kind = heading[1] as MentionKind;
      const rest = heading[2].trim();
      // doc은 제목을 헤딩에 싣지 않는다(경로가 곧 id이고 공백을 품을 수 있다).
      const separator = kind === 'doc' ? -1 : rest.indexOf(TITLE_SEPARATOR);
      const id = separator < 0 ? rest : rest.slice(0, separator).trim();
      const title = separator < 0 ? '' : rest.slice(separator + TITLE_SEPARATOR.length).trim();
      current = { kind, id, key: `${kind}:${id}`, title };
      entries.push(current);
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('- kind:')) {
      if (trimmed.includes('**참조 대상을 찾지 못했습니다**')) current.unresolved = 'not_found';
      else if (trimmed.includes('**스킬을 찾지 못했습니다**')) current.unresolved = 'not_found';
      else if (trimmed.includes('**이 세션에서 사용할 수 없는 스킬입니다**')) current.unresolved = 'unavailable';
      else if (trimmed.includes('**접두사가 여러 항목에 매칭됩니다**')) current.unresolved = 'ambiguous';
      if (current.kind === 'skill') {
        const scope = /scope: ([^ ]+)/.exec(trimmed);
        if (scope) current.meta = scope[1];
      }
      const docTitle = /title: "([^"]*)"/.exec(trimmed);
      if (docTitle && !current.title) current.title = docTitle[1];
      if (current.kind === 'work') {
        const counts = trimmed.split(' · ').filter((part) => /^(세션|카드) \d+개$/.test(part));
        if (counts.length) current.meta = counts.join(' · ');
      }
    } else if (current.kind === 'session' && trimmed.startsWith('- transcript:')) {
      if (trimmed.startsWith('- transcript: 없음')) {
        current.transcriptMissing = true;
      } else {
        const size = /\((\d+(?:\.\d+)?(?:B|KB|MB)) — /.exec(trimmed);
        if (size) current.meta = size[1];
      }
    } else if (current.kind === 'doc' && trimmed.startsWith('- path:') && !current.title) {
      const path = /`([^`]+)`/.exec(trimmed);
      if (path) current.title = path[1].split('/').pop() ?? path[1];
    }
  }
  return entries;
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
