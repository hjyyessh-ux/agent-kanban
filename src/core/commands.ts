import type { AgentRuntime, DiscoveredSkill } from './types';

export const BUILTIN_COMMAND_IDS = [
  'init-deep',
  'ralph-loop',
  'ulw-loop',
  'cancel-ralph',
  'refactor',
  'start-work',
  'stop-continuation',
  'handoff',
] as const;

export const CODEX_COMMAND_IDS = [
  'prompts:planner',
  'prompts:architect',
  'prompts:executor',
  'prompts:verifier',
  'prompts:code-reviewer',
  'prompts:test-engineer',
  'prompts:security-reviewer',
  'prompts:debugger',
  'prompts:researcher',
  'prompts:analyst',
  'prompts:designer',
  'prompts:code-simplifier',
  'prompts:dependency-expert',
  'prompts:git-master',
  'prompts:writer',
  'prompts:critic',
  'prompts:vision',
  'prompts:build-fixer',
  'prompts:explore',
] as const;

export const CLAUDE_COMMAND_IDS = [
  'code-review',
  'security-review',
  'review',
  'verify',
  'simplify',
  'init',
] as const;

export const RUNTIME_COMMAND_IDS = [
  ...BUILTIN_COMMAND_IDS,
  ...CODEX_COMMAND_IDS,
  ...CLAUDE_COMMAND_IDS,
] as const;

export type BuiltinCommandId = (typeof BUILTIN_COMMAND_IDS)[number];
export type CodexCommandId = (typeof CODEX_COMMAND_IDS)[number];
export type ClaudeCommandId = (typeof CLAUDE_COMMAND_IDS)[number];
export type RuntimeCommandId = (typeof RUNTIME_COMMAND_IDS)[number];
export type BuiltinCommandExecutionMode = 'command_only' | 'command_with_prompt';
export type RuntimeCommandKind = 'opencode_builtin' | 'opencode_skill' | 'codex_prompt' | 'codex_skill' | 'claude_command' | 'claude_skill';

export interface BuiltinCommandDefinition {
  runtime: AgentRuntime;
  executionMode: BuiltinCommandExecutionMode;
  kind?: RuntimeCommandKind;
  displayName?: string;
  skillName?: string;
  description: string;
  argumentPlaceholder: string;
  parameterSummary: string;
}

export const BUILTIN_COMMANDS: Record<BuiltinCommandId, BuiltinCommandDefinition> = {
  'init-deep': {
    runtime: 'opencode',
    executionMode: 'command_only',
    description: 'AGENTS.md 계층과 프로젝트 지침을 초기화합니다.',
    argumentPlaceholder: '[--create-new] [--max-depth=N]',
    parameterSummary: '`--create-new`, `--max-depth=N` 선택',
  },
  'ralph-loop': {
    runtime: 'opencode',
    executionMode: 'command_with_prompt',
    description: '작업이 끝날 때까지 자기 검증 루프를 실행합니다.',
    argumentPlaceholder: '"작업 설명" [--completion-promise=TEXT] [--max-iterations=N] [--strategy=reset|continue]',
    parameterSummary: '작업 설명 필수, 완료 기준/반복 수/전략 선택',
  },
  'ulw-loop': {
    runtime: 'opencode',
    executionMode: 'command_with_prompt',
    description: 'Ultrawork 루프와 Oracle 검증을 함께 실행합니다.',
    argumentPlaceholder: '"작업 설명" [--completion-promise=TEXT] [--strategy=reset|continue]',
    parameterSummary: '작업 설명 필수, 완료 기준/전략 선택',
  },
  'cancel-ralph': {
    runtime: 'opencode',
    executionMode: 'command_only',
    description: '현재 실행 중인 Ralph 루프를 중단합니다.',
    argumentPlaceholder: '',
    parameterSummary: '추가 파라미터 없음',
  },
  refactor: {
    runtime: 'opencode',
    executionMode: 'command_with_prompt',
    description: '대상 코드의 구조 개선 작업을 시작합니다.',
    argumentPlaceholder: '<target> [--scope=file|module|project] [--strategy=safe|aggressive]',
    parameterSummary: '대상 필수, 범위/전략 선택',
  },
  'start-work': {
    runtime: 'opencode',
    executionMode: 'command_with_prompt',
    description: '계획 기반 작업 세션을 시작합니다.',
    argumentPlaceholder: '[plan-name]',
    parameterSummary: '계획 이름 선택',
  },
  'stop-continuation': {
    runtime: 'opencode',
    executionMode: 'command_only',
    description: '대기 중인 continuation 실행을 모두 중지합니다.',
    argumentPlaceholder: '',
    parameterSummary: '추가 파라미터 없음',
  },
  handoff: {
    runtime: 'opencode',
    executionMode: 'command_with_prompt',
    description: '다음 작업자가 이어받을 수 있는 요약을 생성합니다.',
    argumentPlaceholder: '[goal]',
    parameterSummary: '인계 목표 선택',
  },
};

const CODEX_COMMANDS: Record<CodexCommandId, BuiltinCommandDefinition> = {
  'prompts:planner': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '구현 전에 범위와 단계, 검증 기준을 계획합니다.',
    argumentPlaceholder: '<작업 요청>',
    parameterSummary: '계획할 작업 요청 필수',
  },
  'prompts:architect': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '구조, 경계, 리스크를 먼저 판단하는 설계 관점으로 실행합니다.',
    argumentPlaceholder: '<설계가 필요한 작업>',
    parameterSummary: '설계 대상 작업 필수',
  },
  'prompts:executor': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '정해진 목표를 구현 중심으로 처리합니다.',
    argumentPlaceholder: '<구현할 작업>',
    parameterSummary: '구현 요청 필수',
  },
  'prompts:verifier': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '변경 결과와 테스트 근거를 검증하는 관점으로 실행합니다.',
    argumentPlaceholder: '<검증할 변경 또는 목표>',
    parameterSummary: '검증 대상 필수',
  },
  'prompts:code-reviewer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '버그, 회귀, 테스트 누락 중심으로 코드 리뷰를 수행합니다.',
    argumentPlaceholder: '<리뷰할 diff, 파일, PR 설명>',
    parameterSummary: '리뷰 대상 필수',
  },
  'prompts:test-engineer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '테스트 설계와 회귀 검증 관점으로 작업합니다.',
    argumentPlaceholder: '<테스트할 기능 또는 변경>',
    parameterSummary: '테스트 대상 필수',
  },
  'prompts:security-reviewer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '보안 취약점과 민감정보 노출 가능성을 점검합니다.',
    argumentPlaceholder: '<점검할 코드 또는 설계>',
    parameterSummary: '점검 대상 필수',
  },
  'prompts:debugger': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '증상, 로그, 재현 경로를 따라 원인을 좁힙니다.',
    argumentPlaceholder: '<버그 증상과 재현 정보>',
    parameterSummary: '증상/재현 정보 필수',
  },
  'prompts:researcher': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '자료 조사와 근거 수집 중심으로 답을 구성합니다.',
    argumentPlaceholder: '<조사할 질문>',
    parameterSummary: '조사 질문 필수',
  },
  'prompts:analyst': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '데이터와 로그를 분류해 패턴과 결론을 정리합니다.',
    argumentPlaceholder: '<분석할 자료 또는 질문>',
    parameterSummary: '분석 대상 필수',
  },
  'prompts:designer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: 'UI 흐름, 레이아웃, 시각적 완성도를 우선합니다.',
    argumentPlaceholder: '<디자인할 화면 또는 문제>',
    parameterSummary: '디자인 대상 필수',
  },
  'prompts:code-simplifier': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '불필요한 복잡도를 줄이고 읽기 쉬운 코드로 정리합니다.',
    argumentPlaceholder: '<단순화할 코드 또는 범위>',
    parameterSummary: '단순화 대상 필수',
  },
  'prompts:dependency-expert': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '라이브러리, 버전, 의존성 충돌을 중심으로 판단합니다.',
    argumentPlaceholder: '<의존성 문제 또는 패키지 변경>',
    parameterSummary: '의존성 질문 필수',
  },
  'prompts:git-master': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '브랜치, diff, 커밋 전 변경 범위를 점검합니다.',
    argumentPlaceholder: '<Git 작업 또는 diff 검토 요청>',
    parameterSummary: 'Git 작업 설명 필수',
  },
  'prompts:writer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '문서, 릴리스 노트, 설명문을 명확하게 작성합니다.',
    argumentPlaceholder: '<작성할 문서나 메시지>',
    parameterSummary: '작성 대상 필수',
  },
  'prompts:critic': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '가정과 결론을 비판적으로 검토합니다.',
    argumentPlaceholder: '<검토할 주장, 설계, 코드>',
    parameterSummary: '검토 대상 필수',
  },
  'prompts:vision': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '스크린샷과 시각 자료를 중심으로 분석합니다.',
    argumentPlaceholder: '<이미지 기반 분석 요청>',
    parameterSummary: '분석 요청 필수, 스크린샷 첨부 권장',
  },
  'prompts:build-fixer': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '빌드, 타입, 테스트 실패를 고치는 데 집중합니다.',
    argumentPlaceholder: '<실패 로그 또는 검증 명령>',
    parameterSummary: '실패 로그나 명령 필수',
  },
  'prompts:explore': {
    runtime: 'codex',
    executionMode: 'command_with_prompt',
    description: '코드베이스 구조와 관련 파일을 먼저 탐색합니다.',
    argumentPlaceholder: '<파악할 영역 또는 질문>',
    parameterSummary: '탐색할 질문 필수',
  },
};

const CLAUDE_COMMANDS: Record<ClaudeCommandId, BuiltinCommandDefinition> = {
  'code-review': {
    runtime: 'claude',
    executionMode: 'command_only',
    description: '현재 변경 diff를 코드 리뷰합니다.',
    argumentPlaceholder: '[low|medium|high] [--comment] [--fix]',
    parameterSummary: '리뷰 강도 선택, `--comment`/`--fix` 선택',
  },
  'security-review': {
    runtime: 'claude',
    executionMode: 'command_only',
    description: '현재 브랜치 변경사항을 보안 관점에서 점검합니다.',
    argumentPlaceholder: '',
    parameterSummary: '추가 파라미터 없음',
  },
  review: {
    runtime: 'claude',
    executionMode: 'command_only',
    description: 'GitHub Pull Request를 리뷰합니다.',
    argumentPlaceholder: '<PR 번호 또는 URL>',
    parameterSummary: 'PR 번호 또는 URL 필수',
  },
  verify: {
    runtime: 'claude',
    executionMode: 'command_with_prompt',
    description: '변경이 실제로 동작하는지 앱을 실행해 검증합니다.',
    argumentPlaceholder: '',
    parameterSummary: '검증 대상을 프롬프트로 설명 필수',
  },
  simplify: {
    runtime: 'claude',
    executionMode: 'command_only',
    description: '변경된 코드를 단순화하고 정리합니다.',
    argumentPlaceholder: '',
    parameterSummary: '추가 파라미터 없음',
  },
  init: {
    runtime: 'claude',
    executionMode: 'command_only',
    description: '코드베이스를 분석해 CLAUDE.md를 생성합니다.',
    argumentPlaceholder: '',
    parameterSummary: '추가 파라미터 없음',
  },
};

export const RUNTIME_COMMANDS: Record<RuntimeCommandId, BuiltinCommandDefinition> = {
  ...BUILTIN_COMMANDS,
  ...CODEX_COMMANDS,
  ...CLAUDE_COMMANDS,
};

const BUILTIN_COMMAND_SET = new Set<string>(BUILTIN_COMMAND_IDS);
const RUNTIME_COMMAND_SET = new Set<string>(RUNTIME_COMMAND_IDS);

// ─── Dynamic skill registry ─────────────────────────────────────
// Skills discovered from disk (see skill-scanner) are registered here at runtime
// to augment the static tables above. Lookups consult both, so dispatch / store
// / routes recognize user-authored skills with no code change. Static ids always
// win: registering a skill whose id already exists statically is a no-op, which
// preserves the curated descriptions and execution modes.
const dynamicCommands = new Map<string, BuiltinCommandDefinition>();

export function setDynamicSkillCommands(skills: DiscoveredSkill[]): void {
  dynamicCommands.clear();
  for (const skill of skills) {
    if (RUNTIME_COMMAND_SET.has(skill.id) || dynamicCommands.has(skill.id)) continue;
    dynamicCommands.set(skill.id, {
      runtime: skill.runtime,
      executionMode: 'command_with_prompt',
      kind: skill.kind,
      displayName: skill.displayName,
      skillName: skill.skillName,
      description: skill.description,
      argumentPlaceholder: '[추가 지시 또는 옵션]',
      parameterSummary: `카드 설명을 ${skill.displayName} 호출 프롬프트로 전달`,
    });
  }
}

export function getDynamicSkillCommandIds(): string[] {
  return [...dynamicCommands.keys()];
}

/** Resolve a command definition by normalized id from the static or dynamic tables. */
function lookupDefinition(normalizedId: string): BuiltinCommandDefinition | undefined {
  if (RUNTIME_COMMAND_SET.has(normalizedId)) {
    return RUNTIME_COMMANDS[normalizedId as RuntimeCommandId];
  }
  return dynamicCommands.get(normalizedId);
}

/** Command id + definition for every static and dynamic command. */
export function getAllCommandEntries(): Array<{ id: string; definition: BuiltinCommandDefinition }> {
  const entries = RUNTIME_COMMAND_IDS.map((id) => ({ id: id as string, definition: RUNTIME_COMMANDS[id] }));
  for (const [id, definition] of dynamicCommands) {
    entries.push({ id, definition });
  }
  return entries;
}

/** Safe definition lookup by raw command token (static or dynamic), runtime-agnostic. */
export function getCommandDefinitionById(command?: string): BuiltinCommandDefinition | undefined {
  if (!command) return undefined;
  return lookupDefinition(normalizeRuntimeCommandToken(command));
}

export function normalizeBuiltinCommandId(command?: string): BuiltinCommandId | undefined {
  if (!command) return undefined;
  const normalized = command.trim().replace(/^\/+/, '');
  if (!normalized || !BUILTIN_COMMAND_SET.has(normalized)) return undefined;
  return normalized as BuiltinCommandId;
}

export function normalizeRuntimeCommandId(command: string | undefined, runtime: AgentRuntime): RuntimeCommandId | undefined {
  if (!command) return undefined;
  const normalized = normalizeRuntimeCommandToken(command);
  if (!normalized) return undefined;
  const definition = lookupDefinition(normalized);
  if (!definition || definition.runtime !== runtime) return undefined;
  return normalized as RuntimeCommandId;
}

function normalizeRuntimeCommandToken(command: string): string {
  const normalized = command.trim().replace(/^\/+/, '');
  if (normalized.startsWith('$')) {
    return `skills:${normalized.slice(1)}`;
  }
  return normalized;
}

export function isCodexSkillCommandId(command?: string): boolean {
  if (!command) return false;
  const normalized = normalizeRuntimeCommandToken(command);
  return dynamicCommands.get(normalized)?.kind === 'codex_skill';
}

export function getCodexSkillName(command?: string): string | undefined {
  if (!command) return undefined;
  const normalized = normalizeRuntimeCommandToken(command);
  const definition = lookupDefinition(normalized);
  if (definition?.kind === 'codex_skill') return definition.skillName;
  return undefined;
}

export function isBuiltinCommandId(command?: string): command is BuiltinCommandId {
  return normalizeBuiltinCommandId(command) !== undefined;
}

export function getBuiltinCommandDefinition(command?: string): BuiltinCommandDefinition | undefined {
  const normalized = normalizeBuiltinCommandId(command);
  if (!normalized) return undefined;
  return BUILTIN_COMMANDS[normalized];
}

export function getRuntimeCommandDefinition(command: string | undefined, runtime: AgentRuntime): BuiltinCommandDefinition | undefined {
  const normalized = normalizeRuntimeCommandId(command, runtime);
  if (!normalized) return undefined;
  return lookupDefinition(normalized);
}

export function getRuntimeCommands(runtime: AgentRuntime): BuiltinCommandDefinition[] {
  const staticDefs = RUNTIME_COMMAND_IDS
    .map((id) => RUNTIME_COMMANDS[id])
    .filter((definition) => definition.runtime === runtime);
  const dynamicDefs = [...dynamicCommands.values()].filter((definition) => definition.runtime === runtime);
  return [...staticDefs, ...dynamicDefs];
}
