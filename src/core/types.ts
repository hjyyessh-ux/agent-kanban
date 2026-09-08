// Kanban card statuses
export type KanbanStatus = 'todo' | 'in_progress' | 'complete' | 'done';
export type QueueSessionMode = 'new_session' | 'continue_queued_after_session';
export type CardResolution = 'completed' | 'superseded' | 'failed';
export type CardOriginChannel = 'telegram' | 'scheduler' | 'quick_action';
export type CardExecutionKind = 'agent' | 'script';
export type TelegramReplyStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type AgentRuntime = 'opencode' | 'codex' | 'claude';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
export type ScheduledDispatchStatus = 'scheduled' | 'dispatching' | 'dispatched' | 'failed';
export type SchedulerEditState = 'ready' | 'edit-required';

/**
 * Sentinel prepended to every wiki LLM prompt. The wiki worker runs codex/claude
 * one-shots; without a guard those would be picked up by the prompt hooks and
 * turned into board cards (then re-archived into the wiki queue — a feedback
 * loop). Lives in core so `store.createCard` can guard on it without importing
 * the plugin layer. Keep stable: hooks + chat-message.ts match it verbatim.
 */
export const WIKI_INTERNAL_MARKER = '[[KANBAN_WIKI_INTERNAL]]';

/**
 * Env var the wiki worker sets when spawning its one-shot CLIs. The Claude/Codex
 * UserPromptSubmit hook scripts exit early when it is present, so the card is
 * never even POSTed. Must match the literal used in `.claude`/`.codex` hooks.
 */
export const WIKI_INTERNAL_ENV = 'AGENT_KANBAN_WIKI_INTERNAL';

export interface DispatchResult {
  sessionId: string;
  runId: string;
  startedAt: string;
}

export type QuickActionRunStatus = 'dispatching' | 'accepted' | 'running' | 'completed' | 'failed';

export interface QuickActionRunState {
  status: QuickActionRunStatus;
  dispatch: DispatchResult | null;
  scriptRunId?: string;
  failureSummary?: string;
  errorStatusCode?: number;
  updatedAt: string;
}

export interface CodexOptions {
  reasoningEffort?: CodexReasoningEffort;
  sandbox?: CodexSandboxMode;
  skipGitRepoCheck?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

export interface ClaudeOptions {
  permissionMode?: ClaudePermissionMode;
  dangerouslySkipPermissions?: boolean;
}

// ─── Quick Action Types ────────────────────────────────────────────

export const QUICK_ACTION_ICON_PALETTE = [
  '⚡',
  '🔍',
  '🧪',
  '🚀',
  '🛠️',
  '📊',
  '🧹',
  '🛡️',
  '🔔',
  '📦',
] as const;

/** Icons are unique across all Quick Actions, including custom emoji. */
export const QUICK_ACTION_ICON_DUPLICATE_POLICY = 'reject' as const;

/** Stable validation messages shared by the store, routes, and editor UI. */
export const QUICK_ACTION_ICON_ERRORS = {
  invalid: 'Quick action icon must be exactly one visible emoji grapheme',
  duplicate: 'Quick action icon is already in use',
  paletteExhausted: 'Quick action default icon palette is exhausted',
} as const;

const QUICK_ACTION_ICON_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const QUICK_ACTION_RGI_EMOJI_PATTERN = new RegExp('^(?:\\p{RGI_Emoji})$', 'v');
const QUICK_ACTION_CONTROL_PATTERN = /\p{Control}/u;
const QUICK_ACTION_WHITESPACE_PATTERN = /\p{White_Space}/u;

/**
 * Normalizes a custom Quick Action emoji for persistence and duplicate checks.
 * Unicode RGI emoji sequences include valid ZWJ, flag, keycap, modifier, and
 * tag sequences; whitespace, controls, malformed sequences, and text-only
 * graphemes are rejected.
 */
export function normalizeQuickActionIcon(value: unknown): string {
  if (typeof value !== 'string') throw new Error(QUICK_ACTION_ICON_ERRORS.invalid);
  const normalized = value.normalize('NFC');
  const graphemes = Array.from(QUICK_ACTION_ICON_SEGMENTER.segment(normalized));
  if (graphemes.length !== 1 || graphemes[0]?.segment !== normalized) {
    throw new Error(QUICK_ACTION_ICON_ERRORS.invalid);
  }
  if (
    QUICK_ACTION_WHITESPACE_PATTERN.test(normalized)
    || QUICK_ACTION_CONTROL_PATTERN.test(normalized)
    || !QUICK_ACTION_RGI_EMOJI_PATTERN.test(normalized)
  ) {
    throw new Error(QUICK_ACTION_ICON_ERRORS.invalid);
  }
  return normalized;
}

export type QuickActionParameterValue = string | number | boolean;
export type QuickActionParameterSnapshot = Record<string, QuickActionParameterValue>;

interface QuickActionParameterDefinitionBase {
  key: string;
  label: string;
  required: boolean;
}

export interface QuickActionStringParameterDefinition extends QuickActionParameterDefinitionBase {
  type: 'string';
  defaultValue?: string;
  options?: never;
}

export interface QuickActionNumberParameterDefinition extends QuickActionParameterDefinitionBase {
  type: 'number';
  defaultValue?: number;
  options?: never;
}

export interface QuickActionBooleanParameterDefinition extends QuickActionParameterDefinitionBase {
  type: 'boolean';
  defaultValue?: boolean;
  options?: never;
}

export interface QuickActionSelectParameterDefinition extends QuickActionParameterDefinitionBase {
  type: 'select';
  options: string[];
  defaultValue?: string;
}

export interface QuickActionSecretParameterDefinition extends QuickActionParameterDefinitionBase {
  type: 'secret';
  defaultValue?: never;
  options?: never;
}

export type QuickActionParameterDefinition =
  | QuickActionStringParameterDefinition
  | QuickActionNumberParameterDefinition
  | QuickActionBooleanParameterDefinition
  | QuickActionSelectParameterDefinition
  | QuickActionSecretParameterDefinition;

export interface QuickActionBase {
  id: string;
  icon: string;
  name: string;
  description: string;
  enabled: boolean;
  pinned: boolean;
  order: number;
  parameterDefinitions: QuickActionParameterDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptQuickAction extends QuickActionBase {
  type: 'prompt';
  cardTitleTemplate: string;
  promptTemplate: string;
  projectDir: string;
  agentRuntime: AgentRuntime;
  model?: string;
  agentType?: string;
  command?: string;
  argumentsTemplate?: string;
  codexOptions?: CodexOptions;
  claudeOptions?: ClaudeOptions;
}

export interface ScriptQuickAction extends QuickActionBase {
  type: 'script';
  /** Reference to ScriptStore. Script content is never copied into this object. */
  scriptId: string;
  /** Optional override; otherwise ScriptEntry.projectDir is used at execution time. */
  projectDir?: string;
}

export type QuickAction = PromptQuickAction | ScriptQuickAction;

export type QuickActionView = QuickAction & {
  available: boolean;
  unavailableReason?: string;
  effectiveProjectDir?: string;
  /** Resolved display snapshot for Script actions; script content is never exposed here. */
  scriptName?: string;
};

interface CreateQuickActionBaseInput {
  /** Omit to atomically claim the first unused icon from QUICK_ACTION_ICON_PALETTE. */
  icon?: string;
  name: string;
  description: string;
  enabled?: boolean;
  pinned?: boolean;
  order?: number;
  parameterDefinitions?: QuickActionParameterDefinition[];
}

export interface CreatePromptQuickActionInput extends CreateQuickActionBaseInput {
  type: 'prompt';
  cardTitleTemplate: string;
  promptTemplate: string;
  projectDir: string;
  agentRuntime: AgentRuntime;
  model?: string;
  agentType?: string;
  command?: string;
  argumentsTemplate?: string;
  codexOptions?: CodexOptions;
  claudeOptions?: ClaudeOptions;
}

export interface CreateScriptQuickActionInput extends CreateQuickActionBaseInput {
  type: 'script';
  scriptId: string;
  projectDir?: string;
}

export type CreateQuickActionInput = CreatePromptQuickActionInput | CreateScriptQuickActionInput;

export interface UpdateQuickActionInput {
  type?: 'prompt' | 'script';
  icon?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  pinned?: boolean;
  order?: number;
  parameterDefinitions?: QuickActionParameterDefinition[];
  cardTitleTemplate?: string;
  promptTemplate?: string;
  projectDir?: string | null;
  agentRuntime?: AgentRuntime;
  model?: string | null;
  agentType?: string | null;
  command?: string | null;
  argumentsTemplate?: string | null;
  codexOptions?: CodexOptions | null;
  claudeOptions?: ClaudeOptions | null;
  scriptId?: string;
}

export interface QuickActionStoreState {
  version: 1;
  entries: QuickAction[];
  lastModified: string;
}

export interface RunQuickActionInput {
  clientRequestId: string;
  parameterValues: Record<string, QuickActionParameterValue>;
}

export interface RunQuickActionResponse {
  cardId: string;
  status: KanbanStatus;
  dispatch: DispatchResult | null;
  runId?: string;
  runStatus?: ScriptRun['status'];
  failureSummary?: string;
}

// A single inter-agent message captured from a subagent's transcript at
// SubagentStop. `out` = a SendMessage this subagent sent (to a peer or main);
// `in` = a message it received (the initial dispatch from main, or a
// coordinator-relayed peer message). The full ordered list reconstructs the
// peer-to-peer thread that would otherwise live only in the transcript JSONL.
export interface AgentMessage {
  direction: 'in' | 'out';
  to?: string;       // recipient (out): peer name/agentId or 'main'
  from?: string;     // sender (in): 'main' | 'coordinator'
  summary?: string;  // SendMessage summary line (out)
  message: string;   // message body
}

// ─── Card Git + Usage Tracking ──────────────────────────────────────
// dispatch~완료 사이의 git 브랜치 활동과 실제 사용한 tool/skill/MCP/subagent를
// 카드에 기록한다. RESULT 와 분리되어 (agentMessages 와 동일한 패턴) 별도 섹션으로
// 표시된다. 캡처 지점(2/4)·UI(3/4)는 이 카드 범위 밖이며 여기서는 모델만 정의한다.

// dispatch 시점/완료 시점의 작업 트리 한 컷.
export interface CardGitSnapshot {
  branch: string;       // 현재 브랜치명 (detached HEAD 면 'HEAD')
  commit: string;       // HEAD 커밋 SHA
  dirty?: boolean;      // 커밋되지 않은 변경이 있었는지
  capturedAt: string;   // ISO 8601
}

// 한 브랜치의 run 전후 변화. snapshotAllBranches() 두 컷을 diffBranches() 로 비교해 만든다.
export interface CardGitBranchActivity {
  branch: string;          // 브랜치명
  baseCommit?: string;     // run 시작 시 tip SHA (신규 브랜치면 없음)
  headCommit?: string;     // run 종료 시 tip SHA
  commitsAdded?: number;   // run 동안 이 브랜치에 추가된 커밋 수 (count 정보가 있을 때만)
}

export interface CardGitState {
  repoRoot?: string;                    // 저장소 루트 절대경로
  start?: CardGitSnapshot;              // dispatch 시점 스냅샷
  end?: CardGitSnapshot;               // 완료 시점 스냅샷
  branches?: CardGitBranchActivity[];   // 브랜치별 활동 diff
  // dispatch 시점의 branch→SHA 맵 (diffBranches 의 before 입력). 완료 시점 캡처가
  // 끝나면 branches 로 환원되고 제거되는 bookkeeping 용도다. UI 에는 노출하지 않는다.
  startBranches?: Record<string, string>;
  updatedAt: string;                    // ISO 8601
}

// run 동안 실제로 호출된 도구 사용 집계. card.skills(로드 예정)와 달리
// usage.skillsUsed 는 transcript 에서 실제 invoke 된 skill 만 담는다.
export interface CardUsageStats {
  tools?: Record<string, number>;     // tool 이름 → 호출 횟수 (MCP/Skill 제외)
  mcpServers?: string[];              // 사용된 MCP 서버 이름 (distinct, 정렬)
  mcpTools?: Record<string, number>; // 'server__tool' → 호출 횟수
  commands?: string[];                // 실제 실행된 shell command 원문 (실행 순서 유지)
  skillsUsed?: string[];              // 실제 invoke 된 skill 이름 (distinct, 정렬)
  subagents?: string[];               // spawn 된 subagent agentType (distinct, 정렬)
  updatedAt: string;                  // ISO 8601
}

// run 중 실행된 개별 처리 단계 하나. events.jsonl 을 파싱해 만들며 실행 순서를
// 유지한다. 카드에는 저장하지 않고 GET /api/cards/:id/progress 로만 서빙한다.
export type RunProgressStepKind = 'skill' | 'mcp' | 'agent' | 'memory' | 'command' | 'tool';

export interface RunProgressStep {
  kind: RunProgressStepKind;
  label: string;    // skill 이름, mcp__server__tool, agentType, tool 이름 등
  detail?: string;  // command / 파일 경로 / description 전체
  body?: string;    // 클릭 시 펼치는 본문: Edit old/new diff, Bash 전체 command, Write 내용 등
}

// 카드의 최신 runtime run 에 대한 처리과정 타임라인 + 사용 요약.
// in_progress 카드에는 실시간(파일이 append 중), 완료 카드에는 사후 조회로 쓰인다.
// source: 'run' = 보드 dispatch run 의 events.jsonl, 'transcript' = 인터랙티브
// Claude Code 세션의 ~/.claude/projects/<dir>/<sessionId>.jsonl 폴백.
export interface CardRunProgress {
  runId: string;
  source: 'run' | 'transcript';
  runtime: AgentRuntime;
  runStatus: string;        // starting | running | completed | failed | aborted
  startedAt: string;        // ISO 8601
  finishedAt?: string;      // ISO 8601
  steps: RunProgressStep[]; // 전체 실행 순서 유지
  totalSteps: number;       // 전체 단계 수
  summary: {
    skills: string[];       // distinct, 정렬
    mcpServers: string[];
    agents: string[];
    memory: string[];       // 읽거나 쓴 memory 파일 (짧은 경로)
    tools: string[];
  };
}

/**
 * One-shot dispatch reservation for a top-level todo card.
 * State transitions:
 * scheduled -> dispatching -> dispatched
 * scheduled -> dispatching -> failed
 * failed/dispatched -> scheduled (when the card is re-scheduled)
 */
export interface ScheduledDispatchState {
  scheduledAt: string;      // ISO 8601 UTC due time
  status: ScheduledDispatchStatus;
  dispatchedAt?: string;    // ISO 8601 UTC when runtime accepted the dispatch
  error?: string;           // last dispatch failure reason
  updatedAt: string;        // ISO 8601 UTC audit stamp for the reservation itself
}

// Core kanban card
export interface KanbanCard {
  id: string;              // nanoid
  title: string;           // task summary
  description: string;     // detailed description / user instruction
  status: KanbanStatus;
  sessionId?: string;      // opencode session that owns this card
  sessionTitle?: string;    // opencode session title (for display)
  sessionCreatedAt?: string; // opencode session creation time (ISO 8601)
  projectDir?: string;     // project directory context
  model?: string;          // AI model used
  agentRuntime?: AgentRuntime; // execution runtime; legacy cards default to opencode
  codexOptions?: CodexOptions;
  claudeOptions?: ClaudeOptions;
  messageId?: string;      // unique message ID for per-message dedup
  parentCardId?: string;   // parent card ID (for subagent tasks)
  linkKind?: 'subagent' | 'nested' | 'worker'; // how this child relates to its parent
  childTaskId?: string;    // Claude task_* natural key (from task_started.task_id)
  childToolUseId?: string; // tool_use_id from the Agent tool call (auxiliary key)
  childRunId?: string;     // parent run ID (composite key scoping)
  rootCardId?: string;     // tree root card (for multi-level hierarchies)
  agentType?: string;      // agent type (e.g., 'explore', 'librarian', 'oracle')
  command?: string;        // builtin command id that initiated this card (e.g., 'start-work')
  arguments?: string;      // arguments for the slash command
  skills?: string[];       // skills loaded for this task
  sourceContext?: string;  // workflow context summary (plan name, skill+directory, etc.)
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  deletedAt?: string;      // ISO 8601 — soft-deleted cards are hidden from active views
  progressSummary?: string; // in_progress: what's happening
  result?: string;         // complete: what was delivered
  agentMessages?: AgentMessage[]; // inter-agent messages captured from the subagent transcript (SubagentStop)
  responseAt?: string;     // ISO 8601 — when an agent response was applied to the card
  startedAt?: string;      // ISO 8601 — when the card first entered in_progress
  completedAt?: string;    // ISO 8601 — when the card most recently entered complete
  durationMs?: number;     // execution duration in ms (completedAt − startedAt)
  completedSeenAt?: string; // ISO 8601 — when the user first opened/confirmed that completion
  favorite?: boolean;
  resolution?: CardResolution;
  supersededByCardId?: string;
  supersededAt?: string;
  scheduledDispatch?: ScheduledDispatchState;
  // TODO: Add labels?: string[]
  // TODO: Add priority?: 'low' | 'medium' | 'high' | 'urgent'
  // TODO: Add sessionLinks?: string[] (link to related sessions)
  queuedAfterCardId?: string;   // ID of the card this is queued after
  feedbackForCardId?: string;  // ID of the card this feedback is for (traceability)
  queuePosition?: number;       // position in queue (1 = next)
  queueSessionMode?: QueueSessionMode;
  screenshots?: Screenshot[];  // attached screenshots
  staleStatus?: 'orphan' | 'stuck' | null;  // detected stale state (orphan=session gone, stuck=no progress)
  dispatchType?: 'instant' | 'manual';  // instant = auto-dispatch on creation (e.g., from Telegram)
  telegramChatId?: number;              // Telegram chat ID for response messages
  originChannel?: CardOriginChannel;
  executionKind?: CardExecutionKind;
  quickActionId?: string;
  quickActionRequestId?: string;
  quickActionRun?: QuickActionRunState;
  scriptRunId?: string;
  scriptName?: string;       // immutable execution-time ScriptEntry.name snapshot
  parameterSnapshot?: QuickActionParameterSnapshot;
  schedulerId?: string;       // scheduler entry ID that created this card
  schedulerRunId?: string;    // scheduler run ID that created this card
  schedulerName?: string;     // scheduler name snapshot at creation time
  telegramMessageId?: string;           // Telegram origin message ID
  telegramSenderId?: string;            // Telegram sender user ID
  telegramMessageTimestamp?: string;    // Telegram message timestamp (ISO 8601)
  telegramReplyStatus?: TelegramReplyStatus; // Telegram reply delivery status
  telegramReplyMessageId?: number;
  telegramReplyError?: string;          // Error message if delivery failed
  telegramReplyUpdatedAt?: string;
  staleDetectedAt?: string;  // ISO 8601 — when stale status was first detected
  resumeSessionId?: string;  // user-selected session ID to resume on dispatch
  wiki?: CardWikiState;      // LLM wiki processing state (stamped at archive time)
  git?: CardGitState;        // dispatch~완료 사이 git 브랜치 활동 (RESULT 와 분리 표시)
  usage?: CardUsageStats;    // run 동안 실제 사용한 tool/skill/MCP/subagent 집계
}

// ─── LLM Wiki Types ─────────────────────────────────────────────────
// Done 카드가 아카이브될 때 LLM이 위키 문서로 분류·생성한 결과를 카드에 기록한다.
// 백필 판단 기준: wiki 없음 → 대상, promptVersion < 현재 버전 → 재처리 대상.

export type WikiProcessStatus = 'pending' | 'processed' | 'failed';
export type WikiDecision = 'kept' | 'skipped';
export type WikiDocType = 'troubleshooting' | 'howto' | 'decision' | 'concept' | 'reference';
export type WikiLlmRoute = 'codex' | 'claude';

export interface CardWikiState {
  status: WikiProcessStatus;
  decision?: WikiDecision;
  skipReason?: string;       // decision=skipped일 때 triage가 남긴 이유
  docPath?: string;          // vault-relative path (e.g. 'troubleshooting/redis-timeout.md')
  docTitle?: string;
  docType?: WikiDocType;
  topics?: string[];
  queuedAt?: string;         // ISO 8601 — pending으로 큐잉된 시각
  processedAt?: string;      // ISO 8601 — 처리 완료 시각
  promptVersion?: number;    // 처리에 사용한 프롬프트 버전
  model?: string;            // 처리에 사용한 wiki LLM model (신규 처리분부터 기록)
  route?: WikiLlmRoute;      // model routing: gpt-* → codex, otherwise claude
  effort?: CodexReasoningEffort; // 처리에 사용한 effort (route가 지원하는 shared subset)
  error?: string;            // status=failed일 때 마지막 오류
}

// Aggregate counts across the whole archive, computed by the store.
export interface WikiStats {
  total: number;        // active archived cards
  kept: number;         // cards whose group was kept
  skipped: number;      // cards whose group was skipped by triage
  failed: number;       // cards whose group failed processing
  pending: number;      // cards queued, not yet processed
  unprocessed: number;  // cards never queued (no wiki state)
  docCount: number;     // unique kept documents (cards collapse into shared docs)
  byType: Record<WikiDocType, number>; // unique kept docs per type
}

export type WikiArchiveCardStatusFilter =
  | 'all'
  | 'kept'
  | 'skipped'
  | 'failed'
  | 'pending'
  | 'unprocessed';

export interface WikiArchiveCardsQuery {
  limit?: number;
  cursor?: string;
  status?: WikiArchiveCardStatusFilter;
  q?: string;
}

export interface WikiArchiveCardsResponse {
  cards: KanbanCard[];
  nextCursor: string | null;
  totalApprox?: number;
}

// A single worker activity log line, surfaced to the UI.
export interface WikiLogEntry {
  at: string;                       // ISO 8601
  level: 'info' | 'warn' | 'error';
  message: string;
  model?: string;
  route?: WikiLlmRoute;
  effort?: CodexReasoningEffort;
}

// Worker status DTO shared with the web UI
export interface WikiWorkerStatus {
  enabled: boolean;
  running: boolean;
  pendingCount: number;
  processedInRun: number;
  totalInRun: number;
  promptVersion: number;
  vaultDir: string;
  model: string;                    // active wiki LLM model
  route: WikiLlmRoute;              // active wiki LLM route
  effort: CodexReasoningEffort;     // active effort for routes that support it
  stats: WikiStats;
  recentLogs: WikiLogEntry[];       // most recent worker activity (capped)
  lastError?: string;
  lastFinishedAt?: string;
}

/**
 * Current wiki configuration as surfaced to the WIKI tab. `configured` is false
 * until the user explicitly saves settings from the tab — there is no boot-time
 * auto-seed, so an unconfigured wiki shows a setup prompt instead of running.
 */
export interface WikiConfigDto {
  configured: boolean;
  enabled: boolean;
  model: string;
  route: WikiLlmRoute;
  effort: CodexReasoningEffort;
  vaultDir: string;
}

/** Partial wiki config update from the WIKI tab; only provided fields are saved. */
export interface WikiConfigInput {
  enabled?: boolean;
  model?: string;
  effort?: CodexReasoningEffort;
  vaultDir?: string;
}

// Screenshot attachment
export interface Screenshot {
  id: string;              // nanoid
  cardId: string;          // parent card ID
  filename: string;        // stored filename: {cardId}_{timestamp}_{nanoid}.{ext}
  originalName?: string;   // original filename before rename
  mimeType: string;        // e.g., 'image/png'
  size: number;            // file size in bytes
  createdAt: string;       // ISO 8601
}

// Archive storage (one file per month)
export interface KanbanArchive {
  month: string;         // "2026-02" (YYYY-MM format)
  cards: KanbanCard[];
  archivedAt: string;    // ISO 8601 timestamp of archival
}

// Board state (stored as JSON)
export interface KanbanBoard {
  version: 1;
  cards: KanbanCard[];
  lastModified: string;   // ISO 8601
}

// API request/response types
export interface CreateScheduledDispatchInput {
  scheduledAt: string; // ISO 8601 UTC due time, validated from a KST datetime input
}

export interface CreateCardInput {
  title: string;
  description: string;
  projectDir?: string;
  model?: string;
  agentRuntime?: AgentRuntime;
  codexOptions?: CodexOptions;
  claudeOptions?: ClaudeOptions;
  sessionId?: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  parentCardId?: string;
  linkKind?: 'subagent' | 'nested' | 'worker';
  childTaskId?: string;
  childToolUseId?: string;
  childRunId?: string;
  rootCardId?: string;
  agentType?: string;
  messageId?: string;
  command?: string;
  arguments?: string;
  skills?: string[];
  sourceContext?: string;
  feedbackForCardId?: string;
  scheduledDispatch?: CreateScheduledDispatchInput;
  queueSessionMode?: QueueSessionMode;
  resumeSessionId?: string;
  dispatchType?: 'instant' | 'manual';
  telegramChatId?: number;
  originChannel?: CardOriginChannel;
  executionKind?: CardExecutionKind;
  quickActionId?: string;
  quickActionRequestId?: string;
  scriptRunId?: string;
  scriptName?: string;
  parameterSnapshot?: QuickActionParameterSnapshot;
  schedulerId?: string;
  schedulerRunId?: string;
  schedulerName?: string;
  telegramMessageId?: string;
  telegramSenderId?: string;
  telegramMessageTimestamp?: string;
  telegramReplyStatus?: TelegramReplyStatus;
  telegramReplyMessageId?: number;
  telegramReplyError?: string;
  telegramReplyUpdatedAt?: string;
}

export interface UpdateCardInput {
  status?: KanbanStatus;
  title?: string;
  description?: string;
  model?: string | null;
  agentRuntime?: AgentRuntime;
  codexOptions?: CodexOptions | null;
  claudeOptions?: ClaudeOptions | null;
  command?: string | null;
  arguments?: string | null;
  progressSummary?: string;
  result?: string;
  agentMessages?: AgentMessage[];
  responseAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  completedSeenAt?: string | null;
  sessionId?: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  favorite?: boolean;
  scheduledDispatch?: ScheduledDispatchState | null;
  queuedAfterCardId?: string | null;  // null = clear from queue
  queuePosition?: number | null;      // null = clear from queue
  queueSessionMode?: QueueSessionMode | null;
  projectDir?: string;
  agentType?: string | null;
  staleStatus?: 'orphan' | 'stuck' | null;  // null = clear stale flag
  staleDetectedAt?: string | null;           // null = clear detection timestamp
  resumeSessionId?: string | null;           // null = clear session resume
  resolution?: CardResolution | null;
  supersededByCardId?: string | null;
  supersededAt?: string | null;
  originChannel?: CardOriginChannel | null;
  schedulerId?: string | null;
  schedulerRunId?: string | null;
  schedulerName?: string | null;
  telegramMessageId?: string | null;
  telegramReplyStatus?: TelegramReplyStatus | null;
  telegramReplyMessageId?: number | null;
  telegramReplyError?: string | null;
  telegramReplyUpdatedAt?: string | null;
  git?: CardGitState;        // git 브랜치 활동 (캡처 단계에서 기록)
  usage?: CardUsageStats;    // 사용 도구 집계 (캡처 단계에서 기록)
}

// ─── Scheduler Types ────────────────────────────────────────────────

export type SchedulerStatus = 'active' | 'inactive';
export type SchedulerActionType = 'bash' | 'prompt';
export type SchedulerScheduleMode = 'simple' | 'cron';
export type SchedulerSimpleRepeat = 'minutes' | 'hours' | 'daily' | 'weekdays' | 'weekly';

export interface SchedulerSimpleScheduleInput {
  repeat: SchedulerSimpleRepeat;
  interval?: number;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
}

export type SchedulerScheduleInputState =
  | {
    mode: 'simple';
    simple: SchedulerSimpleScheduleInput;
  }
  | {
    mode: 'cron';
    expression: string;
  };

export interface SchedulerLegacyActionSnapshot {
  type: 'shell' | 'skill';
  command?: string;
  cwd?: string;
  skillName?: string;
  skillInput?: string;
}

interface SchedulerActionBase {
  editState?: SchedulerEditState;
  legacy?: SchedulerLegacyActionSnapshot;
}

export interface BashSchedulerAction extends SchedulerActionBase {
  type: 'bash';
  command: string;
  cwd?: string;
}

export interface PromptSchedulerAction extends SchedulerActionBase {
  type: 'prompt';
  prompt: string;
  projectDir?: string;
  agentRuntime?: AgentRuntime;
  model?: string;
  codexOptions?: CodexOptions;
  claudeOptions?: ClaudeOptions;
}

export type SchedulerAction = BashSchedulerAction | PromptSchedulerAction;

export interface SchedulerRun {
  id: string;              // nanoid
  schedulerId: string;     // parent scheduler entry ID
  startedAt: string;       // ISO 8601
  finishedAt?: string;     // ISO 8601
  status: 'running' | 'success' | 'fail';
  cardId?: string;         // prompt schedulers link to the created board card
  dispatched?: boolean;    // whether a prompt scheduler reached manual dispatch acceptance
  dispatchAcceptedAt?: string; // dispatch receipt time, distinct from card completion
  exitCode?: number;       // shell exit code
  stdout?: string;         // capped at 8KB
  stderr?: string;         // capped at 8KB
  error?: string;          // error message if failed
}

export interface SchedulerEntry {
  id: string;              // nanoid
  name: string;            // human-readable name
  description: string;     // what this scheduler does
  cron: string;            // 5-field cron expression
  cronDescription?: string; // human-readable cron description
  scheduleInput?: SchedulerScheduleInputState; // UI restoration metadata for schedule mode/input
  timezone: 'Asia/Seoul';  // fixed to KST
  status: SchedulerStatus;
  action: SchedulerAction;
  lastRunAt?: string;      // ISO 8601
  nextRunAt?: string;      // ISO 8601 — computed by cron engine
  lastRunStatus?: 'success' | 'fail';
  history: SchedulerRun[]; // last 20 runs (most recent first)
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

export interface SchedulerStoreState {
  version: 1;
  entries: SchedulerEntry[];
  lastModified: string;    // ISO 8601
}

export interface CreateSchedulerInput {
  name: string;
  description: string;
  cron: string;
  cronDescription?: string;
  scheduleInput?: SchedulerScheduleInputState;
  timezone?: string;       // accepted for legacy callers, normalized to Asia/Seoul
  action: SchedulerAction;
}

export interface UpdateSchedulerInput {
  name?: string;
  description?: string;
  cron?: string;
  cronDescription?: string;
  scheduleInput?: SchedulerScheduleInputState;
  timezone?: string;       // accepted for legacy callers, normalized to Asia/Seoul
  status?: SchedulerStatus;
  action?: SchedulerAction;
}

// ─── Settings Types ─────────────────────────────────────────────────

export interface SettingsEntry {
  id: string;              // nanoid
  key: string;             // e.g., 'GOOGLE_AUTH_TOKEN'
  value: string;           // the secret value
  description: string;     // what this setting is for
  category?: string;       // optional grouping (e.g., 'api_keys', 'tokens')
  masked?: boolean;        // whether to mask in UI (default true for secrets)
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

export interface SettingsStoreState {
  version: 1;
  entries: SettingsEntry[];
  lastModified: string;    // ISO 8601
}

export interface CreateSettingsInput {
  key: string;
  description: string;
  value: string;
  category?: string;
  masked?: boolean;
}

export interface UpdateSettingsInput {
  key?: string;
  description?: string;
  value?: string;
  category?: string;
  masked?: boolean;
}

export interface TelegramChatState {
  chatId: number;
  selectedSessionId?: string;
  selectedCardId?: string;
  selectedAgentRuntime?: AgentRuntime;
  defaultAgentType?: string;
  defaultModel?: string;
  defaultAgentRuntime?: AgentRuntime;
  defaultProjectDir?: string;
  defaultClaudePermissionMode?: ClaudePermissionMode;
  defaultClaudeDangerouslySkipPermissions?: boolean;
  defaultCodexSandbox?: CodexSandboxMode;
  mode: 'auto' | 'pinned';
  lastReminderAt?: string;
  lastAcknowledgedAt?: string;
  updatedAt: string;
}

export interface TelegramStateStoreState {
  version: 1;
  entries: TelegramChatState[];
  lastModified: string;
}

export interface UpdateTelegramChatStateInput {
  selectedSessionId?: string | null;
  selectedCardId?: string | null;
  selectedAgentRuntime?: AgentRuntime | null;
  defaultAgentType?: string | null;
  defaultModel?: string | null;
  defaultAgentRuntime?: AgentRuntime | null;
  defaultProjectDir?: string | null;
  defaultClaudePermissionMode?: ClaudePermissionMode | null;
  defaultClaudeDangerouslySkipPermissions?: boolean | null;
  defaultCodexSandbox?: CodexSandboxMode | null;
  mode?: 'auto' | 'pinned';
  lastReminderAt?: string | null;
  lastAcknowledgedAt?: string | null;
}

// ─── Script Types ──────────────────────────────────────────────────

export type SupportedScriptLanguage = 'bash' | 'python' | 'javascript' | 'typescript' | 'bun' | 'ruby';

export interface ScriptRun {
  id: string;
  scriptId: string;
  cardId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'fail';
  language?: SupportedScriptLanguage;
  cwd?: string;
  scriptRevision?: string;
  ownerPid?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ScriptRunAcceptedResponse extends ScriptRun {
  cardId: string;
  runId: string;
  status: 'running';
}

export interface ScriptEntry {
  id: string;
  name: string;
  description: string;
  content: string;
  language: string;
  projectDir?: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'fail';
  history: ScriptRun[];
  createdAt: string;
  updatedAt: string;
}

export interface ScriptStoreState {
  version: 1;
  entries: ScriptEntry[];
  lastModified: string;
}

export interface CreateScriptInput {
  name: string;
  description: string;
  content: string;
  language?: string;
  projectDir?: string;
}

export interface UpdateScriptInput {
  name?: string;
  description?: string;
  content?: string;
  language?: string;
  projectDir?: string;
}

export interface ScriptSyncResult {
  created: number;
  updated: number;
  removed: number;
}

// ─── Skill discovery ────────────────────────────────────────────
// Skills are discovered from disk (`~/.claude/skills`, `~/.codex/skills`,
// `~/.agents/skills`) and merged into the runtime command registry so newly
// created skills surface in the board without a code change.
export type SkillRuntime = 'claude' | 'codex' | 'opencode';

export interface DiscoveredSkill {
  /** Runtime command id (e.g. 'pr-review' for claude, 'skills:foo' for codex). */
  id: string;
  runtime: SkillRuntime;
  kind: 'claude_skill' | 'codex_skill' | 'opencode_skill';
  /** Bare skill name used to build the invocation token (`/name` or `$name`). */
  skillName: string;
  /** Human-facing label shown in the picker (`/name` or `$name`). */
  displayName: string;
  description: string;
  /** Origin category for diagnostics (e.g. 'claude-user', 'codex-system'). */
  source: string;
  /** Absolute path to the directory containing this skill's SKILL.md. */
  directory: string;
  /** Absolute path to SKILL.md. */
  filePath?: string;
  /** MCP servers / tools referenced in frontmatter (`allowed-tools`/`tools`/`mcp`) or body (`mcp__*`). */
  tools?: string[];
  /** Human-readable scope label derived from source: 'user' | 'system'. */
  scope: string;
  /** Whether `disable-model-invocation: true` is set in SKILL.md frontmatter. */
  disableModelInvocation?: boolean;
}

export interface SkillStoreState {
  version: 1;
  skills: DiscoveredSkill[];
  lastSyncedAt: string;
}

export interface SkillSyncResult {
  claude: number;
  codex: number;
  opencode: number;
  total: number;
  lastSyncedAt: string;
}

// ─── Skill roots config ──────────────────────────────────────────
// User-configurable set of directories to scan for skills. Persisted to
// `~/.agent-kanban/skill-roots.json`. The scanner uses enabled roots only.
export interface SkillRoot {
  id: string;
  /** Absolute path to the skill directory (e.g. `~/.claude/skills`). */
  dir: string;
  agent: SkillRuntime;
  /** Origin label, e.g. 'claude-user', 'codex-system'. */
  source: string;
  enabled: boolean;
}

export interface SkillRootsStoreState {
  version: 1;
  roots: SkillRoot[];
  lastModified: string;
}

// ─── Scope Manager Types (Phase 0+) ─────────────────────────────
// §3.2 — shared across all Phases, defined once here.

export type CapScope = 'user' | 'project' | 'local' | 'cold';
export type McpRuntime = 'claude' | 'codex';

export function mcpInventoryIdentity(runtime: McpRuntime, name: string): string {
  return `${runtime}:${name}`;
}

export function mcpPlacementIdentity(
  runtime: McpRuntime,
  name: string,
  location: string,
  appliesToDir?: string,
): string {
  return [runtime, name, location, appliesToDir ?? ''].map(encodeURIComponent).join(':');
}

export interface PlacementTarget {
  id: string;
  label: string;            // "agent-kanban", "Global (user)"
  dir: string;              // absolute path; user/cold have fixed semantic values
  kind: CapScope;
  /** Runtime whose MCP config is addressed. Missing persisted values migrate to Claude. */
  runtime: McpRuntime;
  teamShared: boolean;      // project=git-shared true / local=false
  builtin?: boolean;        // user/cold fixed targets — cannot be deleted
  createdAt: string;
  updatedAt: string;
}

export interface McpServerDef {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Codex env var names/remote-source declarations forwarded to stdio servers. */
  envVars?: Array<string | { name: string; source?: 'local' | 'remote' }>;
  cwd?: string;
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
  enabled?: boolean;
  required?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  alwaysLoad?: boolean;
  [k: string]: unknown;
}

export interface McpPlacement {
  /** Stable identity for selecting one exact same-name placement. */
  identity: string;
  runtime: McpRuntime;
  scope: CapScope;
  location: string;         // actual config file path (~/.claude.json or <repo>/.mcp.json)
  /**
   * Project directory this placement belongs to.
   * - local: the `projects[dir]` key inside ~/.claude.json
   * - project: the repo dir containing .mcp.json
   * - user: undefined (lives in the top-level mcpServers map)
   * Required to correctly target move/remove/freeze for local & project scopes.
   */
  dir?: string;
  /** Directory whose effective Codex configuration chain this placement was evaluated for. */
  appliesToDir?: string;
  /** Codex config layer that owns this placement. Claude placements leave this unset. */
  configLayer?: 'user' | 'project' | 'subdirectory';
  /** Precedence within an evaluated Codex chain; larger/nearer values win. */
  precedence?: number;
  /** Whether this definition is the nearest same-name definition for appliesToDir. */
  effective?: boolean;
  /** Next nearer config path that overrides this same-name definition. */
  overriddenBy?: string;
  /** Definition from this exact Codex config layer. */
  definition?: McpServerDef;
  /** Project layers require trust, but inventory deliberately does not infer trust state. */
  projectTrust?: 'not-required' | 'required-status-unknown';
  alwaysLoad: boolean;
  hasPlaintextSecret: boolean;
  managed: boolean;         // plugin/enterprise — cannot be moved
}

export interface McpInventoryItem {
  /** Stable cross-runtime identity; same-name Claude/Codex servers remain distinct. */
  identity: string;
  runtime: McpRuntime;
  name: string;             // mcpServers key
  def: McpServerDef;
  placements: McpPlacement[];
  status: 'active' | 'needs-auth' | 'failed' | 'unknown';
  toolCount?: number;
  preloadReason?: 'alwaysLoad' | 'tool-search-off' | 'unsupported-runtime' | null;
}

export interface SkillVisibility {
  override: 'on' | 'name-only' | 'user-invocable-only' | 'off' | null;
  disableModelInvocation: boolean;
  effectivelyHidden: boolean;
}

export interface ContextDiagnostics {
  enableToolSearch: 'unset' | 'true' | 'false' | 'auto' | string;
  toolSearchEffective: boolean;
  runtimeSupportsToolSearch: boolean;
  userScopeMcpCount: number;
  alwaysLoadCount: number;
  /** Additive MCP discovery diagnostics; existing Claude diagnostic fields keep their meaning. */
  mcpDiscovery?: McpInventoryDiscoveryDiagnostics;
}

export interface McpConfigScanIssue {
  runtime: McpRuntime;
  path: string;
  code: 'invalid-config' | 'read-error' | 'scan-failed';
  message: string;
}

export interface CodexMcpDiscoveryDiagnostics {
  candidateConfigPaths: string[];
  scannedConfigPaths: string[];
  issues: McpConfigScanIssue[];
  projectTrust: {
    required: boolean;
    status: 'unknown';
    configPaths: string[];
  };
}

export interface McpInventoryDiscoveryDiagnostics {
  codex: CodexMcpDiscoveryDiagnostics;
}

export interface McpInventoryDiscoveryResult {
  items: McpInventoryItem[];
  diagnostics: McpInventoryDiscoveryDiagnostics;
}

export interface PlacementTargetsStoreState {
  version: 1;
  targets: PlacementTarget[];
  lastModified: string;
}

export interface CreatePlacementTargetInput {
  label: string;
  dir: string;
  kind: CapScope;
  teamShared: boolean;
  /** Omitted legacy/API inputs retain the pre-Codex Claude behavior. */
  runtime?: McpRuntime;
}

export type WritableMcpScope = 'user' | 'local' | 'project';

export interface McpCopyRequest {
  runtime?: McpRuntime;
  inventoryIdentity?: string;
  sourcePlacementIdentity?: string;
  targetId?: string;
  toScope: WritableMcpScope;
  targetDir?: string;
  projectDir?: string;
  forceSecret?: boolean;
}

export interface McpMoveRequest extends McpCopyRequest {
  fromScope: WritableMcpScope;
  fromDir?: string;
}

export interface McpDeleteRequest {
  runtime?: McpRuntime;
  inventoryIdentity?: string;
  placementIdentity?: string;
  scope: WritableMcpScope;
  targetDir?: string;
  projectDir?: string;
}

export interface McpAlwaysLoadRequest {
  runtime?: McpRuntime;
  inventoryIdentity?: string;
  placementIdentity?: string;
  location: string;
  scope: Extract<WritableMcpScope, 'user' | 'project'>;
  alwaysLoad: boolean;
}

// ─── Cold Storage Types (Phase 4) ─────────────────────────────
// Entries stored in ~/.agent-kanban/cold-storage/manifest.json

export interface ColdManifestEntry {
  kind: 'skill' | 'mcp';
  /** Unique ref: "runtime/name" for skill/Codex MCP; legacy Claude MCP keeps "name". */
  ref: string;
  runtime?: SkillRuntime;
  sourceScope: CapScope;
  /** Original absolute path (skill dir or config file) */
  sourcePath: string;
  projectRoot?: string;
  /** Exact original MCP placement. Missing legacy values are derived as Claude. */
  sourcePlacement?: {
    identity: string;
    runtime: McpRuntime;
    scope: CapScope;
    location: string;
    dir?: string;
    appliesToDir?: string;
  };
  /** For MCP: JSON.stringify(def) */
  originalConfigJson?: string;
  /** sha256 of folder contents or def JSON */
  hash: string;
  createdAt: string;
  restorePolicy: 'any' | 'same-scope';
}

/** Manifest entry enriched for list rendering — what `GET /api/scope/cold` returns. */
export interface ColdEntryView extends ColdManifestEntry {
  /** skill: SKILL.md frontmatter `description` · mcp: command line or URL */
  summary?: string;
}

// ─── Capabilities view model ─────────────────────────────────
// Frontend-only merged model for the Capabilities tab. Skills and scripts
// are keyed as `${type}:${id}` to prevent id collisions across stores.
export type CapabilityType = 'skill' | 'script';
export type CapabilityAgent = SkillRuntime | null;

export interface CapabilityItem {
  id: string;
  type: CapabilityType;
  name: string;
  agent: CapabilityAgent;
  directory: string;
  scope: string;
  description: string;
  tools?: string[];
  filePath?: string;
}

// ─── Works & Timeline Types ─────────────────────────────────────────
// A Work is a first-class, human-intent unit that groups one or more sessions
// (1:N — a session belongs to at most one Work). Sessions are joined by
// `sessionId`; the card model is untouched. Persisted to `~/.agent-kanban/works.json`.
// Works are never auto-created: new sessions surface in the Inbox until the user
// assigns or ignores them. `ignoredSessionIds` persists the Inbox "ignore" action.

export type WorkStatus = 'active' | 'done' | 'discarded';
/**
 * Why a Work closed.
 *
 * - `completed` — the `done` transition (its cards were swept into the archive).
 * - `abandoned` — the `discarded` transition.
 * - `superseded` — this Work was **merged into another one**
 *   (`POST /api/works/:id/merge`): its sessions moved to the target and
 *   `supersededByWorkId` points at it.
 *
 * `superseded` was removed once, for being unreachable: nothing wrote it,
 * because the only merge-shaped path then available (moving the last session out
 * of a Work) *deletes* the source rather than resolving it. It is back **with**
 * the transition that stamps it, which is the condition this type documents —
 * never add a resolution the server cannot produce.
 */
export type WorkResolution = 'completed' | 'abandoned' | 'superseded';
export type WorkSessionRole = 'dev' | 'review' | 'debug';

export interface WorkSessionLink {
  sessionId: string;
  projectDir?: string;
  linkedAt: string;      // ISO 8601 — when the session was linked to this Work
  role?: WorkSessionRole;
  /**
   * ISO 8601 — when this link was last observed to have **no cards left at all**
   * (every card of the session deleted off the board, and none in the archive
   * months the Work can reach). The link is kept rather than dropped: card
   * deletion is a soft delete and `restoreCard` un-does it, so silently
   * unlinking would turn one undo-able action into an unrecoverable one.
   *
   * A dangling link is not cosmetic — `resolveWorkStartedAt` falls back to
   * `linkedAt` for a session with no cards, so the Timeline bar quietly starts
   * at triage time instead of when the work began. `reconcileWorkSessionLinks`
   * stamps and clears it; `POST /api/works/:id/prune-sessions` is how the user
   * removes the links that are really gone.
   */
  cardsMissingAt?: string;
}

export interface WorkSummary {
  lines: string[];       // 3~5 lines, Korean (LLM-generated)
  generatedAt: string;   // ISO 8601
  model: string;         // model used to generate the summary
}

export interface Work {
  id: string;            // nanoid
  title: string;
  status: WorkStatus;
  resolution?: WorkResolution;
  sessionLinks: WorkSessionLink[];
  projectDir?: string;
  startedAt: string;     // ISO 8601 — min() over every linked session's earliest card time
  resolvedAt?: string;   // ISO 8601 — done/discard time → end of the Timeline bar
  summary?: WorkSummary;
  /**
   * Free-form human notes, up to `WORK_NOTES_MAX_LENGTH` characters.
   *
   * Deliberately separate from `summary`: that field is owned by the Summary LLM
   * (`POST /api/works/:id/summary` overwrites it wholesale), so anything a person
   * typed there was destroyed by the next regeneration. This is the field the
   * user owns, and no server path ever writes it.
   */
  notes?: string;
  archivedAt?: string;   // ISO 8601 — set when the Work's cards were bulk-archived
  /**
   * The Work this one was merged into (`POST /api/works/:id/merge`). Set together
   * with `status: 'discarded'` + `resolution: 'superseded'` on the *source* of a
   * merge, so a Resolved row can point at where its sessions actually went
   * instead of looking abandoned.
   */
  supersededByWorkId?: string;
  /**
   * Vault-relative path of the wiki document this Work was written to.
   *
   * A Work is one document, but its cards can reach the wiki queue in **more
   * than one batch** (a card archived while the Work was still active, then the
   * rest by the completion sweep). `WikiWorker` used to look for the previous
   * document only among the cards in the batch it was holding, so the second
   * batch found nothing to overwrite and wrote a *second* file under the same
   * Work title. Recording the path on the Work is what makes the overwrite
   * survive across batches. Server-owned: never accepted from a client patch.
   */
  wikiDocPath?: string;
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
}

/** Read-only list rollup. Never written to works.json. */
export interface WorkListEntry extends Work {
  activity?: Pick<WorkSessionsResponse, 'cardCount' | 'doneCount' | 'inProgressCount' | 'lastActivityAt'>;
}

export type WorkCardActivity = Pick<KanbanCard,
  'id' | 'title' | 'sessionId' | 'status' | 'createdAt' | 'startedAt' | 'completedAt' | 'updatedAt' | 'result'> & {
    archived: boolean;
  };

export interface WorkStoreState {
  version: 1;
  works: Work[];
  ignoredSessionIds: string[]; // Inbox "ignore" persistence — survives refresh
  lastModified: string;        // ISO 8601
}

/**
 * Cap on `Work.notes`. Long enough for a real handover note, short enough that
 * `works.json` (rewritten whole on every store write) does not grow without a
 * bound the API never states.
 */
export const WORK_NOTES_MAX_LENGTH = 4000;

/**
 * `GET /api/works?sort=` — how the Work list is ordered.
 *
 * - `updated` (default) — most recent activity first. The original behaviour.
 * - `stale` — **least** recent activity first. `updated` is exactly the wrong
 *   order for the question the Works tab is usually asked ("what have I left
 *   sitting?"): a Work nobody has touched for three weeks sank to the bottom of
 *   the list, which is where it was already invisible.
 * - `planned` — nearest planned end (`resolvedAt`) first; Works with no planned
 *   end sort last, by recent activity.
 */
export type WorkListSort = 'updated' | 'stale' | 'planned';

/** `GET /api/works` query, and the shape the pure `selectWorks` filter takes. */
export interface WorkListQuery {
  status?: WorkStatus;
  /** Exact `Work.projectDir` match. */
  projectDir?: string;
  /** Case-insensitive substring over title, directory, notes and Summary lines. */
  q?: string;
  sort?: WorkListSort;
}

/**
 * `POST /api/works/:id/reopen` — a terminal Work put back to `active`.
 *
 * Completing a Work was a one-way door: `PATCH` accepted `status: 'active'`
 * (which clears `resolvedAt`/`resolution`) but no UI sent it, the bulk-archived
 * cards never came back, and `archivedAt` stayed stamped — so the sweep could
 * never run again either. Deleting the Work was the only escape, and that threw
 * away the record along with it.
 *
 * `restoredCardIds` are the cards lifted back out of the monthly archive onto
 * the board (see `KanbanStore.unarchiveCards`). They come back **`done`**: the
 * sweep overwrote whatever status they had and that is not recoverable.
 */
export interface WorkReopenResponse {
  work: Work;
  restoredCardIds: string[];
  /** Archive month files read — diagnostics for the same monthly heuristic. */
  scannedMonths: string[];
}

/**
 * `POST /api/works/:id/merge` body. Merging is its own verb because the only
 * previous route to it was moving sessions out one at a time and waiting for the
 * source to empty — which *deletes* the source, losing its Summary and its
 * Timeline history.
 */
export interface MergeWorkInput {
  intoWorkId: string;
}

/**
 * Response of a merge. The source is **kept**, not deleted: it becomes
 * `discarded` / `resolution: 'superseded'` / `supersededByWorkId`, so the
 * Resolved list can still say where its sessions went.
 *
 * `skippedSessionIds` are sessions the target already held — the target's link
 * (with its role) wins, because it is the record that survives.
 */
export interface MergeWorkResponse {
  from: Work;
  to: Work;
  movedSessionIds: string[];
  skippedSessionIds: string[];
}

export interface CreateWorkInput {
  title: string;
  projectDir?: string;
  startedAt?: string;                 // defaults to now when omitted
  sessionLinks?: WorkSessionLink[];   // optional initial links (must obey the 1:N invariant)
}

export interface UpdateWorkInput {
  title?: string;
  status?: WorkStatus;
  resolution?: WorkResolution | null;
  projectDir?: string | null;
  startedAt?: string;
  resolvedAt?: string | null;
  summary?: WorkSummary | null;
  /** Human notes. `null` clears them; length-capped at `WORK_NOTES_MAX_LENGTH`. */
  notes?: string | null;
  /** Stamped by `WorkStore.mergeWork`. Rejected on `PATCH /api/works/:id`. */
  supersededByWorkId?: string | null;
  /** Server-owned (`claimArchiveSweep` stamps it). Rejected on `PATCH /api/works/:id`. */
  archivedAt?: string | null;
  /** Server-owned (`WikiWorker` stamps it). Rejected on `PATCH /api/works/:id`. */
  wikiDocPath?: string | null;
}

/**
 * PATCH /api/works/:id body — the store update input plus the route-only
 * `confirmArchive` flag. When `works.done_confirm` is on, the client shows the
 * bulk-archive confirmation and re-sends the `done` transition with this flag;
 * without it the server records the status transition but skips the destructive
 * bulk done→archive side effect. Never persisted on the Work.
 */
export interface WorkPatchInput extends UpdateWorkInput {
  confirmArchive?: boolean;
}

/** One seed the completion sweep could not flip/archive (e.g. the card was deleted meanwhile). */
export interface WorkSweepFailure {
  cardId: string;
  message: string;
}

/**
 * What the completion sweep actually did, reported alongside the patched Work.
 *
 * The sweep touches N cards through N independent store writes, so **partial
 * success is a real outcome**: a card deleted between the read and the write
 * fails on its own without cancelling the rest. Reporting it is the point — the
 * previous behaviour let that single rejection escape the route, where the
 * substring error mapping turned it into `404 Work not found` even though the
 * Work existed and most of its cards had just been archived.
 */
export interface WorkSweepReport {
  archivedCount: number;
  archiveMonth?: string;
  /** Why no sweep ran, when none did. */
  skipped?: WorkArchiveSkipReason;
  /** Empty on a clean sweep. */
  failed: WorkSweepFailure[];
  /**
   * Top-level cards left on the board because they are favorited. `favorite`
   * means "pin this to the board", and `archiveCards` already honours it for
   * every *descendant* it cascades to — the Work sweep passed its seeds in
   * explicitly, which is the one path that walked straight past the pin.
   * Reported so completing a Work never silently removes a starred card.
   */
  keptFavoriteCardIds?: string[];
}

/** Why the bulk done→archive sweep did not run for a `PATCH /api/works/:id` call. */
export type WorkArchiveSkipReason =
  | 'not-a-completion'      // status was not transitioning to `done`
  | 'already-archived'      // this Work's cards were archived by an earlier call
  | 'awaiting-confirmation' // works.done_confirm is on and the client has not confirmed
  | 'no-cards'              // nothing active left to sweep (already archived / no sessions)
  | 'favorites-only';       // every board card under this Work is favorited (pinned) — see WorkSweepReport.keptFavoriteCardIds

/**
 * `PATCH /api/works/:id` response — the updated `Work` **plus** the sweep's own
 * report when this patch ran (or deliberately skipped) one.
 *
 * Deliberately a superset of `Work` rather than a `{ work, sweep }` envelope:
 * every existing caller reads Work fields straight off the body, and a Work has
 * no `sweep` field of its own, so the extra key is additive.
 */
export interface WorkPatchResponse extends Work {
  sweep?: WorkSweepReport;
}

/**
 * `GET /api/works/:id/completion-preview` — what completing this Work would do,
 * so the confirmation dialog can state the damage before the user commits.
 *
 * Counts are **archive-inclusive** (same monthly reads as
 * `GET /api/works/:id/sessions`): a Work whose sweep already ran must not
 * describe itself as touching zero cards.
 */
export interface WorkCompletionPreview {
  /** A subtree reaches cards explicitly owned by another Work. */
  conflictingCardIds?: string[];
  workId: string;
  /** Cards under every linked session, live board **and** archive. */
  cardCount: number;
  /** Card counts per status over the same set, zero-filled so the UI needs no defaults. */
  byStatus: Record<KanbanStatus, number>;
  /**
   * Cards still on the board **and not favorited** — i.e. what a sweep run now
   * would actually archive. Favorites are excluded because the sweep excludes
   * them; the dialog must not promise to archive a card it will leave behind.
   */
  sweepCardCount: number;
  /**
   * Board cards under this Work that are favorited, and therefore stay put.
   * Named in the confirmation dialog so "카드 N장이 archive됩니다" and the board
   * the user sees afterwards agree.
   */
  favoriteCardIds: string[];
  /**
   * Board cards with a live runtime run. Non-empty means completion is refused
   * with `409`: archiving a card out from under a running agent makes its
   * completion hook fail with `Card not found` and hands the wiki an unfinished
   * transcript.
   */
  runningCardIds: string[];
  /**
   * Titles of `runningCardIds`, same order. Carried so the confirmation dialog
   * can name what is busy instead of printing nanoids, without the client
   * needing a board read of its own.
   */
  runningCardTitles: string[];
  sessionCount: number;
  /** The cards were already bulk-archived — completing again is a no-op. */
  alreadyArchived: boolean;
  /** Archive month files read to build this preview — diagnostics for the range heuristic. */
  scannedMonths: string[];
}

/**
 * `POST /api/works/:id/sessions` body. The Work's `startedAt` is **not** part of
 * it: `min()` is recalculated by a `WorkStartedAtResolver` the caller hands to
 * `WorkStore.addSession`, which runs it *inside* the store's lock against the
 * post-link link set. Passing a pre-computed date (as this input used to) is a
 * TOCTOU: two concurrent links each resolved `min()` against the link set they
 * read before the lock, so the second write overwrote the first's answer with
 * one that had never seen the other session.
 */
export interface AddWorkSessionInput {
  sessionId: string;
  projectDir?: string;
  role?: WorkSessionRole;
}

/** One session of a `POST /api/works/:id/sessions/batch` request. */
export interface BatchAddWorkSessionsInput {
  sessions: AddWorkSessionInput[];
  /** Applied to every session that does not carry its own. */
  role?: WorkSessionRole;
}

/** One session a batch link could not attach, with the server's own reason. */
export interface WorkBatchLinkFailure {
  sessionId: string;
  message: string;
}

/**
 * `POST /api/works/:id/sessions/batch` response.
 *
 * Partial success is a real outcome and is reported rather than thrown: the 1:N
 * invariant is per-session, so one session that already belongs to another Work
 * must not undo the links that did succeed. What *is* atomic is each individual
 * link — the `min()` recalculation happens inside the store's lock — and the
 * whole batch shares **one** archive-inclusive card read, which is the reason
 * this verb exists at all (linking 20 sessions one route call at a time scanned
 * the archive 20+ times).
 */
export interface WorkBatchAddSessionsResponse {
  work: Work;
  /** Sessions the client asked for that are now linked. */
  linkedSessionIds: string[];
  /** Subagent descendants adopted along the way (`linkSessionWithSubagents`). */
  cascadedSessionIds: string[];
  failed: WorkBatchLinkFailure[];
}

/**
 * `PATCH /api/works/sessions/:sessionId` body (`sessionId` comes from the path).
 * Re-parents an existing link instead of creating one, which is why moving is a
 * verb of its own: `POST /api/works/:id/sessions` still rejects a session that
 * belongs to another Work with `409`, and that invariant stays intact.
 */
export interface MoveWorkSessionInput {
  sessionId: string;
  toWorkId: string;
  /** Omitted keeps the role the link already carried. */
  role?: WorkSessionRole;
}

/**
 * Response of a session move. `from` is the source Work *after* the move, or
 * `null` when the move took its last session and the Work was deleted — emptying
 * a Work by moving its only session is a merge, and the leftover shell would
 * otherwise linger on the Timeline as a bar with nothing under it.
 */
export interface MoveWorkSessionResponse {
  from: Work | null;
  to: Work;
}

/**
 * Inbox DTO — an unassigned, non-ignored session surfaced for triage. Derived
 * from the same session aggregation that backs `GET /api/sessions`; the UI (card
 * 2) reads this list to drive inline assignment. `projectDir` powers the
 * "same-directory Work" recommendation.
 */
/**
 * `POST /api/works/:id/sessions` response — the `Work` plus which sessions the
 * link *inherited*.
 *
 * A superset of `Work` rather than a `{ work, cascaded }` envelope, for the same
 * reason `WorkPatchResponse` is: every existing caller reads it as a `Work` and
 * keeps working. `cascadedSessionIds` are the subagent sessions linked along
 * with the requested one (`buildSubagentSessionTree`), so the UI can say why the
 * Inbox lost rows nobody clicked.
 */
export type WorkAddSessionResponse = Work & { cascadedSessionIds: string[] };

export interface WorkInboxSession {
  sessionId: string;
  sessionTitle?: string;
  cardTitle: string;
  cardId: string;
  /**
   * Status of the session's representative card (`todo` | `in_progress` |
   * `complete` | `done`). The Inbox row turns it into a 상태 칩 so a session that
   * is still running does not look like a finished one — it is the field that
   * makes "is this even ready to triage" answerable without opening the card.
   */
  cardStatus: string;
  projectDir?: string;
  agentRuntime: AgentRuntime;
  agentType?: string;
  model?: string;
  relatedCardCount: number;
  /**
   * `subagent` when every card on this session carries a `parentCardId`, or when
   * the session ran under another session's card — see
   * `buildSubagentSessionTree`. A subagent row whose parent is *already* linked
   * to a Work is not returned at all; this flag is for the ones whose parent is
   * still unassigned, so the user can see why two rows look alike.
   */
  sessionKind: 'main' | 'subagent';
  updatedAt: string;      // ISO 8601
  /**
   * Sessions this one continues (subagent parent / queue chain / resumed
   * session) — see `buildSessionChainMap`. Triage colors a Work that already
   * holds one of these as "🔗 이어진 세션" and ranks it first. Computed from all
   * cards including archived ones, so it is absent only when there is no
   * lineage at all.
   */
  relatedSessionIds?: string[];
}

/**
 * What one `reconcileWorkSessionLinks()` pass changed — the response of
 * `POST /api/works/reconcile-links` and of the boot-time pass.
 *
 * Idempotent by construction: a second run over unchanged data reports zero of
 * both, because the stamp is derived from the cards rather than accumulated.
 */
export interface WorkLinkReconcileReport {
  /** Works inspected. */
  scanned: number;
  /** Links newly stamped `cardsMissingAt` (their session lost its last card). */
  marked: Array<{ workId: string; sessionIds: string[] }>;
  /** Links whose cards came back (a `restoreCard`, or a stale stamp). */
  cleared: Array<{ workId: string; sessionIds: string[] }>;
}

/** `POST /api/works/:id/prune-sessions` response. */
export interface WorkPruneSessionsResponse {
  work: Work;
  /** Links dropped because they were stamped `cardsMissingAt`. */
  removedSessionIds: string[];
}

/**
 * One entry of the Inbox ignore list — `GET /api/works/ignored-sessions`.
 *
 * The list was write-only for as long as it existed: `ignoredSessionIds` could
 * only be appended to, so an accidental `폐기` (one mistyped `x` in the assign
 * modal) dropped a session out of every screen permanently. This DTO is the read
 * side of that list, and `DELETE /api/works/ignore-session/:sessionId` the way
 * back.
 *
 * `session` carries the same summary the Inbox row renders, so the restore list
 * can identify a row by its first prompt rather than an opaque id. It is absent
 * when the session has no cards left to summarize — the row still exists,
 * because it is still ignored and restoring it is still how it leaves the list.
 */
export interface WorkIgnoredSession {
  sessionId: string;
  session?: WorkInboxSession;
  /**
   * Whether restoring it would actually put the row back in the Inbox. False
   * for a session the Inbox filters out anyway (no cards, a subagent whose
   * parent is assigned, or one past the `since` window) — restoring is still
   * allowed, it just says so instead of looking broken.
   */
  returnsToInbox: boolean;
}

// ─── Works settings (card 4/7) ──────────────────────────────────────
// Works-scoped configuration, independent of the wiki's LLM settings. Persisted
// as `works.*` keys in the shared settings store. The Summary LLM route (codex
// vs claude) is derived from `summaryModel` the same way the wiki does it.

export interface WorksConfig {
  summaryModel: string;               // works.summary_model — model id (runtime derivable from prefix)
  summaryLines: number;               // works.summary_lines — 3 | 4 | 5
  assignPreferSameDir: boolean;       // works.assign_prefer_same_dir
  assignSuggestResumeChain: boolean;  // works.assign_suggest_resume_chain
  staleDays: number;                  // works.stale_days — active Work "⚠ stale" threshold
  doneConfirm: boolean;               // works.done_confirm — confirm before bulk archive on complete
}

/** Works config as surfaced to the Works tab settings panel. */
export interface WorksConfigDto extends WorksConfig {
  configured: boolean;   // true once any works.* setting has been explicitly saved
  route: WikiLlmRoute;   // derived from summaryModel (gpt-* → codex, otherwise claude)
}

/** Partial works config update from the settings panel; only provided fields are saved. */
export interface WorksConfigInput {
  summaryModel?: string;
  summaryLines?: number;
  assignPreferSameDir?: boolean;
  assignSuggestResumeChain?: boolean;
  staleDays?: number;
  doneConfirm?: boolean;
}

/**
 * One linked session of a Work, summarized **over live *and* archived cards**.
 *
 * Completing a Work bulk-archives every card under it, so the board list the web
 * client polls holds none of them a moment later — deriving these counts on the
 * client would report `카드 0 · done 0` for exactly the Works whose point is to
 * be looked back at. The server therefore computes them once, reading the
 * archive months the Work can possibly reach.
 */
export interface WorkSessionSummary {
  sessionId: string;
  role?: WorkSessionRole;
  linkedAt: string;          // ISO 8601 — echo of the link
  projectDir?: string;
  /** Oldest card's title (the session's first prompt), else `sessionTitle`, else ''. */
  title: string;
  cardCount: number;
  /** Cards whose status is `done` or `complete`. */
  doneCount: number;
  /** Cards still `todo` or `in_progress`. */
  inProgressCount: number;
  /** Earliest card execution/creation instant, absent when the session has no cards. */
  firstCardAt?: string;      // ISO 8601
  /** Latest card activity (`updatedAt` max), absent when the session has no cards. */
  lastActivityAt?: string;   // ISO 8601
  /** Every card of this session is off the board — i.e. the session is archived. */
  archived: boolean;
  /**
   * How many of `cardIds` are in the archive rather than on the board.
   *
   * `archived` is the all-or-nothing flag the row renders; this is the count the
   * **reopen** confirmation needs, because reopening restores exactly these
   * cards and the dialog has to say how many before the user commits. Derived
   * from the same `archivedCardIds` set, so no second read.
   */
  archivedCardCount: number;
  /**
   * Echo of `WorkSessionLink.cardsMissingAt` — this link has no cards anywhere
   * the Work can reach, so it contributes nothing but a `linkedAt` fallback to
   * the Timeline start. Absent on a healthy link.
   */
  cardsMissingAt?: string;
  /** Card ids oldest-first, so the caller can address them without a second read. */
  cardIds: string[];
  /** Distinct vault-relative paths of the wiki docs this session's cards were kept as. */
  wikiDocPaths: string[];
  /** Some card is queued for the wiki pipeline but not processed yet. */
  wikiPending: boolean;
}

/**
 * `GET /api/works/:id/sessions` — the Work detail dialog's data source.
 *
 * Exists because the dialog has to describe finished work: its cards live in the
 * monthly archive, which the board API does not serve. Aggregates are echoed at
 * the top level so the 산출물 row needs no client-side reduction.
 */
export interface WorkSessionsResponse {
  /** Actual card history, including archived results, newest activity first. */
  activities: WorkCardActivity[];
  workId: string;
  sessions: WorkSessionSummary[];
  cardCount: number;
  doneCount: number;
  inProgressCount: number;
  /** Cards in the archive across the whole Work — what a reopen would restore. */
  archivedCardCount: number;
  lastActivityAt?: string;   // ISO 8601 — max over every session, else the Work's updatedAt
  /** Distinct wiki doc paths across the whole Work, deterministic order. */
  wikiDocPaths: string[];
  /**
   * Some card is queued for the wiki pipeline but not processed yet — the
   * difference between "this Work produced no document" and "not yet". A Work
   * completed a moment ago is always in this state, since the archive sweep is
   * what queues its cards.
   */
  wikiPending: boolean;
  /** Archive month files read for this Work — diagnostics for the range heuristic. */
  scannedMonths: string[];
}

/** Response of POST /api/works/:id/summary — the updated Work plus per-session outcome. */
export interface WorkSummaryResponse {
  /** Sessions summarized from saved cards instead of a native transcript. */
  cardSourceSessions?: string[];
  work: Work;
  summary: WorkSummary;
  generatedSessions: string[];                              // sessionIds that contributed
  skippedSessions: { sessionId: string; reason: string }[]; // e.g. transcript unavailable
}

// ─── Timeline (GET /api/timeline) ───────────────────────────────────
// The Timeline view is a day grid whose smallest row is a **session** and whose
// smallest column is a **day**. It answers "what actually ran, when" — so a card
// enters it only once it has executed (`startedAt`/`completedAt`), never from
// its creation date. A card left in `todo` for months is invisible here.

/** One executed card, projected down to what the day grid draws. */
export interface TimelineCard {
  id: string;
  title: string;
  status: KanbanStatus;
  /** First execution instant. Present by construction — an unexecuted card is dropped. */
  startedAt: string;      // ISO 8601
  /** Execution end; absent while the card is still running. */
  completedAt?: string;   // ISO 8601
  /** `parentCardId` was set — only present when the request asked for subagents. */
  isSubagent: boolean;
}

/**
 * A session's measured extent, plus the cards that produced it. The Timeline's
 * minimum row: every card belongs to a session, so a lone card row would have
 * nothing to hang under.
 *
 * `endedAt` is absent while any card in the session is still running, which is
 * what the UI draws as an open-ended rail.
 */
export interface TimelineSessionSpan {
  sessionId: string;
  sessionTitle?: string;
  projectDir?: string;
  agentRuntime: AgentRuntime;
  startedAt: string;      // ISO 8601 — min() over the session's executed cards
  endedAt?: string;       // ISO 8601 — max(), absent while one is still running
  cards: TimelineCard[];
  /**
   * The session has cards that ran *entirely before* the window, which the
   * response therefore omits — `startedAt` is where the visible part begins,
   * not where the session began.
   *
   * Without this the client could not tell "started on this grid" from "was
   * already running when the grid opened": both arrive with a `startedAt`
   * inside the window, so the rail drew a closed left edge over a session that
   * had been running for a week. The UI reads it exactly like a clipped span
   * (`◂`, dashed left edge).
   */
  truncatedBefore?: boolean;
  /**
   * The session was discarded from Works triage (`works.json`
   * `ignoredSessionIds`). It still ran, so it still gets a row — but it must not
   * offer 배정: the Inbox no longer holds it, so the assign modal would have
   * nothing to open. Absent when no Work store is wired.
   */
  ignored?: boolean;
}

/**
 * `GET /api/timeline` response. Deliberately carries **no** Work grouping: the
 * web client already polls `/api/works`, and mapping session → Work there keeps
 * an optimistic assignment re-grouping the timeline instantly instead of waiting
 * for a refetch.
 */
export interface TimelineSnapshot {
  from: string;               // ISO 8601 — echo of the requested window start
  to: string;                 // ISO 8601 — echo of the requested window end
  includesSubagents: boolean;
  sessions: TimelineSessionSpan[];
  /** Archive month files read for this window — diagnostics for the range heuristic. */
  scannedMonths: string[];
}
