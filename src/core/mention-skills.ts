import type { AgentRuntime } from './types';

/**
 * `@skill:` 멘션 — 타입과 순수 규칙.
 *
 * session/work/doc 멘션은 "읽을 자료"지만 skill은 "실행할 기능"이다. 그래서
 * 두 가지가 다르다(실측 근거: `docs/mockups/mention-skills-capabilities.html` ⑥).
 *
 * 1. **어디서 보이는가가 runtime × projectDir에 따라 달라진다.** claude는
 *    `.claude/skills`, codex는 `.codex/skills`·`.agents/skills`를 읽고 서로의
 *    디렉토리는 읽지 않는다.
 * 2. **호출 방식이 셋이다** (`SkillInvocation`).
 *    - `model`    — 참조 블록 지시만으로 호출된다 (claude `Skill` 도구 3/3, codex `$name` 3/3).
 *    - `launch`   — claude `disable-model-invocation: true`. 모델은 호출을 거부하고
 *                   **프롬프트 첫 줄 `/name`** 으로만 실행된다. 한 프롬프트에 1개.
 *    - `explicit` — codex `agents/openai.yaml`의 `allow_implicit_invocation: false`.
 *                   모델 목록에서는 숨지만 `$name`을 적으면 위치와 무관하게 주입된다.
 *
 * `launch`만 참조 블록으로 표현할 수 없어서, 본문 첫 줄을 쓰는 헬퍼가 여기 있다.
 * 카드 모델에는 필드가 늘지 않는다 — 첫 줄도 결국 `description` 문자열이다.
 */

export type SkillMentionScope = 'project' | 'user' | 'system' | 'plugin';
export type SkillInvocation = 'model' | 'launch' | 'explicit';
export type SkillRuntime = Extract<AgentRuntime, 'claude' | 'codex'>;

/**
 * 후보가 지금 카드에서 선택 불가한 이유. 행은 숨기지 않고 회색으로 남긴다 —
 * "왜 안 보이지?"보다 "왜 안 되는지"를 보여주는 편이 낫다.
 *
 * - `other_project`       — 다른 projectDir의 project 스킬
 * - `runtime_mismatch`    — 같은 디렉토리지만 다른 런타임에서만 보이는 스킬
 * - `runtime_unsupported` — opencode 카드 (스킬 멘션 미지원)
 * - `launch_not_allowed`  — 첫 줄 실행 전용인데 이 입력창은 첫 줄을 보장할 수 없다
 *                           (피드백·세션 턴은 헤더가 본문 앞에 붙는다)
 */
export type SkillUnavailableReason =
  | 'other_project'
  | 'runtime_mismatch'
  | 'runtime_unsupported'
  | 'launch_not_allowed';

/** 디스커버리 한 건. `name`이 곧 호출 이름이자 토큰 id다. */
export interface MentionSkillEntry {
  runtime: SkillRuntime;
  /** 호출 이름 — plugin 스킬은 `plugin:skill` (`egm:egm-review`, `pdf:pdf`). */
  name: string;
  description: string;
  scope: SkillMentionScope;
  /** `scope === 'plugin'`일 때 plugin 이름. */
  plugin?: string;
  invocation: SkillInvocation;
  /** SKILL.md 절대경로. */
  skillPath: string;
  /** `scope === 'project'`일 때 그 스킬이 속한 프로젝트 디렉토리. */
  projectDir?: string;
  /** SKILL.md mtime (ISO 8601). */
  updatedAt?: string;
}

/** 검색 풀 한 건 — 지금 카드에서 고를 수 없으면 이유가 붙는다. */
export interface SkillPoolEntry extends MentionSkillEntry {
  unavailable?: SkillUnavailableReason;
}

export const SKILL_UNAVAILABLE_LABEL: Record<SkillUnavailableReason, string> = {
  other_project: '다른 프로젝트 전용',
  runtime_mismatch: '다른 런타임 전용',
  runtime_unsupported: '이 런타임은 스킬 멘션 미지원',
  launch_not_allowed: '새 카드·프롬프트 편집에서만 실행 가능',
};

export const SKILL_INVOCATION_LABEL: Record<SkillInvocation, string> = {
  model: '모델 호출',
  launch: '/ 실행 전용',
  explicit: '$ 명시 전용',
};

/**
 * 첫 줄 실행 라인. 이름 문자는 `MENTION_TOKEN_RE`의 id와 같은 집합 + `:` —
 * 실측(E2a/E3e)에서 `/probe-slash`, `/egm:egm-review` 둘 다 확장됐다.
 */
const LAUNCH_LINE_RE = /^\/([A-Za-z0-9_\-.]+(?::[A-Za-z0-9_\-.]+)*)[ \t]*$/;

export interface SkillLaunch {
  name: string;
}

/**
 * 본문 첫 줄이 단독 `/name`이면 그 이름. dispatch가 `description.trim()`을 쓰므로
 * 앞쪽 빈 줄은 건너뛴다. 같은 줄에 인자가 붙은 `/name args` 형식은 사용자가
 * 직접 친 커맨드일 수 있어 실행 바로 해석하지 않는다.
 */
export function parseSkillLaunch(text: string): SkillLaunch | null {
  const firstLine = text.replace(/^\s+/, '').split('\n', 1)[0] ?? '';
  const match = LAUNCH_LINE_RE.exec(firstLine.trimEnd());
  return match ? { name: match[1] } : null;
}

/** 첫 줄 실행 라인을 걷어낸 본문. 라인이 없으면 원본 그대로. */
export function removeSkillLaunch(text: string): string {
  if (!parseSkillLaunch(text)) return text;
  const trimmed = text.replace(/^\s+/, '');
  const newline = trimmed.indexOf('\n');
  return newline < 0 ? '' : trimmed.slice(newline + 1).replace(/^\n+/, '');
}

/**
 * 첫 줄을 `/name`으로 만든다. 이미 실행 라인이 있으면 **교체**한다 — 실행 스킬은
 * 프롬프트당 1개만 동작한다(E3a: 두 번째 slash-only는 거부).
 */
export function applySkillLaunch(text: string, name: string): string {
  const body = removeSkillLaunch(text);
  return body ? `/${name}\n${body}` : `/${name}\n`;
}
