import type { KanbanStore } from '../core/store';
import type { SchedulerStore } from '../core/scheduler-store';
import type { SchedulerEngine } from '../plugin/scheduler-engine';
import { dispatchCardWithScheduledReservation } from '../plugin/scheduled-dispatch-service';
import type { SettingsStore } from '../core/settings-store';
import type { ScriptStore } from '../core/script-store';
import type { WorkStore } from '../core/work-store';
import {
  renderPromptQuickAction,
  resolveQuickActionParameters,
  type QuickActionStore,
} from '../core/quick-action-store';
import { ScriptExecutionService } from '../plugin/script-execution-service';
import type { SkillStore } from '../core/skill-store';
import type { SkillRootsStore } from '../core/skill-roots-store';
import type { PlacementTargetsStore } from '../core/placement-targets-store';
import { validateSkillPath } from '../core/validate-skill-path';
import {
  buildSessionChainMap,
  buildSubagentSessionTree,
  subagentAncestorSessions,
  subagentDescendantSessions,
} from '../core/session-chain';
import {
  buildTimelineSessions,
  buildWorkSessionsResponse,
  checkTimelineWindow,
  timelineArchiveMonths,
  workCardScanFloor,
} from '../core/timeline-aggregate';
import type { QuestionMonitor } from '../plugin/question-monitor';
import type { QuestionRequest } from '../plugin/question-monitor';
import type { WikiWorker } from '../plugin/wiki/wiki-worker';
import type { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { buildRunProgress, buildTranscriptProgress } from '../plugin/runtimes/run-progress';
import { resolveClaudeTranscriptPath, loadClaudeTranscript } from '../plugin/wiki/wiki-transcript';
import { createWikiLlm } from '../plugin/wiki/wiki-llm';
import { loadWorksConfig, loadWorksConfigDto, saveWorksConfig } from '../plugin/works/works-config';
import { buildWorkCardContext, generateWorkSummary, type WorkTranscriptSource } from '../plugin/works/works-summary';
import {
  applyWorkPatch,
  buildWorkCompletionPreview,
  createWorkStartedAtResolver,
  loadWorkStartedAtResolver,
  reopenWork,
  resolveWorkStartedAt,
  selectWorkCards,
  selectWorkSweepCards,
  type ActiveRunProbe,
} from '../plugin/works/work-lifecycle';
import { findWorkOwningSession, reconcileWorkSessionLinks } from '../plugin/works/work-links';
import { selectWorks, isWorkListSort } from '../core/work-list';
import {
  WorkAlreadyActiveError,
  WorkCardsRunningError,
  WorkCardsConflictError,
  WorkDateOrderError,
  WorkMergeTargetError,
  WorkNotActiveError,
  WorkNotFoundError,
  WorkNotMovableError,
  WorkSessionAlreadyLinkedError,
  WorkSessionNotIgnoredError,
  WorkSessionNotLinkedError,
} from '../core/work-errors';
import { getSettingValueOrDefault } from '../core/settings-store';
import type {
  AgentRuntime,
  DispatchResult,
  KanbanCard,
  McpInventoryDiscoveryResult,
  McpPlacement,
  McpRuntime,
  PlacementTarget,
  SchedulerScheduleInputState,
  SchedulerSimpleRepeat,
  SkillRuntime,
  RunQuickActionResponse,
  WikiArchiveCardStatusFilter,
  Work,
  AddWorkSessionInput,
  WorkAddSessionResponse,
  WorkBatchAddSessionsResponse,
  WorkBatchLinkFailure,
  WorkStatus,
  UpdateWorkInput,
  WorkSessionRole,
  WorkSummary,
  WorkIgnoredSession,
  WorkInboxSession,
  WorkPatchResponse,
  WorksConfigInput,
  TimelineSnapshot,
} from '../core/types';
import { QUICK_ACTION_ICON_ERRORS, WORK_NOTES_MAX_LENGTH } from '../core/types';
import { RUNTIME_CATALOG, resolveAgentRuntime, DEFAULT_CODEX_REASONING_EFFORT, type RuntimeCatalogEntry } from '../core/runtime-config';
import { getRuntimeCommandDefinition, setDynamicSkillCommands } from '../core/commands';
import { extractAgentThread } from '../core/subagent-transcript';
import { getMaintenanceStatus, readMaintenanceLog, startApplyUpdateRestart } from './maintenance-runner';
import {
  applyAlwaysLoad,
  copyMcp,
  moveMcp,
  removeMcp,
  previewCopyMcp,
  previewMoveMcp,
  previewRemoveMcp,
  setAlwaysLoad,
} from '../core/mcp-config-store';
import {
  copyCodexMcp,
  moveCodexMcp,
  removeCodexMcp,
  previewCopyCodexMcp,
  previewMoveCodexMcp,
  previewRemoveCodexMcp,
} from '../core/codex-mcp-config';
import {
  getMcpRuntimeAdapter,
  readAllMcpInventoryWithDiagnostics,
} from '../core/mcp-runtime-adapter';
import { resolveKanbanDataDir } from '../core/data-dir';
import {
  isValidFiveFieldCron,
  resolveSchedulerScheduleInput,
  validateScheduledAtKstInput,
  validateSchedulerActionInput,
  validateSchedulerTimezoneInput,
} from '../core/scheduling';
import {
  readCcDiagnostics,
  computeSkillVisibility,
  previewSkillOverride,
  setSkillOverride,
  USER_SETTINGS_PATH,
} from '../core/cc-settings-store';
import { applyDisableModelInvocation, setDisableModelInvocation } from '../core/skill-frontmatter';
import {
  freezeSkill,
  restoreSkill,
  freezeMcp,
  restoreMcp,
  deleteColdEntry,
  getColdManifest,
  getColdManifestView,
  getColdMcpEntry,
  readColdSkillContent,
} from '../core/cold-storage-store';
import { existsSync, mkdirSync, cpSync, statSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { detectPlaintextSecret } from '../core/secret-detect';

// The web UI is served from the same origin as the API, so no cross-origin
// access is ever required by a legitimate client. We therefore emit NO
// `Access-Control-Allow-Origin` header (cross-origin browsers cannot read
// responses) and reject cross-origin *requests* up front via the same-origin
// guard below. These headers only advertise allowed methods for the rare
// same-origin preflight; they do not grant any cross-origin access.
const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const AGENT_RUNTIME_VALUES = new Set<AgentRuntime>(['opencode', 'codex', 'claude']);
const WORK_STATUS_VALUES = new Set<WorkStatus>(['active', 'done', 'discarded']);
/**
 * The resolutions a **client** may write. `superseded` is deliberately absent
 * even though `WorkResolution` now includes it: only `POST /api/works/:id/merge`
 * stamps it, and it is meaningless without the `supersededByWorkId` the same
 * transition writes — so accepting it here would let a client mint a 병합됨
 * Work that points nowhere. Same reason `supersededByWorkId` itself is rejected
 * below.
 */
const WORK_RESOLUTION_VALUES = new Set<string>(['completed', 'abandoned']);
const WORK_SESSION_ROLE_VALUES = new Set<WorkSessionRole>(['dev', 'review', 'debug']);
/** A parseable ISO 8601 timestamp — the only shape a Work date field accepts. */
function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Every accepted date is stored **normalized to UTC `Z`**.
 *
 * `Date.parse` happily accepts `2026-09-01T09:00:00+09:00`, and stored as-is it
 * sorts *after* the equivalent `2026-09-01T00:00:00.000Z` under any lexical
 * comparison — which is what `min()` recalculation and the `startedAt` clamp
 * used to do. Normalizing on the way in means every instant in `works.json` is
 * comparable both as a string and as a `Date`.
 */
function normalizeIsoDate(value: string): string {
  return new Date(value).toISOString();
}

/**
 * `WorkSummary` shape guard for `PATCH /api/works/:id`.
 *
 * The field is normally written by `POST /api/works/:id/summary` from the LLM,
 * but the patch endpoint accepts it too (that is how the client clears one with
 * `null`). It used to accept whatever arrived, so a malformed body landed in
 * `works.json` and the detail dialog rendered from it.
 */
function isWorkSummary(value: unknown): value is WorkSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return Array.isArray(summary.lines)
    && summary.lines.every((line) => typeof line === 'string')
    && typeof summary.generatedAt === 'string'
    && typeof summary.model === 'string';
}
// Directory convention each runtime scans for project-level skills (mirrors defaultSkillRoots()).
const SKILL_RUNTIME_SUBDIR: Record<SkillRuntime, string[]> = {
  claude: ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  opencode: ['.agents', 'skills'],
};
const WIKI_ARCHIVE_CARD_FILTERS = new Set<WikiArchiveCardStatusFilter>([
  'all',
  'kept',
  'skipped',
  'failed',
  'pending',
  'unprocessed',
]);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Works failures → HTTP status, classified on the error **class**.
 *
 * Never on the message: substring matching (`message.includes('not found')`) is
 * what turned a card vanishing mid-sweep — `Card not found: abc` — into
 * `404 Work not found`, telling the client the Work did not exist while its
 * other cards had just been archived under it.
 */
function worksErrorResponse(e: unknown, fallback: string): Response {
  if (e instanceof WorkCardsConflictError) return json({ error: e.message, conflictingCardIds: e.conflictingCardIds }, 409);
  if (e instanceof WorkCardsRunningError) {
    // The blocked card ids travel with the rejection so the confirmation dialog
    // can name what is still running instead of just refusing.
    return json({ error: e.message, runningCardIds: e.runningCardIds }, 409);
  }
  if (e instanceof WorkNotFoundError) return errorResponse('Work not found', 404);
  if (e instanceof WorkSessionNotLinkedError) return errorResponse(e.message, 404);
  if (e instanceof WorkSessionAlreadyLinkedError) return errorResponse(e.message, 409);
  if (e instanceof WorkNotMovableError) return errorResponse(e.message, 409);
  if (e instanceof WorkNotActiveError) return errorResponse(e.message, 409);
  if (e instanceof WorkAlreadyActiveError) return errorResponse(e.message, 409);
  if (e instanceof WorkSessionNotIgnoredError) return errorResponse(e.message, 404);
  if (e instanceof WorkDateOrderError) return errorResponse(e.message, 400);
  if (e instanceof WorkMergeTargetError) return errorResponse(e.message, 400);
  return errorResponse(e instanceof Error ? e.message : fallback, 400);
}

/**
 * Keep the owning Work's link honest after a card's existence changed.
 *
 * Deleting a card is the one board action that can leave a `WorkSessionLink`
 * pointing at nothing, and it never told Works about it: the link stayed, the
 * detail dialog kept offering a 대화 link into a session with no cards, and
 * `resolveWorkStartedAt` quietly fell back to `linkedAt` — so the Timeline bar
 * started at triage time instead of when the work began. Restoring the card has
 * to clear the stamp for the same reason.
 *
 * Narrowed to the one Work that owns the session, so this stays a couple of file
 * reads on a hot path. Best-effort: a card delete must not fail because Works
 * bookkeeping did.
 */
async function reconcileWorkLinkForCard(
  store: KanbanStore,
  workStore: WorkStore | undefined,
  sessionId: string | undefined,
): Promise<void> {
  if (!workStore || !sessionId) return;
  try {
    const owner = await findWorkOwningSession(workStore, sessionId);
    if (!owner) return;
    await reconcileWorkSessionLinks({ store, workStore, workIds: [owner.id] });
  } catch {
    // Bookkeeping only — never turn a successful card write into an error.
  }
}

function readSchedulerScheduleInput(body: Record<string, unknown>): SchedulerScheduleInputState {
  if (body.scheduleInput && typeof body.scheduleInput === 'object') {
    const raw = body.scheduleInput as Record<string, unknown>;
    if (raw.mode === 'simple' && raw.simple && typeof raw.simple === 'object') {
      const simple = raw.simple as Record<string, unknown>;
      const repeat = typeof simple.repeat === 'string' ? simple.repeat : '';
      if (
        repeat !== 'minutes'
        && repeat !== 'hours'
        && repeat !== 'daily'
        && repeat !== 'weekdays'
        && repeat !== 'weekly'
      ) {
        throw new Error('scheduleInput.simple.repeat is invalid');
      }
      return {
        mode: 'simple',
        simple: {
          repeat: repeat as SchedulerSimpleRepeat,
          interval: typeof simple.interval === 'number' ? simple.interval : undefined,
          hour: typeof simple.hour === 'number' ? simple.hour : undefined,
          minute: typeof simple.minute === 'number' ? simple.minute : undefined,
          dayOfWeek: typeof simple.dayOfWeek === 'number' ? simple.dayOfWeek : undefined,
        },
      };
    }
    if (raw.mode === 'cron' && typeof raw.expression === 'string') {
      return { mode: 'cron', expression: raw.expression };
    }
    throw new Error('scheduleInput shape is invalid');
  }

  if (typeof body.cron === 'string') {
    return { mode: 'cron', expression: body.cron };
  }
  throw new Error('scheduleInput is required');
}

/**
 * Reject browser requests that originate from a different origin than the one
 * the server is being accessed on. This is the primary CSRF / drive-by defense:
 * a malicious page the user visits while the board is running can issue requests
 * to localhost, but the browser stamps them with its own `Origin`, which will
 * not match the server's `Host`. Non-browser clients (the plugin, peers, curl)
 * send no `Origin` header and are unaffected. Works for both the default
 * 127.0.0.1 bind and `network_exposed` (LAN) access, since it compares against
 * the actual Host rather than hard-coding loopback.
 */
function isForbiddenCrossOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false; // non-browser client — no Origin to forge
  let originHostPort: string;
  try {
    originHostPort = new URL(origin).host;
  } catch {
    return true; // malformed Origin — reject
  }
  const host = req.headers.get('host');
  return originHostPort !== host;
}

function isLoopbackClient(clientAddress: string | undefined): boolean {
  if (!clientAddress) return true; // unknown (tests / direct handler calls) — treat as local
  return LOOPBACK_ADDRESSES.has(clientAddress);
}

/**
 * Routes that require the local auth token (when one is configured).
 * All state-changing methods, plus reads that expose secrets (settings) or
 * executable code / command output (scripts).
 */
function requiresLocalAuth(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'OPTIONS') return true;
  if (path === '/api/settings' || path.startsWith('/api/settings/')) return true;
  if (path === '/api/scripts' || path.startsWith('/api/scripts/')) return true;
  // Skills expose internal paths, MCP names, and operational procedures — must be
  // protected on the same level as settings/scripts to prevent LAN leakage.
  if (path === '/api/skills' || path.startsWith('/api/skills/')) return true;
  if (path === '/api/skill-roots' || path.startsWith('/api/skill-roots/')) return true;
  if (path === '/api/scope' || path.startsWith('/api/scope/')) return true;
  return false;
}

/** Redact a masked secret value from a settings entry for list/write responses. */
function redactSetting<T extends { masked?: boolean; value: string }>(entry: T): T {
  if (entry.masked === false) return entry;
  return { ...entry, value: '' };
}

function formatQuestionHistory(
  question: QuestionRequest,
  answers: string[][] | null,
): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];

  if (answers === null) {
    lines.push(`[${timestamp}] ❌ Question rejected`);
  } else {
    lines.push(`[${timestamp}] ✅ Question answered`);
  }

  for (let i = 0; i < question.questions.length; i++) {
    const q = question.questions[i];
    lines.push(`  Q: ${q.header} — ${q.question}`);
    if (answers && answers[i]) {
      lines.push(`  A: ${answers[i].join(', ')}`);
    }
  }

  return lines.join('\n');
}

/** Build a minimal SKILL.md from form fields. */
function buildSkillMd(name: string, description: string, instructions: string): string {
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push('---', '');
  lines.push(instructions || `# ${name}\n\nDescribe what this skill does.`);
  lines.push('');
  return lines.join('\n');
}

/** Accepts only `[a-z0-9][a-z0-9-]*` — no slashes, no dots, no traversal. */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

export type DispatchFn = (cardId: string) => Promise<DispatchResult>;
export type ModelInfo = { id: string; name: string; providerID: string; providerName: string };
export type ModelsFn = () => Promise<ModelInfo[]>;
export type RuntimeCatalogFn = () => RuntimeCatalogEntry[] | Promise<RuntimeCatalogEntry[]>;
export type NativeSessionInfo = {
  sessionId: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  updatedAt?: string;
  sourceInstanceId?: string;
  sourcePort?: number;
  sourceIsLocal?: boolean;
  sourceCwd?: string;
};
export type AggregateSessionsFn = () => Promise<NativeSessionInfo[]>;

/**
 * Unified session aggregate returned by `GET /api/sessions` and consumed by the
 * Works Inbox. Core fields are always present; the peer/link enrichments are
 * populated only on the native (`aggregateSessionsFn`) path.
 */
export interface SessionAggregate {
  sessionId: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  cardTitle: string;
  cardId: string;
  cardStatus: string;
  projectDir?: string;
  agentRuntime: AgentRuntime;
  agentType?: string;
  model?: string;
  updatedAt: string;
  linkState?: 'none' | 'single' | 'multiple';
  relatedCardCount?: number;
  /**
   * Sessions this one continues — `buildSessionChainMap`. Derived **above** both
   * aggregation branches, so it is present on the native path too; absent only
   * when the session has no lineage at all.
   */
  relatedSessionIds?: string[];
  /**
   * Sessions this one ran as a subagent of, nearest parent first —
   * `subagentAncestorSessions`. Also derived above the branch. The Works Inbox
   * uses it to drop a subagent row whose parent is already assigned.
   */
  parentSessionIds?: string[];
  /** `subagent` when the session only ever ran under another card/session. */
  sessionKind?: 'main' | 'subagent';
  isSubagentOnly?: boolean;
  hasTopLevelLinkedCard?: boolean;
  hasSubagentLinkedCard?: boolean;
  visiblePeerCount?: number;
  primaryPeerInstanceId?: string;
  primaryPeerPort?: number;
  primaryPeerIsLocal?: boolean;
  primaryPeerCwd?: string;
}

/**
 * Cards of one session, newest first — the shape both aggregation paths want.
 */
function groupCardsBySession(cards: KanbanCard[]): Map<string, KanbanCard[]> {
  const bySession = new Map<string, KanbanCard[]>();
  for (const card of cards) {
    if (!card.sessionId) continue;
    const list = bySession.get(card.sessionId);
    if (list) list.push(card);
    else bySession.set(card.sessionId, [card]);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
  return bySession;
}

/**
 * The session view derivable from its cards alone. Shared by the card-only
 * aggregation path and by the native path's "no peer reported this session"
 * fallback, so a session's counts never depend on which one produced it.
 */
function cardDerivedAggregate(
  sessionId: string,
  cards: KanbanCard[],
): SessionAggregate | undefined {
  // Prefer a top-level card for the label: a session whose newest card is a
  // subagent still belongs to whatever spawned it.
  const primaryCard = cards.find(card => !card.parentCardId) ?? cards[0];
  if (!primaryCard) return undefined;
  const hasTopLevelLinkedCard = cards.some(card => !card.parentCardId);
  const hasSubagentLinkedCard = cards.some(card => Boolean(card.parentCardId));
  const isSubagentOnly = !hasTopLevelLinkedCard;
  return {
    sessionId,
    sessionTitle: primaryCard.sessionTitle,
    sessionCreatedAt: primaryCard.sessionCreatedAt,
    cardTitle: primaryCard.title,
    cardId: primaryCard.id,
    cardStatus: primaryCard.status,
    projectDir: primaryCard.projectDir,
    agentRuntime: resolveAgentRuntime(primaryCard),
    agentType: primaryCard.agentType,
    model: primaryCard.model,
    linkState: cards.length === 1 ? 'single' : 'multiple',
    relatedCardCount: cards.length,
    isSubagentOnly,
    hasTopLevelLinkedCard,
    hasSubagentLinkedCard,
    visiblePeerCount: 0,
    primaryPeerInstanceId: undefined,
    primaryPeerPort: undefined,
    primaryPeerIsLocal: true,
    primaryPeerCwd: undefined,
    updatedAt: primaryCard.updatedAt,
  };
}

/** Sessions reported by the native peer listing, enriched with their cards. */
function nativeDerivedAggregates(
  cardsBySession: Map<string, KanbanCard[]>,
  nativeSessions: NativeSessionInfo[],
): SessionAggregate[] {
  const nativeBySession = new Map<string, NativeSessionInfo[]>();
  for (const native of nativeSessions) {
    const list = nativeBySession.get(native.sessionId);
    if (list) list.push(native);
    else nativeBySession.set(native.sessionId, [native]);
  }

  const sessions: SessionAggregate[] = [];
  for (const [sessionId, nativeEntries] of nativeBySession) {
    const native = nativeEntries[0];
    const cards = cardsBySession.get(sessionId) ?? [];
    const primaryCard = cards.find(card => !card.parentCardId) ?? cards[0];
    const hasTopLevelLinkedCard = cards.some(card => !card.parentCardId);
    const hasSubagentLinkedCard = cards.some(card => Boolean(card.parentCardId));
    const peerKeys = new Set<string>();
    for (const entry of nativeEntries) {
      peerKeys.add(`${entry.sourceInstanceId ?? 'unknown'}:${entry.sourcePort ?? 0}`);
    }

    sessions.push({
      sessionId,
      sessionTitle: primaryCard?.sessionTitle ?? native?.sessionTitle,
      sessionCreatedAt: primaryCard?.sessionCreatedAt ?? native?.sessionCreatedAt,
      cardTitle: primaryCard?.title ?? '(No linked card)',
      cardId: primaryCard?.id ?? '',
      cardStatus: primaryCard?.status ?? 'untracked',
      projectDir: primaryCard?.projectDir,
      agentRuntime: primaryCard ? resolveAgentRuntime(primaryCard) : 'opencode',
      agentType: primaryCard?.agentType,
      model: primaryCard?.model,
      linkState: cards.length === 0 ? 'none' : cards.length === 1 ? 'single' : 'multiple',
      relatedCardCount: cards.length,
      isSubagentOnly: cards.length > 0 && !hasTopLevelLinkedCard,
      hasTopLevelLinkedCard,
      hasSubagentLinkedCard,
      visiblePeerCount: native ? peerKeys.size : 0,
      primaryPeerInstanceId: native?.sourceInstanceId,
      primaryPeerPort: native?.sourcePort,
      primaryPeerIsLocal: native?.sourceIsLocal ?? false,
      primaryPeerCwd: native?.sourceCwd,
      updatedAt: primaryCard?.updatedAt
        ?? native?.updatedAt
        ?? native?.sessionCreatedAt
        ?? new Date(0).toISOString(),
    });
  }

  // A session the peer listing does not know about (its runtime has exited) is
  // still real as long as a card names it.
  for (const [sessionId, cards] of cardsBySession) {
    if (nativeBySession.has(sessionId)) continue;
    const aggregate = cardDerivedAggregate(sessionId, cards);
    if (aggregate) sessions.push(aggregate);
  }
  return sessions;
}

/**
 * Aggregates unique sessions from all cards (optionally enriched by the native
 * peer session listing). Extracted so the Works Inbox route can reuse the exact
 * same view that backs `GET /api/sessions`.
 *
 * There are **two** aggregation paths and production only ever takes one of
 * them: `plugin/bootstrap.ts` always injects `aggregateSessionsFn`, so the
 * card-only path exists for unit tests and for a server booted without the
 * plugin. Every cross-session enrichment is therefore derived **after** the
 * branch, over the same archive-inclusive card list — an enrichment written
 * inside one branch is an enrichment that silently does not exist in
 * production. `relatedSessionIds` was exactly that bug: the chain map was
 * computed every poll and thrown away, so `🔗 이어진 세션` never fired outside
 * tests.
 */
export async function computeSessionAggregates(
  store: KanbanStore,
  aggregateSessionsFn?: AggregateSessionsFn,
): Promise<SessionAggregate[]> {
  const allCards = await store.getCards({ includeArchived: true });
  const cardsBySession = groupCardsBySession(allCards);

  const sessions: SessionAggregate[] = aggregateSessionsFn
    ? nativeDerivedAggregates(cardsBySession, await aggregateSessionsFn())
    : Array.from(cardsBySession, ([sessionId, cards]) => cardDerivedAggregate(sessionId, cards))
      .filter((entry): entry is SessionAggregate => entry !== undefined);

  // Lineage is derived from every card, archived included — an Inbox session's
  // cards are usually already off the board — and applied to whichever set of
  // aggregates the branch above produced.
  const chains = buildSessionChainMap(allCards);
  const subagentTree = buildSubagentSessionTree(allCards);
  for (const session of sessions) {
    const related = chains.get(session.sessionId);
    if (related) session.relatedSessionIds = related;
    const ancestors = subagentAncestorSessions(subagentTree, session.sessionId);
    if (ancestors.length > 0) session.parentSessionIds = ancestors;
    session.sessionKind = session.isSubagentOnly === true || ancestors.length > 0
      ? 'subagent'
      : 'main';
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

/**
 * Links a session to a Work, carrying its **subagent descendants** with it.
 *
 * A subagent session is not an independent piece of work — it exists only
 * because a card on the parent session spawned it — so once the parent has a
 * Work, its children do too. Without this the Inbox asked the same question
 * once per subagent, and the answer was always "the same Work as its parent".
 * Descendants already linked somewhere are left alone: the 1:N invariant is the
 * store's and this must never look like a way around it.
 *
 * Each link goes through `resolveWorkStartedAtAfterLinkChange` — the single
 * entry point every link-set change shares — so the Timeline bar's `min()`
 * start is recalculated per link rather than once for the batch.
 */
async function linkSessionWithSubagents(
  workStore: WorkStore,
  store: KanbanStore,
  workId: string,
  input: { sessionId: string; projectDir?: string; role?: WorkSessionRole },
  options: { requireActive?: boolean; cards?: KanbanCard[] } = {},
): Promise<{ work: Work; cascadedSessionIds: string[] }> {
  const current = await workStore.getWork(workId);
  if (!current) throw new WorkNotFoundError(workId);
  // A resolved Work must not take on a session it never ran: a `done` Work has
  // already handed its cards to the wiki pipeline, and a `discarded` one exists
  // only to release its sessions. The client filters recommendations to active
  // Works, but a panel can sit open across a status change (Works polls every
  // 10s) and the recommendation can vanish underneath it, so the gate is here.
  // A **re-link of a session this Work already holds** is exempt: that is how
  // the `⋯` menu edits a link's role, and it changes no grouping.
  if (
    options.requireActive
    && current.status !== 'active'
    && !current.sessionLinks.some(link => link.sessionId === input.sessionId)
  ) {
    throw new WorkNotActiveError(current.status, current.title);
  }

  // One archive-inclusive read for the whole call — and reused across a batch
  // when the caller supplies it. It feeds both the subagent tree and the
  // `min()` resolver, which used to read it again per link.
  const cards = options.cards ?? await store.getCards({ includeArchived: true });
  const resolveStartedAt = createWorkStartedAtResolver(cards);
  const tree = buildSubagentSessionTree(cards);
  const { works } = await workStore.load();
  const linkedElsewhere = new Set<string>();
  for (const other of works) {
    if (other.id === workId) continue;
    for (const link of other.sessionLinks) linkedElsewhere.add(link.sessionId);
  }
  const alreadyHere = new Set(current.sessionLinks.map(link => link.sessionId));
  const cascadedSessionIds = subagentDescendantSessions(tree, input.sessionId)
    .filter(id => !linkedElsewhere.has(id) && !alreadyHere.has(id));

  let work = current;
  for (const sessionId of [input.sessionId, ...cascadedSessionIds]) {
    // The Timeline bar's left edge is min() over every linked session, so a
    // link to an older session pulls it left. The store runs the resolver inside
    // its lock against the link set it just wrote — resolving it out here first
    // is what let two concurrent links overwrite each other's answer.
    work = await workStore.addSession(
      workId,
      {
        sessionId,
        // Only the session the user actually picked carries their role and
        // directory; an inherited subagent takes the defaults.
        projectDir: sessionId === input.sessionId ? input.projectDir : undefined,
        role: sessionId === input.sessionId ? input.role : undefined,
      },
      resolveStartedAt,
    );
  }

  return { work, cascadedSessionIds };
}

/** What decides whether a session aggregate is Inbox triage material. */
export interface InboxFilterContext {
  /** Sessions already linked to some Work. */
  linked: ReadonlySet<string>;
  /** Sessions on the ignore list. Pass an empty set to ask "would it come back?". */
  ignored: ReadonlySet<string>;
  /** `since` cutoff; `undefined` means no cutoff. */
  sinceIso?: string;
}

/**
 * The Inbox's admission rule, as one predicate.
 *
 * Shared by `GET /api/works/inbox` and `GET /api/works/ignored-sessions`: the
 * restore list has to answer "would un-ignoring this actually bring the row
 * back?", and the only honest way to answer it is with the same rule the Inbox
 * itself applies. Re-implementing the four filters there would drift.
 */
export function isInboxTriageMaterial(
  session: SessionAggregate,
  ctx: InboxFilterContext,
): boolean {
  if (!session.sessionId) return false;
  if (ctx.linked.has(session.sessionId) || ctx.ignored.has(session.sessionId)) return false;
  if ((session.relatedCardCount ?? 0) < 1 || session.linkState === 'none') return false;
  if (session.parentSessionIds?.some(id => ctx.linked.has(id))) return false;
  // A running agent is triage material whatever its timestamp says.
  if (ctx.sinceIso && session.cardStatus !== 'in_progress' && session.updatedAt < ctx.sinceIso) {
    return false;
  }
  return true;
}

/** The Inbox row DTO for a session aggregate. */
export function toInboxSession(session: SessionAggregate): WorkInboxSession {
  return {
    sessionId: session.sessionId,
    sessionTitle: session.sessionTitle,
    cardTitle: session.cardTitle,
    cardId: session.cardId,
    cardStatus: session.cardStatus,
    projectDir: session.projectDir,
    agentRuntime: session.agentRuntime,
    agentType: session.agentType,
    model: session.model,
    relatedCardCount: session.relatedCardCount ?? 1,
    sessionKind: session.sessionKind ?? 'main',
    updatedAt: session.updatedAt,
    relatedSessionIds: session.relatedSessionIds,
  };
}

/** Defaults for `GET /api/works/inbox` — see `parseInboxQuery`. */
export const DEFAULT_INBOX_SINCE_DAYS = 30;
export const DEFAULT_INBOX_LIMIT = 200;
export const MAX_INBOX_LIMIT = 1000;

export interface InboxQuery {
  /** Sessions older than this are dropped; `undefined` means no cutoff. */
  sinceIso?: string;
  /** Newest-first cap on the returned rows. */
  limit: number;
}

/**
 * `since` / `limit` for the Inbox.
 *
 * The Inbox is a triage queue, not an archive: without a window it grows
 * without bound and the Works tab badge stays lit forever over sessions nobody
 * will ever assign. Both bounds are therefore **on by default** and both can be
 * opened up explicitly.
 *
 * - `since` — a day count (`since=7`), an ISO 8601 instant
 *   (`since=2026-08-01T00:00:00.000Z`), or `all` / `0` for no cutoff. Default
 *   `DEFAULT_INBOX_SINCE_DAYS` days.
 * - `limit` — a positive integer capped at `MAX_INBOX_LIMIT`, or `all`.
 *   Default `DEFAULT_INBOX_LIMIT`.
 *
 * A day count is tried before ISO parsing on purpose: `Date.parse('30')` is
 * accepted by some engines as a year, which would silently turn `since=30` into
 * a cutoff two millennia ago.
 */
export function parseInboxQuery(params: URLSearchParams, now: Date): InboxQuery {
  const sinceParam = params.get('since');
  let sinceIso: string | undefined;
  if (sinceParam === null) {
    sinceIso = new Date(now.getTime() - DEFAULT_INBOX_SINCE_DAYS * 86_400_000).toISOString();
  } else if (sinceParam === 'all' || sinceParam === '0') {
    sinceIso = undefined;
  } else if (/^\d+$/.test(sinceParam)) {
    sinceIso = new Date(now.getTime() - Number(sinceParam) * 86_400_000).toISOString();
  } else if (!Number.isNaN(Date.parse(sinceParam))) {
    sinceIso = new Date(sinceParam).toISOString();
  } else {
    throw new Error('since must be a day count, an ISO 8601 timestamp, or "all"');
  }

  const limitParam = params.get('limit');
  let limit = DEFAULT_INBOX_LIMIT;
  if (limitParam === 'all') {
    limit = Number.POSITIVE_INFINITY;
  } else if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('limit must be a positive integer or "all"');
    }
    limit = Math.min(parsed, MAX_INBOX_LIMIT);
  }

  return { sinceIso, limit };
}

interface ParsedQuickActionRunInput {
  clientRequestId: string;
  parameterValues: Record<string, unknown>;
}

type QuickActionRunRouteBody =
  | RunQuickActionResponse
  | (RunQuickActionResponse & { error: string })
  | { error: string };

interface QuickActionRunRouteResult {
  body: QuickActionRunRouteBody;
  statusCode: number;
}

function parseQuickActionRunInput(value: unknown): ParsedQuickActionRunInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Quick action run request must be an object');
  }
  const body = value as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((key) => (
    key !== 'clientRequestId' && key !== 'parameterValues'
  ));
  if (unknownKey) throw new Error(`Quick action run request contains unsupported field: ${unknownKey}`);
  if (typeof body.clientRequestId !== 'string' || body.clientRequestId.trim().length === 0) {
    throw new Error('clientRequestId must be a non-empty string');
  }
  if (
    typeof body.parameterValues !== 'object'
    || body.parameterValues === null
    || Array.isArray(body.parameterValues)
  ) {
    throw new Error('parameterValues must be an object');
  }
  return {
    clientRequestId: body.clientRequestId,
    parameterValues: body.parameterValues as Record<string, unknown>,
  };
}

function dispatchErrorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return 500;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : 500;
}

function quickActionWriteErrorStatus(message: string): number {
  return message === QUICK_ACTION_ICON_ERRORS.duplicate
    || message === QUICK_ACTION_ICON_ERRORS.paletteExhausted
    ? 409
    : 400;
}

function quickActionRunResultFromCard(card: KanbanCard): QuickActionRunRouteResult {
  const run = card.quickActionRun;
  const body: RunQuickActionResponse = {
    cardId: card.id,
    status: card.status,
    dispatch: run?.dispatch ?? null,
    ...(run?.failureSummary ? { failureSummary: run.failureSummary } : {}),
  };
  if (run?.status === 'failed') {
    return {
      statusCode: run.errorStatusCode ?? 500,
      body: { ...body, error: run.failureSummary ?? 'Quick action dispatch failed' },
    };
  }
  return { statusCode: run?.status === 'accepted' ? 200 : 202, body };
}

async function scriptQuickActionRunResultFromCard(
  card: KanbanCard,
  scriptStore: ScriptStore,
): Promise<QuickActionRunRouteResult> {
  const run = card.scriptRunId ? await scriptStore.findRun(card.scriptRunId) : null;
  const body: RunQuickActionResponse = {
    cardId: card.id,
    status: card.status,
    dispatch: null,
    ...(card.scriptRunId ? { runId: card.scriptRunId } : {}),
    ...(run ? { runStatus: run.status } : {}),
    ...(card.quickActionRun?.failureSummary
      ? { failureSummary: card.quickActionRun.failureSummary }
      : {}),
  };
  return { statusCode: run?.status === 'running' || !run ? 202 : 200, body };
}
export type LocalPeerSessionsFn = () => Promise<{ instanceId: string; sessions: NativeSessionInfo[] }>;
export type PeerTokenFn = () => string;
export type ScopeMcpInventoryFn = (
  targets: PlacementTarget[],
) => Promise<McpInventoryDiscoveryResult>;

function hasAuthorizedBearerToken(req: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const authorization = req.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return false;
  }

  const provided = authorization.slice('Bearer '.length).trim();
  const expectedBuffer = Buffer.from(expectedToken, 'utf-8');
  const providedBuffer = Buffer.from(provided, 'utf-8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function createRouteHandler(
  store: KanbanStore,
  dispatchFn?: DispatchFn,
  schedulerStore?: SchedulerStore,
  schedulerEngine?: SchedulerEngine,
  settingsStore?: SettingsStore,
  onNetworkSettingChange?: (hostname: string) => void,
  scriptStore?: ScriptStore,
  modelsFn?: ModelsFn,
  questionMonitor?: QuestionMonitor,
  aggregateSessionsFn?: AggregateSessionsFn,
  localPeerSessionsFn?: LocalPeerSessionsFn,
  peerTokenFn?: PeerTokenFn,
  runtimeCatalogFn?: RuntimeCatalogFn,
  wikiWorker?: WikiWorker,
  skillStore?: SkillStore,
  skillRootsStore?: SkillRootsStore,
  placementTargetsStore?: PlacementTargetsStore,
  runtimeRunStore?: RuntimeRunStore,
  scopeMcpInventoryFn?: ScopeMcpInventoryFn,
  quickActionStore?: QuickActionStore,
  scriptExecutionService?: ScriptExecutionService,
  workStore?: WorkStore,
) {
  const effectiveScriptExecutionService = scriptExecutionService ?? (
    scriptStore
      ? new ScriptExecutionService({
        scriptStore,
        cardStore: store,
        settingsStore,
        dispatchFn,
      })
      : undefined
  );
  const activeQuickActionRuns = new Map<string, Promise<QuickActionRunRouteResult>>();

  /**
   * Which of these cards currently has a live agent process, answered in one
   * `listRuns()` read rather than a lookup per card. Feeds the Works completion
   * guard: archiving a card out from under a running runtime makes its
   * completion hook fail with `Card not found` and leaves the wiki summarizing
   * an unfinished transcript. Undefined without a run store — the guard then has
   * nothing to consult and stands down.
   */
  const activeRunProbe: ActiveRunProbe | undefined = runtimeRunStore
    ? async (cardIds: string[]) => {
      const wanted = new Set(cardIds);
      const running = new Set<string>();
      for (const run of await runtimeRunStore.listRuns()) {
        if (run.status !== 'starting' && run.status !== 'running') continue;
        if (wanted.has(run.cardId)) running.add(run.cardId);
      }
      return [...running];
    }
    : undefined;

  async function handleRequest(req: Request, ctx?: { clientAddress?: string }): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Same-origin guard: reject cross-origin browser requests before doing any
    // work. Defends against CSRF / drive-by attacks from pages the user visits
    // while the board is running.
    if (isForbiddenCrossOrigin(req)) {
      return errorResponse('Cross-origin request rejected', 403);
    }

    // Handle preflight (only same-origin requests reach here).
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    }

    // Token bootstrap: the same-origin SPA fetches its auth token here. Served
    // only to loopback clients so that, under `network_exposed` (0.0.0.0),
    // remote devices cannot obtain the token and therefore cannot mutate state
    // or read secrets — they get a read-only view of non-sensitive endpoints.
    if (method === 'GET' && path === '/api/auth/token') {
      const token = peerTokenFn?.() ?? '';
      if (!isLoopbackClient(ctx?.clientAddress)) {
        // Opt-in escape hatch: with `lan_full_access` enabled the token is also
        // served to non-loopback clients, so devices on the LAN get a fully
        // functional UI (Capabilities/Skills/Settings/mutations) instead of the
        // default read-only view. Only meaningful under `network_exposed`, and
        // it hands full board control to anyone who can reach the port — the
        // default stays off.
        const lanFullAccess = settingsStore
          ? (await getSettingValueOrDefault(settingsStore, 'lan_full_access', 'false')) === 'true'
          : false;
        if (!lanFullAccess) {
          return errorResponse('Token available to local clients only', 403);
        }
      }
      return json({ token });
    }

    // Local auth gate: when a token is configured (production plugin/daemon),
    // require it on mutating + secret-bearing routes. When no token is wired
    // (unit tests, e2e test-server), this is a no-op and the same-origin guard
    // remains the active protection.
    const localToken = peerTokenFn?.();
    if (localToken && requiresLocalAuth(method, path)) {
      if (!hasAuthorizedBearerToken(req, localToken)) {
        return errorResponse('Unauthorized', 401);
      }
    }

    if (method === 'GET' && path === '/api/internal/sessions/native') {
      if (!localPeerSessionsFn) {
        return errorResponse('Peer sessions not available', 503);
      }

      const expectedToken = peerTokenFn?.();
      if (!hasAuthorizedBearerToken(req, expectedToken)) {
        return errorResponse('Unauthorized', 401);
      }

      try {
        const payload = await localPeerSessionsFn();
        return json(payload);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to fetch local peer sessions';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/board
    if (method === 'GET' && path === '/api/board') {
      const board = await store.load();
      return json(board);
    }

    // Route: POST /api/maintenance/apply-update-restart
    if (method === 'POST' && path === '/api/maintenance/apply-update-restart') {
      try {
        const result = startApplyUpdateRestart();
        return json(result, 202);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to start maintenance update';
        const status = message.includes('already running') ? 409 : 500;
        return errorResponse(message, status);
      }
    }

    // Route: GET /api/maintenance/status
    if (method === 'GET' && path === '/api/maintenance/status') {
      return json(getMaintenanceStatus());
    }

    // Route: GET /api/maintenance/restart-log
    if (method === 'GET' && path === '/api/maintenance/restart-log') {
      const bytesParam = Number(url.searchParams.get('bytes') ?? '120000');
      const maxBytes = Number.isFinite(bytesParam) && bytesParam > 0
        ? Math.min(bytesParam, 500000)
        : 120000;
      return json(readMaintenanceLog(maxBytes));
    }

    if (method === 'GET' && path === '/api/runtimes') {
      const runtimes = runtimeCatalogFn ? await runtimeCatalogFn() : RUNTIME_CATALOG;
      return json({ runtimes });
    }

    // Route: GET /api/sessions — Aggregate unique sessions from cards
    if (method === 'GET' && path === '/api/sessions') {
      try {
        const sessions = await computeSessionAggregates(store, aggregateSessionsFn);
        return json(sessions);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to fetch sessions';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/timeline?from=&to=&subagents= — executed sessions in a
    // day window. Composes the per-month archive readers instead of
    // `loadArchives()`, so the wiki/Telegram full-archive scans are untouched
    // and a current-month window only parses ~2 files. No Work grouping: the
    // client already holds `/api/works` and maps session → Work itself.
    if (method === 'GET' && path === '/api/timeline') {
      // The window is the only bound on how much archive this parses, and the
      // route is an unauthenticated GET — so an over-long window is refused
      // rather than served (checkTimelineWindow, src/core/timeline-aggregate.ts).
      const requested = checkTimelineWindow(
        url.searchParams.get('from'),
        url.searchParams.get('to'),
      );
      if (!requested.ok) return errorResponse(requested.error, 400);
      const { from, to } = requested;
      const includesSubagents = url.searchParams.get('subagents') === '1';
      try {
        const scannedMonths = timelineArchiveMonths(store.listArchiveMonths(), from);
        const cards: KanbanCard[] = [...await store.getCards({})];
        for (const month of scannedMonths) {
          const archive = await store.loadArchiveMonth(month);
          if (archive) cards.push(...archive.cards);
        }
        // Discarded sessions still ran, so they keep their row — but they are no
        // longer in the Inbox, and a 배정 button that opens a modal with nothing
        // in it is a permanently dead button. Flagged rather than dropped: the
        // work happened and the grid should still say so.
        const ignoredSessionIds = workStore
          ? new Set((await workStore.load()).ignoredSessionIds)
          : undefined;
        const sessions = buildTimelineSessions(cards, {
          from,
          to,
          includeSubagents: includesSubagents,
          now: new Date(),
          ignoredSessionIds,
        });
        const snapshot: TimelineSnapshot = {
          from,
          to,
          includesSubagents,
          sessions,
          scannedMonths,
        };
        return json(snapshot);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to build timeline';
        return errorResponse(message, 500);
      }
    }

    // ─── Works Routes ──────────────────────────────────────────────
    // Work = a human-intent unit grouping 1:N sessions. See docs/mockups and
    // the Works & Timeline design. Writes are Bearer-gated via requiresLocalAuth.

    // Route: GET /api/works?status=&projectDir=&q=&sort=
    //
    // The filter/sort rule itself is the pure `selectWorks` (`core/work-list.ts`)
    // and is shared with the web client, which cannot narrow *this* request: it
    // polls the whole list for the Timeline, the assign recommendations and the
    // move dialog, so its Active section applies the same function locally.
    if (method === 'GET' && path === '/api/works') {
      if (!workStore) return errorResponse('Works not available', 503);
      const statusParam = url.searchParams.get('status');
      if (statusParam && !WORK_STATUS_VALUES.has(statusParam as WorkStatus)) {
        return errorResponse('Invalid status filter', 400);
      }
      const sortParam = url.searchParams.get('sort');
      // Rejected rather than ignored: a client that asked for `stale` and got
      // `updated` sees exactly the order it was trying to get away from.
      if (sortParam !== null && !isWorkListSort(sortParam)) {
        return errorResponse('Invalid sort', 400);
      }
      const works = await workStore.getWorks();
      const cards = await store.getCards();
      const floor = works.map(workCardScanFloor).sort()[0];
      if (floor) {
        for (const month of timelineArchiveMonths(store.listArchiveMonths(), floor)) {
          const archive = await store.loadArchiveMonth(month);
          if (archive) cards.push(...archive.cards);
        }
      }
      const entries = works.map(work => {
        const { cardCount, doneCount, inProgressCount, lastActivityAt } = buildWorkSessionsResponse(work, cards);
        return { ...work, activity: { cardCount, doneCount, inProgressCount, lastActivityAt } };
      });
      return json(selectWorks(entries, {
        status: statusParam as WorkStatus | null ?? undefined,
        projectDir: url.searchParams.get('projectDir') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
        sort: sortParam ?? undefined,
      }));
    }

    // Route: POST /api/works
    if (method === 'POST' && path === '/api/works') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        const body = await req.json();
        if (typeof body.title !== 'string' || !body.title.trim()) {
          return errorResponse('title is required', 400);
        }
        if (body.projectDir !== undefined && typeof body.projectDir !== 'string') {
          return errorResponse('projectDir must be a string', 400);
        }
        // Rejected rather than silently dropped: a client that sends a date the
        // server ignores gets a Work starting *now*, and the Timeline bar is
        // then wrong with no error to explain it.
        if (body.startedAt !== undefined && !isValidIsoDate(body.startedAt)) {
          return errorResponse('Invalid startedAt', 400);
        }
        const work = await workStore.createWork({
          title: body.title,
          projectDir: typeof body.projectDir === 'string' ? body.projectDir : undefined,
          startedAt: body.startedAt === undefined ? undefined : normalizeIsoDate(body.startedAt),
        });
        return json(work, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, 400);
      }
    }

    // Route: GET /api/works/inbox?since=&limit= — sessions still awaiting
    // triage. Four things are *not* triage material and are filtered out here
    // rather than left for the user to scroll past:
    //
    // 1. sessions already linked to a Work, and sessions explicitly discarded;
    // 2. sessions with no card at all — a peer runtime reports every open
    //    session it has, and `(No linked card)` rows used to pile up with no
    //    bound at all, keeping the Works tab badge permanently lit;
    // 3. subagent sessions whose parent is already assigned — the parent's Work
    //    owns them (see `POST /api/works/:id/sessions`), so asking again is
    //    asking a question the user already answered;
    // 4. anything older than `since` (default 30 days), capped at `limit`.
    //    A session with a still-running card is kept regardless of the cutoff.
    if (method === 'GET' && path === '/api/works/inbox') {
      if (!workStore) return errorResponse('Works not available', 503);
      let query: InboxQuery;
      try {
        query = parseInboxQuery(url.searchParams, new Date());
      } catch (e: unknown) {
        return errorResponse(e instanceof Error ? e.message : 'Invalid inbox query', 400);
      }
      try {
        const sessions = await computeSessionAggregates(store, aggregateSessionsFn);
        const { works, ignoredSessionIds } = await workStore.load();
        const linked = new Set<string>();
        for (const w of works) {
          for (const link of w.sessionLinks) linked.add(link.sessionId);
        }
        const ignored = new Set(ignoredSessionIds);
        const inbox: WorkInboxSession[] = sessions
          .filter(s => isInboxTriageMaterial(s, { linked, ignored, sinceIso: query.sinceIso }))
          .slice(0, query.limit === Number.POSITIVE_INFINITY ? undefined : query.limit)
          .map(toInboxSession);
        return json(inbox);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to build inbox';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/works/reconcile-subagents — the one-shot path for data
    // that predates subagent inheritance. `POST /api/works/:id/sessions` now
    // carries a session's subagent descendants with it, but Works linked before
    // that still have orphan subagent sessions sitting in the Inbox. Idempotent:
    // re-running it links nothing once every descendant has a home. Must be
    // registered before the /api/works/:id catch-all.
    if (method === 'POST' && path === '/api/works/reconcile-subagents') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        const cards = await store.getCards({ includeArchived: true });
        const tree = buildSubagentSessionTree(cards);
        const { works } = await workStore.load();
        const linkedAnywhere = new Set<string>();
        for (const w of works) {
          for (const link of w.sessionLinks) linkedAnywhere.add(link.sessionId);
        }

        const linked: Array<{ workId: string; sessionIds: string[] }> = [];
        for (const work of works) {
          const seeds = work.sessionLinks.map(link => link.sessionId);
          const adopted: string[] = [];
          for (const seed of seeds) {
            for (const descendant of subagentDescendantSessions(tree, seed)) {
              if (linkedAnywhere.has(descendant)) continue;
              await linkSessionWithSubagents(workStore, store, work.id, {
                sessionId: descendant,
              });
              linkedAnywhere.add(descendant);
              adopted.push(descendant);
            }
          }
          if (adopted.length > 0) linked.push({ workId: work.id, sessionIds: adopted });
        }
        return json({ linked, linkedCount: linked.reduce((n, e) => n + e.sessionIds.length, 0) });
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to reconcile subagent sessions');
      }
    }

    // Route: POST /api/works/reconcile-links — stamp/clear `cardsMissingAt` on
    // every Work's links. Deleting a card never told Works about it, so a
    // session whose cards were all deleted stayed linked and quietly dropped the
    // Work's Timeline start back to `linkedAt`. The delete/restore routes narrow
    // this pass to one Work; this is the whole-store repair for data that
    // predates them, and it also runs once at boot. Idempotent. Literal segment
    // — must precede the /api/works/:id catch-all.
    if (method === 'POST' && path === '/api/works/reconcile-links') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        return json(await reconcileWorkSessionLinks({ store, workStore }));
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to reconcile work links');
      }
    }

    // Route: POST /api/works/ignore-session
    if (method === 'POST' && path === '/api/works/ignore-session') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        const body = await req.json();
        if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
          return errorResponse('sessionId is required', 400);
        }
        const ignoredSessionIds = await workStore.ignoreSession(body.sessionId);
        return json({ ignoredSessionIds });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, 400);
      }
    }

    // Route: GET /api/works/ignored-sessions — the read side of the ignore list.
    // `POST /api/works/ignore-session` had no counterpart of any kind, which made
    // 폐기 the only irreversible action in this domain that was not even
    // *inspectable*: a session dropped out of the Inbox, the tab badge, and every
    // list, with `works.json` as the only way to find out what was in there.
    // Each row carries the Inbox summary (so it is identifiable by its first
    // prompt) and whether restoring it would really bring the row back.
    // Literal segment — must precede the /api/works/:id catch-all.
    if (method === 'GET' && path === '/api/works/ignored-sessions') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        const sessions = await computeSessionAggregates(store, aggregateSessionsFn);
        const { works, ignoredSessionIds } = await workStore.load();
        const linked = new Set<string>();
        for (const w of works) {
          for (const link of w.sessionLinks) linked.add(link.sessionId);
        }
        const aggregates = new Map(sessions.map(s => [s.sessionId, s]));
        // The window is the Inbox's own default: "would this row come back?" is
        // a question about the Inbox the user is looking at.
        const { sinceIso } = parseInboxQuery(new URLSearchParams(), new Date());
        const noneIgnored: ReadonlySet<string> = new Set();
        const ignored: WorkIgnoredSession[] = ignoredSessionIds.map((sessionId) => {
          const aggregate = aggregates.get(sessionId);
          return {
            sessionId,
            session: aggregate ? toInboxSession(aggregate) : undefined,
            returnsToInbox: aggregate
              ? isInboxTriageMaterial(aggregate, { linked, ignored: noneIgnored, sinceIso })
              : false,
          };
        });
        // Newest activity first, same as the Inbox; ids with no session left sink.
        ignored.sort((a, b) => (b.session?.updatedAt ?? '').localeCompare(a.session?.updatedAt ?? ''));
        return json(ignored);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to list ignored sessions';
        return errorResponse(message, 500);
      }
    }

    // Route: DELETE /api/works/ignore-session/:sessionId — restore an ignored
    // session. `404` when it was not on the list, so a stale restore list cannot
    // report success for a row that was already taken off it.
    const workUnignoreMatch = path.match(/^\/api\/works\/ignore-session\/([^/]+)$/);
    if (workUnignoreMatch && method === 'DELETE') {
      if (!workStore) return errorResponse('Works not available', 503);
      const sessionId = decodeURIComponent(workUnignoreMatch[1]);
      try {
        const ignoredSessionIds = await workStore.unignoreSession(sessionId);
        return json({ ignoredSessionIds });
      } catch (e: unknown) {
        if (e instanceof WorkSessionNotIgnoredError) return errorResponse(e.message, 404);
        return worksErrorResponse(e, 'Failed to restore session');
      }
    }

    // Route: GET /api/works/config — works-scoped settings (independent of wiki)
    // Must precede the /api/works/:id catch-all (id would otherwise be "config").
    if (method === 'GET' && path === '/api/works/config') {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      return json(await loadWorksConfigDto(settingsStore));
    }

    // Route: POST /api/works/config — save works settings from the settings panel.
    if (method === 'POST' && path === '/api/works/config') {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      try {
        const body = await req.json().catch(() => ({})) as WorksConfigInput;
        if (body.summaryLines !== undefined && ![3, 4, 5].includes(body.summaryLines)) {
          return errorResponse('summaryLines must be 3, 4, or 5', 400);
        }
        if (body.staleDays !== undefined && (typeof body.staleDays !== 'number' || !Number.isFinite(body.staleDays) || body.staleDays < 1)) {
          return errorResponse('staleDays must be a number >= 1', 400);
        }
        if (body.assignPreferSameDir !== undefined && typeof body.assignPreferSameDir !== 'boolean') {
          return errorResponse('assignPreferSameDir must be a boolean', 400);
        }
        if (body.assignSuggestResumeChain !== undefined && typeof body.assignSuggestResumeChain !== 'boolean') {
          return errorResponse('assignSuggestResumeChain must be a boolean', 400);
        }
        if (body.doneConfirm !== undefined && typeof body.doneConfirm !== 'boolean') {
          return errorResponse('doneConfirm must be a boolean', 400);
        }
        const saved = await saveWorksConfig(settingsStore, body);
        return json(saved);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Save config failed';
        return errorResponse(message, 400);
      }
    }

    // Route: PATCH /api/works/sessions/:sessionId — move a session's link to
    // another Work. Like /api/works/config this literal-segment path must be
    // registered before the /api/works/:id catch-all, and it is distinct from
    // /api/works/:id/sessions/:sessionId (which carries a Work id in the second
    // segment, where this one has the literal "sessions").
    const workMoveSessionMatch = path.match(/^\/api\/works\/sessions\/([^/]+)$/);
    if (workMoveSessionMatch && method === 'PATCH') {
      if (!workStore) return errorResponse('Works not available', 503);
      const sessionId = decodeURIComponent(workMoveSessionMatch[1]);
      try {
        const body = await req.json();
        if (typeof body.toWorkId !== 'string' || !body.toWorkId.trim()) {
          return errorResponse('toWorkId is required', 400);
        }
        if (body.role !== undefined && !WORK_SESSION_ROLE_VALUES.has(body.role as WorkSessionRole)) {
          return errorResponse('Invalid role', 400);
        }
        // One card snapshot feeds both sides; the min() itself runs inside the
        // store's lock, against each side's post-move link set. The archived/
        // un-archived gate is the store's too — the move dialog can sit open
        // across a status change, so the client's filter is never trusted.
        const cards = await store.getCards({ includeArchived: true });
        const moved = await workStore.moveSession(
          {
            sessionId,
            toWorkId: body.toWorkId.trim(),
            role: body.role as WorkSessionRole | undefined,
          },
          work => resolveWorkStartedAt(cards, work),
        );
        return json(moved);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to move session');
      }
    }

    // Route: POST /api/works/:id/summary — generate a Work Summary from every
    // connected session's transcript via the works.summary_model LLM.
    const workSummaryMatch = path.match(/^\/api\/works\/([^/]+)\/summary$/);
    if (workSummaryMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      if (!settingsStore) return errorResponse('Settings not available', 503);
      const workId = workSummaryMatch[1];
      try {
        const work = await workStore.getWork(workId);
        if (!work) return errorResponse('Work not found', 404);

        const config = await loadWorksConfig(settingsStore);
        // Include archived cards: a completed Work's cards may already be archived.
        const cards = await store.getCards({ includeArchived: true });
        const sources: WorkTranscriptSource[] = work.sessionLinks.map((link) => {
          const card = cards.find(c => c.sessionId === link.sessionId);
          const projectDir = link.projectDir ?? card?.projectDir ?? work.projectDir;
          const transcript = projectDir
            ? loadClaudeTranscript({
                agentRuntime: card?.agentRuntime ?? 'claude',
                sessionId: link.sessionId,
                projectDir,
              })
            : undefined;
          return { link, transcript, cardContext: buildWorkCardContext(cards.filter(c => c.sessionId === link.sessionId)), title: card?.title };
        });

        const llmRunner = createWikiLlm({
          settingsStore,
          model: async () => config.summaryModel,
          effort: async () => DEFAULT_CODEX_REASONING_EFFORT,
        });
        const result = await generateWorkSummary({
          work,
          sources,
          lines: config.summaryLines,
          model: config.summaryModel,
          effort: DEFAULT_CODEX_REASONING_EFFORT,
          llmRunner,
        });
        const updated = await workStore.updateWork(workId, { summary: result.summary });
        return json({
          work: updated,
          summary: result.summary,
          generatedSessions: result.generatedSessions,
          cardSourceSessions: result.cardSourceSessions,
          skippedSessions: result.skippedSessions,
        });
      } catch (e: unknown) {
        if (e instanceof WorkNotFoundError) return errorResponse('Work not found', 404);
        const message = e instanceof Error ? e.message : 'Summary generation failed';
        if (message.includes('No session transcripts')) return errorResponse(message, 422);
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/works/:id/sessions/batch — link a whole triage selection
    // in one call.
    //
    // The web used to send N sequential `POST .../sessions`, and each of those
    // read the entire archive (twice, before the resolver change): assigning 20
    // sessions meant 20+ full-archive scans for a single user action. One call,
    // one card snapshot, shared by every link *and* by the subagent tree.
    //
    // Partial success is a normal outcome and is reported, not thrown: the 1:N
    // invariant is per-session, so one session that already belongs to another
    // Work must not roll back the links that did succeed. The three-segment path
    // must be matched before the two-segment `/sessions` route below.
    const workBatchAddSessionsMatch = path.match(/^\/api\/works\/([^/]+)\/sessions\/batch$/);
    if (workBatchAddSessionsMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workBatchAddSessionsMatch[1];
      try {
        const body = await req.json();
        if (!Array.isArray(body.sessions) || body.sessions.length === 0) {
          return errorResponse('sessions must be a non-empty array', 400);
        }
        if (body.role !== undefined && !WORK_SESSION_ROLE_VALUES.has(body.role as WorkSessionRole)) {
          return errorResponse('Invalid role', 400);
        }
        const requested: AddWorkSessionInput[] = [];
        for (const raw of body.sessions as unknown[]) {
          const entry = raw as Record<string, unknown>;
          if (typeof entry?.sessionId !== 'string' || !entry.sessionId.trim()) {
            return errorResponse('sessions[].sessionId is required', 400);
          }
          if (entry.projectDir !== undefined && typeof entry.projectDir !== 'string') {
            return errorResponse('sessions[].projectDir must be a string', 400);
          }
          if (entry.role !== undefined && !WORK_SESSION_ROLE_VALUES.has(entry.role as WorkSessionRole)) {
            return errorResponse('Invalid role', 400);
          }
          requested.push({
            sessionId: entry.sessionId.trim(),
            projectDir: entry.projectDir as string | undefined,
            role: (entry.role as WorkSessionRole | undefined) ?? (body.role as WorkSessionRole | undefined),
          });
        }

        const work = await workStore.getWork(workId);
        if (!work) return errorResponse('Work not found', 404);
        const cards = await store.getCards({ includeArchived: true });

        let latest = work;
        const linkedSessionIds: string[] = [];
        const cascadedSessionIds: string[] = [];
        const failed: WorkBatchLinkFailure[] = [];
        for (const entry of requested) {
          try {
            const result = await linkSessionWithSubagents(
              workStore, store, workId, entry, { requireActive: true, cards },
            );
            latest = result.work;
            linkedSessionIds.push(entry.sessionId);
            for (const id of result.cascadedSessionIds) {
              if (!cascadedSessionIds.includes(id)) cascadedSessionIds.push(id);
            }
          } catch (e: unknown) {
            failed.push({
              sessionId: entry.sessionId,
              message: e instanceof Error ? e.message : 'Failed to link session',
            });
          }
        }
        const response: WorkBatchAddSessionsResponse = {
          work: latest,
          linkedSessionIds,
          cascadedSessionIds,
          failed,
        };
        return json(response);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Invalid request body');
      }
    }

    // Route: POST /api/works/:id/sessions
    const workAddSessionMatch = path.match(/^\/api\/works\/([^/]+)\/sessions$/);
    if (workAddSessionMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workAddSessionMatch[1];
      try {
        const body = await req.json();
        if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
          return errorResponse('sessionId is required', 400);
        }
        if (body.role !== undefined && !WORK_SESSION_ROLE_VALUES.has(body.role as WorkSessionRole)) {
          return errorResponse('Invalid role', 400);
        }
        // Trim once here so the projected link id matches the one the store stores.
        const sessionId = body.sessionId.trim();
        // Subagent sessions come along: see `linkSessionWithSubagents`. The
        // response is the Work plus which sessions were inherited, so the client
        // can say so instead of the Inbox silently losing rows.
        const { work, cascadedSessionIds } = await linkSessionWithSubagents(
          workStore,
          store,
          workId,
          {
            sessionId,
            projectDir: typeof body.projectDir === 'string' ? body.projectDir : undefined,
            role: body.role as WorkSessionRole | undefined,
          },
          // Only the user-facing link path demands an `active` target;
          // `reconcile-subagents` repairs historical Works of any status.
          { requireActive: true },
        );
        const response: WorkAddSessionResponse = { ...work, cascadedSessionIds };
        return json(response);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Invalid request body');
      }
    }

    // Route: GET /api/works/:id/completion-preview — what completing this Work
    // would destroy, so the confirmation dialog can state it before the user
    // commits. Archive-inclusive for the same reason `/sessions` is: an already
    // swept Work must not describe itself as touching zero cards. Also reports
    // the cards with a live agent run, which is what makes completion a `409`.
    const workCompletionPreviewMatch = path.match(/^\/api\/works\/([^/]+)\/completion-preview$/);
    if (workCompletionPreviewMatch && method === 'GET') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workCompletionPreviewMatch[1];
      try {
        const work = await workStore.getWork(workId);
        if (!work) return errorResponse('Work not found', 404);
        const scannedMonths = timelineArchiveMonths(
          store.listArchiveMonths(),
          workCardScanFloor(work),
        );
        const liveCards = await store.getCards({});
        const cards: KanbanCard[] = [...liveCards];
        const archivedCardIds = new Set<string>();
        for (const month of scannedMonths) {
          const archive = await store.loadArchiveMonth(month);
          if (!archive) continue;
          for (const card of archive.cards) {
            archivedCardIds.add(card.id);
            cards.push(card);
          }
        }
        // Only board cards can be running: an archived card's run is over. And
        // only cards the sweep would actually take can block it — a favorited
        // card stays on the board, so its live run is nobody's problem here.
        const boardSeedIds = selectWorkSweepCards(liveCards, work)
          .filter(c => !c.favorite)
          .map(c => c.id);
        const runningCardIds = activeRunProbe && boardSeedIds.length > 0
          ? await activeRunProbe(boardSeedIds)
          : [];
        const otherSessions = new Set((await workStore.getWorks()).filter(w => w.id !== work.id)
          .flatMap(w => w.sessionLinks.map(l => l.sessionId)));
        return json(buildWorkCompletionPreview(work, cards, {
          conflictingCardIds: selectWorkSweepCards(liveCards, work).filter(c => c.sessionId && otherSessions.has(c.sessionId)).map(c => c.id),
          archivedCardIds,
          runningCardIds,
          scannedMonths,
        }));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to build completion preview';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/works/:id/sessions — the Work detail dialog's data source.
    // Computed over the live board *plus* the archive months the Work can reach,
    // because completing a Work sweeps every card under it off the board: a
    // client-side rollup would describe a finished Work as `카드 0 · done 0`.
    // Month selection reuses the Timeline's own heuristic, so this stays a
    // couple of file reads and never becomes `store.loadArchives()`.
    const workSessionsMatch = path.match(/^\/api\/works\/([^/]+)\/sessions$/);
    if (workSessionsMatch && method === 'GET') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workSessionsMatch[1];
      try {
        const work = await workStore.getWork(workId);
        if (!work) return errorResponse('Work not found', 404);
        const scannedMonths = timelineArchiveMonths(
          store.listArchiveMonths(),
          workCardScanFloor(work),
        );
        const cards: KanbanCard[] = [...await store.getCards({})];
        // A card carries no archived flag (`archivedAt` lives on the monthly
        // file), so the two reads are kept distinguishable by id.
        const archivedCardIds = new Set<string>();
        for (const month of scannedMonths) {
          const archive = await store.loadArchiveMonth(month);
          if (!archive) continue;
          for (const card of archive.cards) {
            archivedCardIds.add(card.id);
            cards.push(card);
          }
        }
        return json(buildWorkSessionsResponse(work, cards, { archivedCardIds, scannedMonths }));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to load work sessions';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/works/:id/reopen — put a terminal Work back to `active`
    // and lift its bulk-archived cards back onto the board.
    //
    // Completion was a one-way door. `PATCH` accepted `status: 'active'` but no
    // UI sent it, the archived cards never came back, and `archivedAt` stayed
    // stamped — which also kept the sweep and the session-move gate closed for
    // good. The only escape was `DELETE`, i.e. throwing the record away.
    //
    // Three-segment literal — must precede the `/api/works/:id` catch-all.
    const workReopenMatch = path.match(/^\/api\/works\/([^/]+)\/reopen$/);
    if (workReopenMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      try {
        const result = await reopenWork({ store, workStore, workId: workReopenMatch[1] });
        return json(result);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to reopen work');
      }
    }

    // Route: POST /api/works/:id/merge — fold this Work's sessions into another
    // one. `{ intoWorkId }`.
    //
    // The only merge-shaped path before this was moving sessions out one at a
    // time and waiting for the source to empty, which *deletes* the source and
    // takes its Summary and Timeline history with it. Here the source survives
    // as `discarded` / `superseded` / `supersededByWorkId`, so the Resolved row
    // still says where its sessions went.
    //
    // Three-segment literal — must precede the `/api/works/:id` catch-all.
    const workMergeMatch = path.match(/^\/api\/works\/([^/]+)\/merge$/);
    if (workMergeMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workMergeMatch[1];
      try {
        const body = await req.json();
        if (typeof body.intoWorkId !== 'string' || !body.intoWorkId.trim()) {
          return errorResponse('intoWorkId is required', 400);
        }
        // One card snapshot for the target's `min()`, resolved inside the
        // store's lock against its post-merge link set — the same contract every
        // other link-set change uses.
        const result = await workStore.mergeWork(
          workId,
          body.intoWorkId.trim(),
          await loadWorkStartedAtResolver(store),
        );
        return json(result);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to merge work');
      }
    }

    // Route: POST /api/works/:id/prune-sessions — drop every link stamped
    // `cardsMissingAt` (its session has no cards left anywhere the Work can
    // reach). The stamp is written by `reconcileWorkSessionLinks`; removing the
    // link is deliberately a separate, explicit action, because card deletion is
    // a soft delete that `restoreCard` reverses.
    //
    // Three-segment literal — must precede `/api/works/:id/sessions/:sessionId`
    // only in the sense that it cannot be confused with it (`prune-sessions` is
    // one segment), but it does have to precede the `/api/works/:id` catch-all.
    const workPruneSessionsMatch = path.match(/^\/api\/works\/([^/]+)\/prune-sessions$/);
    if (workPruneSessionsMatch && method === 'POST') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workPruneSessionsMatch[1];
      try {
        const result = await workStore.pruneMissingSessions(
          workId,
          await loadWorkStartedAtResolver(store),
        );
        return json(result);
      } catch (e: unknown) {
        return worksErrorResponse(e, 'Failed to prune work sessions');
      }
    }

    // Route: DELETE /api/works/:id/sessions/:sessionId
    const workRemoveSessionMatch = path.match(/^\/api\/works\/([^/]+)\/sessions\/([^/]+)$/);
    if (workRemoveSessionMatch && method === 'DELETE') {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workRemoveSessionMatch[1];
      const sessionId = decodeURIComponent(workRemoveSessionMatch[2]);
      try {
        // Same rule in reverse: dropping the oldest session pushes the bar's
        // start to the earliest of whatever remains. The store runs the resolver
        // inside its lock — and skips it entirely when the session was not
        // linked, so a no-op DELETE cannot overwrite a manually re-dated Work.
        const work = await workStore.removeSession(
          workId,
          sessionId,
          await loadWorkStartedAtResolver(store),
        );
        return json(work);
      } catch (e: unknown) {
        // The server's own reason, like every other Works route. Collapsing
        // everything into `Failed to remove session` hid which of the store's
        // rejections had happened.
        return worksErrorResponse(e, 'Failed to remove session');
      }
    }

    // Match /api/works/:id
    const workMatch = path.match(/^\/api\/works\/([^/]+)$/);
    if (workMatch) {
      if (!workStore) return errorResponse('Works not available', 503);
      const workId = workMatch[1];

      if (method === 'GET') {
        const work = await workStore.getWork(workId);
        if (!work) return errorResponse('Work not found', 404);
        return json(work);
      }

      if (method === 'PATCH') {
        try {
          const body = await req.json();
          const updates: UpdateWorkInput = {};
          // Every field is type-checked before it reaches the store. It used to
          // take `title`/`projectDir`/`summary` verbatim, so `{"title": 7}` came
          // back as `400 .trim is not a function` — an internal stack detail as
          // the user-facing error.
          if (body.title !== undefined) {
            if (typeof body.title !== 'string') return errorResponse('title must be a string', 400);
            updates.title = body.title;
          }
          if (body.status !== undefined) {
            if (!WORK_STATUS_VALUES.has(body.status as WorkStatus)) {
              return errorResponse('Invalid status', 400);
            }
            updates.status = body.status;
          }
          if (body.resolution !== undefined) {
            if (body.resolution !== null && !WORK_RESOLUTION_VALUES.has(body.resolution)) {
              return errorResponse('Invalid resolution', 400);
            }
            updates.resolution = body.resolution;
          }
          if (body.projectDir !== undefined) {
            if (body.projectDir !== null && typeof body.projectDir !== 'string') {
              return errorResponse('projectDir must be a string or null', 400);
            }
            updates.projectDir = body.projectDir;
          }
          // Date edits arrive from the Timeline's bar-edge drag and the detail
          // dialog's date inputs, so a malformed timestamp must never reach the
          // store — an unparseable startedAt would drop the bar off the grid.
          // Stored normalized to UTC `Z` so mixed offsets cannot make the
          // `min()` clamp compare two instants as text.
          if (body.startedAt !== undefined) {
            if (!isValidIsoDate(body.startedAt)) return errorResponse('Invalid startedAt', 400);
            updates.startedAt = normalizeIsoDate(body.startedAt);
          }
          if (body.resolvedAt !== undefined) {
            if (body.resolvedAt !== null && !isValidIsoDate(body.resolvedAt)) {
              return errorResponse('Invalid resolvedAt', 400);
            }
            updates.resolvedAt = body.resolvedAt === null
              ? null
              : normalizeIsoDate(body.resolvedAt);
          }
          if (body.summary !== undefined) {
            if (body.summary !== null && !isWorkSummary(body.summary)) {
              return errorResponse('summary must be { lines: string[], generatedAt, model } or null', 400);
            }
            updates.summary = body.summary;
          }
          // `notes` is the one text field on a Work the *user* owns — `summary`
          // is overwritten wholesale by the Summary LLM, so anything typed there
          // was destroyed by the next regeneration. Capped rather than unbounded:
          // `works.json` is rewritten whole on every store write.
          if (body.notes !== undefined) {
            if (body.notes !== null && typeof body.notes !== 'string') {
              return errorResponse('notes must be a string or null', 400);
            }
            if (typeof body.notes === 'string' && body.notes.length > WORK_NOTES_MAX_LENGTH) {
              return errorResponse(
                `notes must be at most ${WORK_NOTES_MAX_LENGTH} characters`,
                400,
              );
            }
            updates.notes = body.notes;
          }
          // `archivedAt` and `wikiDocPath` are **server-owned**. `archivedAt` is
          // stamped by `claimArchiveSweep` and gates both the completion sweep's
          // idempotence and the session-move rule; an arbitrary client string
          // parked there froze both permanently, with no UI able to undo it.
          // `wikiDocPath` is the wiki worker's own bookkeeping.
          if (body.archivedAt !== undefined) {
            return errorResponse('archivedAt is set by the server and cannot be patched', 400);
          }
          if (body.wikiDocPath !== undefined) {
            return errorResponse('wikiDocPath is set by the server and cannot be patched', 400);
          }
          // Same rule, same reason: the merge transition
          // (`POST /api/works/:id/merge`) is the only writer, and a client-set
          // pointer would claim a merge that never happened — the Resolved row
          // would send the reader to a Work that never took these sessions.
          if (body.supersededByWorkId !== undefined) {
            return errorResponse(
              'supersededByWorkId is set by the server and cannot be patched',
              400,
            );
          }

          // `status: 'done'` carries the bulk done→archive side effect (which
          // hands the cards to the wiki pipeline). `works.done_confirm` gates it
          // behind the client's `confirmArchive` flag; the endpoint itself is
          // unchanged. Defaults to the documented `true` (confirm) when settings
          // are unavailable — an unreadable setting must not silently open the
          // destructive path.
          const doneConfirm = settingsStore
            ? (await loadWorksConfig(settingsStore)).doneConfirm
            : true;
          const result = await applyWorkPatch({
            store,
            workStore,
            workId,
            updates,
            doneConfirm,
            confirmArchive: body.confirmArchive === true,
            activeRunProbe,
          });
          // The sweep report rides along with the Work so a partial sweep is
          // visible instead of looking like a clean completion. `Work` has no
          // `sweep` field, so every existing caller is unaffected.
          const response: WorkPatchResponse = { ...result.work };
          if (
            result.archiveSkipped
            || result.archivedCount > 0
            || result.failedCards.length > 0
            || result.keptFavoriteCardIds.length > 0
          ) {
            response.sweep = {
              archivedCount: result.archivedCount,
              archiveMonth: result.archiveMonth,
              skipped: result.archiveSkipped,
              failed: result.failedCards,
              keptFavoriteCardIds: result.keptFavoriteCardIds.length > 0
                ? result.keptFavoriteCardIds
                : undefined,
            };
          }
          // Newly archived cards are stamped wiki-pending — process them promptly.
          if (result.archivedCount > 0) wikiWorker?.kick();
          return json(response);
        } catch (e: unknown) {
          return worksErrorResponse(e, 'Invalid request body');
        }
      }

      if (method === 'DELETE') {
        try {
          await workStore.deleteWork(workId);
          return new Response(null, { status: 204 });
        } catch (e: unknown) {
          if (e instanceof WorkNotFoundError) return errorResponse('Work not found', 404);
          return errorResponse('Delete failed', 500);
        }
      }
    }

    // Route: GET /api/cards
    if (method === 'GET' && path === '/api/cards') {
      const status = url.searchParams.get('status') as Parameters<typeof store.getCards>[0] extends { status?: infer S } ? S : never;
      const includeArchived = url.searchParams.get('include_archived') === 'true';
      const cards = await store.getCards(status ? { status, includeArchived } : includeArchived ? { includeArchived } : undefined);
      // `session_id` narrows the (already loaded) result to one conversation.
      // Paired with `include_archived=true` it is what lets the session
      // conversation modal open a session whose cards have all been archived —
      // a completed Work's sessions, and any Timeline rail older than the board.
      const sessionId = url.searchParams.get('session_id');
      if (sessionId) {
        return json(cards.filter((card) => card.sessionId === sessionId));
      }
      return json(cards);
    }

    // Route: GET /api/cards/deleted
    if (method === 'GET' && path === '/api/cards/deleted') {
      const cards = await store.getDeletedCards();
      return json(cards);
    }

    // TODO: Add GET /api/cards?label=X&priority=Y filtering
    // TODO: Add GET /api/stats endpoint (card counts, avg completion time)

    // Route: POST /api/archive
    if (method === 'POST' && path === '/api/archive') {
      try {
        const body = await req.json() as { cardIds?: string[] };
        const result = await store.archiveCards(body.cardIds);
        // Archived cards are stamped wiki-pending — process them promptly.
        wikiWorker?.kick();
        return json(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Archive failed';
        return errorResponse(message, 500);
      }
    }

    // ─── Wiki Routes ────────────────────────────────────────────────

    // Route: GET /api/wiki/status — worker + queue snapshot
    if (method === 'GET' && path === '/api/wiki/status') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      return json(await wikiWorker.getStatus());
    }

    // Route: GET /api/wiki/config — current wiki config (configured flag + values)
    if (method === 'GET' && path === '/api/wiki/config') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      return json(await wikiWorker.getConfig());
    }

    // Route: GET /api/wiki/archive/cards — paginated card-level archive scan
    if (method === 'GET' && path === '/api/wiki/archive/cards') {
      const statusParam = url.searchParams.get('status') ?? 'all';
      if (!WIKI_ARCHIVE_CARD_FILTERS.has(statusParam as WikiArchiveCardStatusFilter)) {
        return errorResponse('status must be one of all, kept, skipped, failed, pending, unprocessed', 400);
      }
      const limitParam = url.searchParams.get('limit');
      let limit = 100;
      if (limitParam !== null) {
        const parsed = Number.parseInt(limitParam, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return errorResponse('limit must be a positive number', 400);
        }
        limit = Math.min(parsed, 200);
      }
      try {
        return json(await store.listWikiArchiveCards({
          limit,
          cursor: url.searchParams.get('cursor') ?? undefined,
          status: statusParam as WikiArchiveCardStatusFilter,
          q: url.searchParams.get('q') ?? undefined,
        }));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to fetch archive cards';
        const status = message === 'Invalid archive cursor' ? 400 : 500;
        return errorResponse(message, status);
      }
    }

    // Route: POST /api/wiki/config — save wiki settings from the WIKI tab.
    // Only provided fields are persisted; enabling kicks a processing pass.
    if (method === 'POST' && path === '/api/wiki/config') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      try {
        const body = await req.json().catch(() => ({})) as import('../core/types').WikiConfigInput;
        if (body.effort !== undefined && typeof body.effort !== 'string') {
          return errorResponse('effort must be a string', 400);
        }
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          return errorResponse('enabled must be a boolean', 400);
        }
        const saved = await wikiWorker.saveConfig(body);
        return json(saved);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Save config failed';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/wiki/archive — archived cards for one month (paged by month)
    if (method === 'GET' && path === '/api/wiki/archive') {
      const months = store.listArchiveMonths();
      const requested = url.searchParams.get('month');
      if (requested && !/^\d{4}-\d{2}$/.test(requested)) {
        return errorResponse('month must be formatted as YYYY-MM', 400);
      }
      const month = requested ?? months[0];
      if (!month) {
        return json({ months, month: null, cards: [] });
      }
      const archive = await store.loadWikiArchiveMonth(month);
      const cards = (archive?.cards ?? [])
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json({ months, month, cards });
    }

    // Route: GET /api/wiki/doc — read a generated wiki document (frontmatter stripped)
    if (method === 'GET' && path === '/api/wiki/doc') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      const docPath = url.searchParams.get('path');
      if (!docPath) {
        return errorResponse('path is required', 400);
      }
      const content = await wikiWorker.readDocument(docPath);
      if (content === null) {
        return errorResponse('Document not found', 404);
      }
      return json({ path: docPath, content });
    }

    // Route: POST /api/wiki/backfill — queue unprocessed/outdated archived cards.
    // body.limit caps the queue at the N most recent candidates (default 500;
    // 0 = unlimited) so a casual click can't burn tokens on the whole archive.
    if (method === 'POST' && path === '/api/wiki/backfill') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      try {
        const body = await req.json().catch(() => ({})) as { limit?: number };
        const limit = typeof body.limit === 'number' && body.limit >= 0 ? body.limit : 500;
        const queued = await wikiWorker.backfill(limit > 0 ? limit : undefined);
        return json({ queued, limit });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Backfill failed';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/wiki/reprocess — force re-queue specific archived cards
    if (method === 'POST' && path === '/api/wiki/reprocess') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      try {
        const body = await req.json() as { cardIds?: string[] };
        if (!Array.isArray(body.cardIds) || body.cardIds.length === 0) {
          return errorResponse('cardIds is required', 400);
        }
        const queued = await wikiWorker.reprocess(body.cardIds);
        return json({ queued });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Reprocess failed';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/wiki/restart — reset worker state and restart its timer
    if (method === 'POST' && path === '/api/wiki/restart') {
      if (!wikiWorker) {
        return errorResponse('Wiki worker not available', 503);
      }
      wikiWorker.restart();
      return json(await wikiWorker.getStatus());
    }

    // Route: POST /api/cards
    if (method === 'POST' && path === '/api/cards') {
      try {
        const body = await req.json() as {
          agentRuntime?: string;
          command?: string;
          title?: string;
          description?: string;
          scheduledDispatch?: { scheduledAt?: string };
          queuedAfterCardId?: string;
          queuePosition?: number;
          queueSessionMode?: import('../core/types').QueueSessionMode;
        } & Record<string, unknown>;
        const agentRuntime: import('../core/types').AgentRuntime = (
          body.agentRuntime === 'opencode'
          || body.agentRuntime === 'codex'
          || body.agentRuntime === 'claude'
        )
          ? body.agentRuntime
          : 'opencode';
        const commandDefinition = getRuntimeCommandDefinition(body.command, agentRuntime);
        const requiresPrompt = !commandDefinition || commandDefinition.executionMode === 'command_with_prompt';
        if (!body.title || (requiresPrompt && !body.description)) {
          return errorResponse('title and description are required', 400);
        }
        let scheduledDispatch: { scheduledAt: string } | undefined;
        if (body.scheduledDispatch) {
          const scheduledAt = body.scheduledDispatch?.scheduledAt;
          if (typeof scheduledAt !== 'string') {
            return errorResponse('scheduledDispatch.scheduledAt is required', 400);
          }
          if (body.queuedAfterCardId || body.queuePosition !== undefined || body.queueSessionMode !== undefined) {
            return errorResponse('Queued cards cannot also be scheduled', 400);
          }
          scheduledDispatch = { scheduledAt };
        }
        const {
          originChannel: _originChannel,
          executionKind: _executionKind,
          quickActionId: _quickActionId,
          quickActionRequestId: _quickActionRequestId,
          scriptRunId: _scriptRunId,
          scriptName: _scriptName,
          parameterSnapshot: _parameterSnapshot,
          ...publicCardInput
        } = body;
        const card = await store.createCard({
          ...publicCardInput,
          agentRuntime,
          title: body.title,
          description: body.description ?? '',
          scheduledDispatch,
        });
        return json(card, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, 400);
      }
    }

    // ─── Quick Action Routes ──────────────────────────────────────

    if (method === 'GET' && path === '/api/quick-actions') {
      if (!quickActionStore) return errorResponse('Quick actions not available', 503);
      return json(await quickActionStore.getActions());
    }

    if (method === 'POST' && path === '/api/quick-actions') {
      if (!quickActionStore) return errorResponse('Quick actions not available', 503);
      try {
        return json(await quickActionStore.createAction(await req.json()), 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, quickActionWriteErrorStatus(message));
      }
    }

    const quickActionRunMatch = path.match(/^\/api\/quick-actions\/([^/]+)\/run$/);
    if (quickActionRunMatch && method === 'POST') {
      if (!quickActionStore) return errorResponse('Quick actions not available', 503);

      let input: ParsedQuickActionRunInput;
      try {
        input = parseQuickActionRunInput(await req.json());
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, 400);
      }

      const id = decodeURIComponent(quickActionRunMatch[1]);
      const idempotencyKey = JSON.stringify([id, input.clientRequestId]);
      const inFlight = activeQuickActionRuns.get(idempotencyKey);
      if (inFlight) {
        const result = await inFlight;
        return json(result.body, result.statusCode);
      }

      const runPromise = (async (): Promise<QuickActionRunRouteResult> => {
        const priorCard = await store.findQuickActionCard(id, input.clientRequestId);
        if (priorCard) {
          if (priorCard.executionKind === 'script') {
            if (!scriptStore) {
              return { statusCode: 503, body: { error: 'Scripts not available' } };
            }
            return scriptQuickActionRunResultFromCard(priorCard, scriptStore);
          }
          return quickActionRunResultFromCard(priorCard);
        }

        const action = await quickActionStore.getAction(id);
        if (!action) {
          return { statusCode: 404, body: { error: 'Quick action not found' } };
        }
        if (!action.enabled) {
          return { statusCode: 409, body: { error: 'Quick action is disabled' } };
        }
        if (!action.available) {
          return {
            statusCode: 409,
            body: { error: action.unavailableReason ?? 'Quick action is unavailable' },
          };
        }
        if (action.type === 'script') {
          if (!scriptStore || !effectiveScriptExecutionService) {
            return { statusCode: 503, body: { error: 'Script execution not available' } };
          }
          let resolved: ReturnType<typeof resolveQuickActionParameters>;
          try {
            resolved = resolveQuickActionParameters(action, input.parameterValues);
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'Quick action parameter validation failed';
            return { statusCode: 400, body: { error: message } };
          }

          let plan: Awaited<ReturnType<ScriptExecutionService['prepareExecution']>>;
          try {
            plan = await effectiveScriptExecutionService.prepareExecution({
              scriptId: action.scriptId,
              cwdOverride: action.projectDir,
              parameterValues: resolved.values,
              secretParameterKeys: new Set(
                action.parameterDefinitions
                  .filter((definition) => definition.type === 'secret')
                  .map((definition) => definition.key),
              ),
            });
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'Script execution validation failed';
            return { statusCode: dispatchErrorStatus(e), body: { error: message } };
          }

          const reservation = await store.createQuickActionCard({
            title: action.name,
            description: action.description || `Run script: ${plan.scriptName}`,
            projectDir: plan.cwd,
            originChannel: 'quick_action',
            executionKind: 'script',
            quickActionId: action.id,
            quickActionRequestId: input.clientRequestId,
            scriptRunId: plan.runId,
            scriptName: plan.scriptName,
            parameterSnapshot: resolved.snapshot,
          });
          if (!reservation.created) {
            return scriptQuickActionRunResultFromCard(reservation.card, scriptStore);
          }

          try {
            const accepted = await effectiveScriptExecutionService.startPreparedExecution(
              plan,
              reservation.card.id,
            );
            return {
              statusCode: 202,
              body: {
                cardId: accepted.cardId,
                status: 'in_progress',
                dispatch: null,
                runId: accepted.runId,
                runStatus: accepted.status,
              },
            };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'Script execution failed to start';
            const failedCard = await store.getCard(reservation.card.id);
            return {
              statusCode: dispatchErrorStatus(e),
              body: {
                error: message,
                cardId: reservation.card.id,
                status: failedCard?.status ?? 'complete',
                dispatch: null,
                runId: plan.runId,
                runStatus: 'fail',
                failureSummary: failedCard?.progressSummary ?? `[failed] ${message}`,
              },
            };
          }
        }

        if (!action.projectDir.trim()) {
          return { statusCode: 400, body: { error: 'Quick action projectDir is required' } };
        }
        try {
          if (!existsSync(action.projectDir) || !statSync(action.projectDir).isDirectory()) {
            return {
              statusCode: 400,
              body: { error: `Quick action projectDir is not a valid directory: ${action.projectDir}` },
            };
          }
        } catch {
          return {
            statusCode: 400,
            body: { error: `Quick action projectDir is not a valid directory: ${action.projectDir}` },
          };
        }

        let rendered: ReturnType<typeof renderPromptQuickAction>;
        try {
          rendered = renderPromptQuickAction(action, input.parameterValues);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : 'Quick action parameter validation failed';
          return { statusCode: 400, body: { error: message } };
        }

        const reservation = await store.createQuickActionCard({
          title: rendered.title,
          description: rendered.prompt,
          projectDir: action.projectDir,
          agentRuntime: action.agentRuntime,
          model: action.model,
          agentType: action.agentType,
          command: action.command,
          arguments: rendered.arguments,
          codexOptions: action.codexOptions,
          claudeOptions: action.claudeOptions,
          originChannel: 'quick_action',
          executionKind: 'agent',
          quickActionId: action.id,
          quickActionRequestId: input.clientRequestId,
          parameterSnapshot: rendered.parameterSnapshot,
        });
        if (!reservation.created) return quickActionRunResultFromCard(reservation.card);

        try {
          if (!dispatchFn) {
            throw Object.assign(new Error('Dispatch not available'), { statusCode: 503 });
          }
          const dispatch = await dispatchCardWithScheduledReservation({
            store,
            dispatchFn,
            cardId: reservation.card.id,
            claimScheduled: false,
          });
          const card = await store.finalizeQuickActionRun(reservation.card.id, {
            status: 'accepted',
            dispatch,
          });
          return quickActionRunResultFromCard(card);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          const failureSummary = `[failed] Quick action dispatch failed: ${message}`;
          const card = await store.finalizeQuickActionRun(reservation.card.id, {
            status: 'failed',
            failureSummary,
            errorStatusCode: dispatchErrorStatus(e),
          });
          return quickActionRunResultFromCard(card);
        }
      })().catch((e: unknown): QuickActionRunRouteResult => ({
        statusCode: 500,
        body: { error: e instanceof Error ? e.message : 'Quick action run failed' },
      }));

      activeQuickActionRuns.set(idempotencyKey, runPromise);
      try {
        const result = await runPromise;
        return json(result.body, result.statusCode);
      } finally {
        if (activeQuickActionRuns.get(idempotencyKey) === runPromise) {
          activeQuickActionRuns.delete(idempotencyKey);
        }
      }
    }

    const quickActionMatch = path.match(/^\/api\/quick-actions\/([^/]+)$/);
    if (quickActionMatch) {
      if (!quickActionStore) return errorResponse('Quick actions not available', 503);
      const id = decodeURIComponent(quickActionMatch[1]);

      if (method === 'GET') {
        const action = await quickActionStore.getAction(id);
        if (!action) return errorResponse('Quick action not found', 404);
        return json(action);
      }

      if (method === 'PATCH') {
        try {
          return json(await quickActionStore.updateAction(id, await req.json()));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : 'Invalid request body';
          if (message.includes('Quick action not found')) {
            return errorResponse('Quick action not found', 404);
          }
          return errorResponse(message, quickActionWriteErrorStatus(message));
        }
      }

      if (method === 'DELETE') {
        try {
          await quickActionStore.deleteAction(id);
          return new Response(null, { status: 204 });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : 'Quick action delete failed';
          if (message.includes('Quick action not found')) {
            return errorResponse('Quick action not found', 404);
          }
          return errorResponse(message, 500);
        }
      }
    }

    // Route: POST /api/cards/:id/dispatch
    const scheduleMatch = path.match(/^\/api\/cards\/([^/]+)\/schedule$/);
    if (scheduleMatch && method === 'PUT') {
      const id = scheduleMatch[1];
      try {
        const body = await req.json();
        const scheduledAt = validateScheduledAtKstInput(body?.scheduledAt);
        const card = await store.scheduleCardDispatch(id, scheduledAt);
        return json(card);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Schedule update failed';
        if (message.includes('Card not found')) return errorResponse('Card not found', 404);
        return errorResponse(message, 400);
      }
    }

    if (scheduleMatch && method === 'DELETE') {
      const id = scheduleMatch[1];
      try {
        const card = await store.cancelScheduledDispatch(id);
        return json(card);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Schedule cancel failed';
        if (message.includes('Card not found')) return errorResponse('Card not found', 404);
        return errorResponse(message, 400);
      }
    }

    const dispatchMatch = path.match(/^\/api\/cards\/([^/]+)\/dispatch$/);
    if (dispatchMatch && method === 'POST') {
      const id = dispatchMatch[1];
      if (!dispatchFn) {
        return errorResponse('Dispatch not available', 503);
      }
      try {
        const card = await store.getCard(id);
        if (!card) return errorResponse('Card not found', 404);
        if (card.status !== 'todo') {
          return errorResponse('Can only dispatch cards in todo status', 400);
        }
        const result = await dispatchCardWithScheduledReservation({
          store,
          dispatchFn,
          cardId: id,
        });
        return json(result, 200);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Dispatch failed';
        const statusCode = typeof e === 'object' && e !== null && 'statusCode' in e
          && typeof (e as { statusCode?: unknown }).statusCode === 'number'
          ? (e as { statusCode: number }).statusCode
          : 500;
        return errorResponse(message, statusCode);
      }
    }

    // Route: GET /api/cards/:id/queue
    const queueMatch = path.match(/^\/api\/cards\/([^/]+)\/queue$/);
    if (queueMatch && method === 'GET') {
      const id = queueMatch[1];
      const card = await store.getCard(id);
      if (!card) return errorResponse('Card not found', 404);
      const queuedCards = await store.getQueuedCards(id);
      return json(queuedCards);
    }

    // Route: POST /api/cards/:id/completion-seen
    const completionSeenMatch = path.match(/^\/api\/cards\/([^/]+)\/completion-seen$/);
    if (completionSeenMatch && method === 'POST') {
      const id = completionSeenMatch[1];
      try {
        const card = await store.markCompletionSeen(id);
        return json(card);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('not found')) return errorResponse('Card not found', 404);
        if (message.includes('not complete')) return errorResponse('Card is not complete', 400);
        return errorResponse('Completion seen update failed', 500);
      }
    }

    // Route: POST /api/cards/:id/restore
    const restoreMatch = path.match(/^\/api\/cards\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const id = restoreMatch[1];
      try {
        const card = await store.restoreCard(id);
        // The session has cards again — clear the dangling stamp the delete set.
        await reconcileWorkLinkForCard(store, workStore, card.sessionId);
        return json(card);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('not found')) return errorResponse('Deleted card not found', 404);
        return errorResponse('Restore failed', 500);
      }
    }

    // Route: POST /api/cards/:id/agent-thread
    // Body: the subagent's raw transcript JSONL (text/plain). Parses the
    // inter-agent message thread (sent SendMessages + received/coordinator
    // messages) and stores it on the card. Idempotent — re-parsing a grown
    // transcript replaces the prior thread, so repeat SubagentStop firings are safe.
    const agentThreadMatch = path.match(/^\/api\/cards\/([^/]+)\/agent-thread$/);
    if (agentThreadMatch && method === 'POST') {
      const id = agentThreadMatch[1];
      try {
        const existing = await store.getCard(id);
        if (!existing) return errorResponse('Card not found', 404);
        const transcript = await req.text();
        const agentMessages = extractAgentThread(transcript);
        const card = await store.updateCard(id, { agentMessages });
        return json(card);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('not found')) return errorResponse('Card not found', 404);
        return errorResponse('Agent thread update failed', 500);
      }
    }

    // Route: GET /api/cards/:id/progress
    // Serves the intermediate-step timeline of the card's latest runtime run,
    // parsed on demand from the run's events.jsonl. Works live while the run
    // is appending and after completion. 404 when the card has no claude/codex
    // run (e.g. opencode cards) — the UI treats that as "no progress to show".
    const progressMatch = path.match(/^\/api\/cards\/([^/]+)\/progress$/);
    if (progressMatch && method === 'GET') {
      const id = progressMatch[1];
      const card = await store.getCard(id);
      if (!card) return errorResponse('Card not found', 404);
      try {
        // Primary source: the latest board-dispatched run's events.jsonl.
        if (runtimeRunStore) {
          const runs = await runtimeRunStore.listRuns();
          const cardRuns = runs.filter(run => run.cardId === id);
          if (cardRuns.length > 0) {
            const latest = cardRuns.reduce((a, b) => (a.startedAt > b.startedAt ? a : b));
            if (existsSync(latest.eventsPath)) {
              const text = await Bun.file(latest.eventsPath).text();
              return json(buildRunProgress(latest, text.split('\n')));
            }
          }
        }
        // Fallback: cards owned by an interactive Claude Code session (hook-minted)
        // have no RuntimeRun — read the session transcript instead.
        if (card.agentRuntime === 'claude' && card.sessionId && card.projectDir) {
          const transcriptPath = resolveClaudeTranscriptPath(card.projectDir, card.sessionId);
          if (existsSync(transcriptPath)) {
            const text = await Bun.file(transcriptPath).text();
            return json(buildTranscriptProgress(card, text.split('\n')));
          }
        }
        return errorResponse('No run progress available for card', 404);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to read run progress';
        return errorResponse(message, 500);
      }
    }

    // Match /api/cards/:id
    const cardMatch = path.match(/^\/api\/cards\/([^/]+)$/);
    if (cardMatch) {
      const id = cardMatch[1];

      if (method === 'GET') {
        // `include_archived=true` lets a deep link resolve a card that has
        // already been swept into the monthly archive (a Timeline day cell, the
        // Works Inbox "대화 보기"). Without it those clicks 404'd silently.
        const includeArchived = url.searchParams.get('include_archived') === 'true';
        const card = await store.getCard(id, includeArchived ? { includeArchived } : undefined);
        if (!card) return errorResponse('Card not found', 404);
        return json(card);
      }

      if (method === 'PATCH') {
        try {
          const body = await req.json();
          if (body.agentRuntime !== undefined) {
            if (!AGENT_RUNTIME_VALUES.has(body.agentRuntime)) {
              return errorResponse('Invalid agentRuntime', 400);
            }
            const existing = await store.getCard(id);
            if (!existing) return errorResponse('Card not found', 404);
            const currentRuntime = resolveAgentRuntime(existing);
            if (body.agentRuntime !== currentRuntime && existing.status !== 'todo') {
              return errorResponse('Can only change runtime before dispatch', 400);
            }
          }
          const {
            originChannel: _originChannel,
            executionKind: _executionKind,
            quickActionId: _quickActionId,
            quickActionRequestId: _quickActionRequestId,
            quickActionRun: _quickActionRun,
            scriptRunId: _scriptRunId,
            scriptName: _scriptName,
            parameterSnapshot: _parameterSnapshot,
            ...publicCardUpdates
          } = body;
          const card = await store.updateCard(id, publicCardUpdates);
          return json(card);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : '';
          if (message.includes('not found')) return errorResponse('Card not found', 404);
          return errorResponse('Update failed', 500);
        }
      }

      if (method === 'DELETE') {
        const card = await store.getCard(id);
        if (!card) return errorResponse('Card not found', 404);
        await store.deleteCard(id);
        // Deleting the last card of a linked session leaves a dangling
        // `WorkSessionLink`; the Work is stamped so the detail dialog can say so
        // and `prune-sessions` can clear it.
        await reconcileWorkLinkForCard(store, workStore, card.sessionId);
        return new Response(null, { status: 204 });
      }
    }

    // ─── Scheduler Routes ──────────────────────────────────────────

    // Route: GET /api/schedulers
    if (method === 'GET' && path === '/api/schedulers') {
      if (!schedulerStore) return errorResponse('Scheduler not available', 503);
      const entries = await schedulerStore.getEntries();
      return json(entries);
    }

    // Route: POST /api/schedulers
    if (method === 'POST' && path === '/api/schedulers') {
      if (!schedulerStore || !schedulerEngine) return errorResponse('Scheduler not available', 503);
      try {
        const body = await req.json();
        if (typeof body.name !== 'string' || !body.name.trim() || !body.action) {
          return errorResponse('name and action are required', 400);
        }
        const schedule = resolveSchedulerScheduleInput(readSchedulerScheduleInput(body as Record<string, unknown>));
        const action = validateSchedulerActionInput(body.action);
        const timezone = validateSchedulerTimezoneInput(body.timezone);
        const entry = await schedulerStore.createEntry({
          name: body.name.trim(),
          description: typeof body.description === 'string' ? body.description : '',
          cron: schedule.cron,
          cronDescription: schedule.cronDescription,
          scheduleInput: schedule.scheduleInput,
          timezone,
          action,
        });
        schedulerEngine.scheduleEntry(entry);
        return json(entry, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Invalid request body';
        return errorResponse(message, 400);
      }
    }

    // Route: POST /api/schedulers/:id/toggle
    const toggleMatch = path.match(/^\/api\/schedulers\/([^/]+)\/toggle$/);
    if (toggleMatch && method === 'POST') {
      if (!schedulerStore || !schedulerEngine) return errorResponse('Scheduler not available', 503);
      const id = toggleMatch[1];
      try {
        const entry = await schedulerStore.toggleEntry(id);
        if (entry.status === 'active') {
          schedulerEngine.scheduleEntry(entry);
        } else {
          schedulerEngine.unscheduleEntry(entry.id);
        }
        return json(entry);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('not found')) return errorResponse('Scheduler not found', 404);
        return errorResponse('Toggle failed', 500);
      }
    }

    // Route: POST /api/schedulers/:id/run
    const runMatch = path.match(/^\/api\/schedulers\/([^/]+)\/run$/);
    if (runMatch && method === 'POST') {
      if (!schedulerStore || !schedulerEngine) return errorResponse('Scheduler not available', 503);
      const id = runMatch[1];
      try {
        const run = await schedulerEngine.executeEntry(id);
        return json(run);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('not found')) return errorResponse('Scheduler not found', 404);
        return errorResponse('Run failed', 500);
      }
    }

    // Route: GET /api/schedulers/:id/history
    const historyMatch = path.match(/^\/api\/schedulers\/([^/]+)\/history$/);
    if (historyMatch && method === 'GET') {
      if (!schedulerStore) return errorResponse('Scheduler not available', 503);
      const id = historyMatch[1];
      const entry = await schedulerStore.getEntry(id);
      if (!entry) return errorResponse('Scheduler not found', 404);
      return json(entry.history);
    }

    // Match /api/schedulers/:id
    const schedulerMatch = path.match(/^\/api\/schedulers\/([^/]+)$/);
    if (schedulerMatch) {
      if (!schedulerStore) return errorResponse('Scheduler not available', 503);
      const id = schedulerMatch[1];

      if (method === 'GET') {
        const entry = await schedulerStore.getEntry(id);
        if (!entry) return errorResponse('Scheduler not found', 404);
        return json(entry);
      }

      if (method === 'PATCH') {
        if (!schedulerEngine) return errorResponse('Scheduler not available', 503);
        try {
          const body = await req.json();
          const updates: Record<string, unknown> = {};
          if (body.scheduleInput !== undefined || body.cron !== undefined) {
            const schedule = resolveSchedulerScheduleInput(readSchedulerScheduleInput(body as Record<string, unknown>));
            updates.cron = schedule.cron;
            updates.cronDescription = schedule.cronDescription;
            updates.scheduleInput = schedule.scheduleInput;
          }
          if (body.name !== undefined) {
            if (typeof body.name !== 'string' || !body.name.trim()) {
              return errorResponse('name must be a non-empty string', 400);
            }
            updates.name = body.name.trim();
          }
          if (body.description !== undefined) {
            if (typeof body.description !== 'string') {
              return errorResponse('description must be a string', 400);
            }
            updates.description = body.description;
          }
          if (body.status !== undefined) {
            updates.status = body.status;
          }
          if (body.timezone !== undefined) {
            updates.timezone = validateSchedulerTimezoneInput(body.timezone);
          }
          if (body.action !== undefined) {
            updates.action = validateSchedulerActionInput(body.action);
          }
          const entry = await schedulerStore.updateEntry(id, updates);
          schedulerEngine.scheduleEntry(entry);
          return json(entry);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : '';
          if (message.includes('not found')) return errorResponse('Scheduler not found', 404);
          if (
            message.includes('timezone must be')
            || message.includes('action.type must be')
            || message.includes('bash action requires')
            || message.includes('prompt action')
            || message.includes('name must be')
            || message.includes('description must be')
            || message.includes('scheduleInput')
            || message.includes('Cron 직접 입력')
            || message.includes('지원하지 않는 간편 설정')
            || message.includes('시간은')
            || message.includes('분은')
            || message.includes('간격은')
            || message.includes('요일은')
          ) {
            return errorResponse(message, 400);
          }
          return errorResponse('Update failed', 500);
        }
      }

      if (method === 'DELETE') {
        if (!schedulerEngine) return errorResponse('Scheduler not available', 503);
        const entry = await schedulerStore.getEntry(id);
        if (!entry) return errorResponse('Scheduler not found', 404);
        schedulerEngine.unscheduleEntry(id);
        await schedulerStore.deleteEntry(id);
        return new Response(null, { status: 204 });
      }
    }

    // Route: POST /api/schedulers/parse-cron
    if (method === 'POST' && path === '/api/schedulers/parse-cron') {
      try {
        const body = await req.json();
        const input = typeof body?.input === 'string' ? body.input : '';
        const mode = body?.mode;
        if (!input) return errorResponse('input is required', 400);
        if (mode !== 'cron') {
          return errorResponse('mode must be cron', 400);
        }
        const schedule = resolveSchedulerScheduleInput({ mode: 'cron', expression: input });
        return json({ cron: schedule.cron, description: schedule.preview, valid: true });
      } catch (error: unknown) {
        return json({ valid: false, error: error instanceof Error ? error.message : 'Invalid request body' });
      }
    }

    // ─── Settings Routes ───────────────────────────────────────────

    // Route: GET /api/settings
    if (method === 'GET' && path === '/api/settings') {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      const entries = await settingsStore.getEntries();
      // Redact masked secret values from the list. Plaintext is only served by
      // the explicit single-entry GET below (token-protected).
      return json(entries.map(redactSetting));
    }

    // Route: POST /api/settings
    if (method === 'POST' && path === '/api/settings') {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      try {
        const body = await req.json();
        if (!body.key || !body.description) {
          return errorResponse('key and description are required', 400);
        }
        const entry = await settingsStore.createEntry(body);
        return json(redactSetting(entry), 201);
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    const settingsByKeyMatch = path.match(/^\/api\/settings\/by-key\/(.+)$/);
    if (settingsByKeyMatch && method === 'PUT') {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      try {
        const key = decodeURIComponent(settingsByKeyMatch[1]);
        const body = await req.json();
        if (typeof body.value !== 'string') {
          return errorResponse('value (string) is required', 400);
        }
        const entry = await settingsStore.upsertByKey(key, body.value, {
          description: typeof body.description === 'string' ? body.description : undefined,
          category: typeof body.category === 'string' ? body.category : undefined,
          masked: typeof body.masked === 'boolean' ? body.masked : undefined,
        });

        if (entry.key === 'network_exposed' && onNetworkSettingChange) {
          const hostname = entry.value === 'true' ? '0.0.0.0' : '127.0.0.1';
          onNetworkSettingChange(hostname);
        }

        return json(redactSetting(entry));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Update failed';
        return errorResponse(message, 500);
      }
    }

    // Match /api/settings/:id
    const settingsMatch = path.match(/^\/api\/settings\/([^/]+)$/);
    if (settingsMatch) {
      if (!settingsStore) return errorResponse('Settings not available', 503);
      const id = settingsMatch[1];

      if (method === 'GET') {
        // Explicit single-entry read — returns the plaintext value (e.g. for the
        // UI "reveal" action). Token-protected via requiresLocalAuth above.
        const entry = await settingsStore.getEntry(id);
        if (!entry) return errorResponse('Settings entry not found', 404);
        return json(entry);
      }

      if (method === 'PATCH') {
        try {
          const body = await req.json();
          const entry = await settingsStore.updateEntry(id, body);

          // Trigger server restart when network_exposed setting changes
          if (entry.key === 'network_exposed' && onNetworkSettingChange) {
            const hostname = entry.value === 'true' ? '0.0.0.0' : '127.0.0.1';
            onNetworkSettingChange(hostname);
          }

          return json(redactSetting(entry));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : '';
          if (message.includes('not found')) return errorResponse('Settings entry not found', 404);
          return errorResponse('Update failed', 500);
        }
      }

      if (method === 'DELETE') {
        const entry = await settingsStore.getEntry(id);
        if (!entry) return errorResponse('Settings entry not found', 404);
        await settingsStore.deleteEntry(id);
        return new Response(null, { status: 204 });
      }
    }

    // ─── Skill Routes ─────────────────────────────────────────────

    // Route: GET /api/skills — discovered skills augmenting the command registry
    if (method === 'GET' && path === '/api/skills') {
      if (!skillStore) return errorResponse('Skills not available', 503);
      const skills = await skillStore.getSkills();
      return json(skills);
    }

    // Route: POST /api/skills/sync — rescan disk and re-register dynamic skills
    if (method === 'POST' && path === '/api/skills/sync') {
      if (!skillStore) return errorResponse('Skills not available', 503);
      try {
        const roots = skillRootsStore ? await skillRootsStore.getRoots() : undefined;
        const result = await skillStore.sync(roots);
        // Re-register immediately so dispatch/validation see new skills without a restart.
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Skill sync failed';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/skills — create a new skill directory + SKILL.md
    if (method === 'POST' && path === '/api/skills') {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      try {
        const body = await req.json() as {
          name?: string;
          targetRootId?: string;
          description?: string;
          instructions?: string;
        };
        if (!body.name || !body.targetRootId) {
          return errorResponse('name and targetRootId are required', 400);
        }
        if (!isValidSkillName(body.name)) {
          return errorResponse('name must match [a-z0-9][a-z0-9-]* (no slashes or dots)', 400);
        }
        const roots = await skillRootsStore.getRoots();
        const targetRoot = roots.find((r) => r.id === body.targetRootId && r.enabled);
        if (!targetRoot) return errorResponse('Target root not found or disabled', 404);

        const skillDir = join(targetRoot.dir, body.name);
        const skillMd = join(skillDir, 'SKILL.md');
        if (existsSync(skillMd)) {
          return errorResponse('A skill with this name already exists in the target directory', 409);
        }
        mkdirSync(skillDir, { recursive: true });
        await Bun.write(skillMd, buildSkillMd(body.name, body.description ?? '', body.instructions ?? ''));

        const syncResult = await skillStore.sync(roots);
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(syncResult, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to create skill';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/skills/import — upload a .md file and register it as a new skill
    if (method === 'POST' && path === '/api/skills/import') {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      try {
        const contentType = req.headers.get('content-type') ?? '';
        if (!contentType.includes('multipart/form-data')) {
          return errorResponse('Content-Type must be multipart/form-data', 400);
        }
        const formData = await req.formData();
        const file = formData.get('file');
        const targetRootId = formData.get('targetRootId') as string | null;
        const nameOverride = formData.get('name') as string | null;
        if (!file || !(file instanceof File)) return errorResponse('file field is required', 400);
        if (!targetRootId) return errorResponse('targetRootId is required', 400);

        // Derive a safe name from the uploaded filename or the override field
        const rawName = (nameOverride?.trim() ||
          basename(file.name, extname(file.name))
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')) || 'imported-skill';
        if (!isValidSkillName(rawName)) {
          return errorResponse('Derived name must match [a-z0-9][a-z0-9-]*', 400);
        }

        const roots = await skillRootsStore.getRoots();
        const targetRoot = roots.find((r) => r.id === targetRootId && r.enabled);
        if (!targetRoot) return errorResponse('Target root not found or disabled', 404);

        const skillDir = join(targetRoot.dir, rawName);
        const skillMd = join(skillDir, 'SKILL.md');
        if (existsSync(skillMd)) {
          return errorResponse('A skill with this name already exists in the target directory', 409);
        }
        mkdirSync(skillDir, { recursive: true });
        await Bun.write(skillMd, await file.text());

        const syncResult = await skillStore.sync(roots);
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(syncResult, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to import skill';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/skills/:id/content — read a skill's SKILL.md content
    if (method === 'GET' && path.startsWith('/api/skills/') && path.endsWith('/content')) {
      if (!skillStore) return errorResponse('Skills not available', 503);
      const skillId = decodeURIComponent(path.slice('/api/skills/'.length, -'/content'.length));
      const skills = await skillStore.getSkills();
      const skill = skills.find((s) => s.id === skillId);
      if (!skill) return errorResponse('Skill not found', 404);
      if (!skill.filePath) return errorResponse('Skill has no file path', 404);

      const enabledRoots = skillRootsStore
        ? (await skillRootsStore.getRoots()).filter((r) => r.enabled).map((r) => r.dir)
        : [];

      if (!validateSkillPath(skill.filePath, enabledRoots)) {
        return errorResponse('Skill file is outside configured roots', 403);
      }

      try {
        const content = await Bun.file(skill.filePath).text();
        return json({ id: skillId, filePath: skill.filePath, content });
      } catch {
        return errorResponse('Failed to read skill file', 500);
      }
    }

    // Route: PUT /api/skills/:id/content — overwrite a skill's SKILL.md (path-validated)
    if (method === 'PUT' && path.startsWith('/api/skills/') && path.endsWith('/content')) {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      const skillId = decodeURIComponent(path.slice('/api/skills/'.length, -'/content'.length));
      const skills = await skillStore.getSkills();
      const skill = skills.find((s) => s.id === skillId);
      if (!skill) return errorResponse('Skill not found', 404);
      if (!skill.filePath) return errorResponse('Skill has no file path', 404);

      const enabledRoots = (await skillRootsStore.getRoots())
        .filter((r) => r.enabled)
        .map((r) => r.dir);
      if (!validateSkillPath(skill.filePath, enabledRoots)) {
        return errorResponse('Skill file is outside configured roots', 403);
      }
      try {
        const body = await req.json() as { content?: string };
        if (typeof body.content !== 'string') {
          return errorResponse('content (string) is required', 400);
        }
        await Bun.write(skill.filePath, body.content);
        return json({ id: skillId, filePath: skill.filePath });
      } catch {
        return errorResponse('Failed to write skill file', 500);
      }
    }

    // Route: POST /api/skills/:id/duplicate — copy a skill to another root directory
    const skillDuplicateMatch = path.match(/^\/api\/skills\/([^/]+)\/duplicate$/);
    if (skillDuplicateMatch && method === 'POST') {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      const skillId = decodeURIComponent(skillDuplicateMatch[1]);
      try {
        const skills = await skillStore.getSkills();
        const skill = skills.find((s) => s.id === skillId);
        if (!skill) return errorResponse('Skill not found', 404);
        if (!skill.filePath) return errorResponse('Skill has no file path', 404);

        const enabledRoots = (await skillRootsStore.getRoots())
          .filter((r) => r.enabled)
          .map((r) => r.dir);
        if (!validateSkillPath(skill.filePath, enabledRoots)) {
          return errorResponse('Skill file is outside configured roots', 403);
        }

        const body = await req.json() as { targetRootId?: string };
        if (!body.targetRootId) return errorResponse('targetRootId is required', 400);

        const roots = await skillRootsStore.getRoots();
        const targetRoot = roots.find((r) => r.id === body.targetRootId && r.enabled);
        if (!targetRoot) return errorResponse('Target root not found or disabled', 404);

        const destDir = join(targetRoot.dir, skill.skillName);
        if (existsSync(destDir)) {
          return errorResponse('A skill with this name already exists in the target directory', 409);
        }
        cpSync(skill.directory, destDir, { recursive: true });

        const syncResult = await skillStore.sync(roots);
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(syncResult, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to duplicate skill';
        return errorResponse(message, 500);
      }
    }

    // ─── Skill Roots Routes ───────────────────────────────────────

    // Route: GET /api/skill-roots — list all configured skill root directories
    if (method === 'GET' && path === '/api/skill-roots') {
      if (!skillRootsStore) return errorResponse('Skill roots not available', 503);
      const roots = await skillRootsStore.getRoots();
      return json(roots);
    }

    // Route: POST /api/skill-roots — add a new skill root directory
    if (method === 'POST' && path === '/api/skill-roots') {
      if (!skillRootsStore) return errorResponse('Skill roots not available', 503);
      try {
        const body = await req.json();
        if (!body.dir || !body.agent || !body.source) {
          return errorResponse('dir, agent, and source are required', 400);
        }
        // Reject paths that don't resolve to an existing directory so the user
        // gets immediate feedback instead of silently adding a dead root that
        // scans to zero skills.
        const expandedDir =
          typeof body.dir === 'string' && body.dir.startsWith('~')
            ? join(homedir(), body.dir.slice(1))
            : body.dir;
        if (!existsSync(expandedDir) || !statSync(expandedDir).isDirectory()) {
          return errorResponse(`Directory does not exist: ${body.dir}`, 400);
        }
        const root = await skillRootsStore.addRoot({
          dir: body.dir,
          agent: body.agent,
          source: body.source,
          enabled: body.enabled ?? true,
        });
        return json(root, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to add skill root';
        return errorResponse(message, 400);
      }
    }

    // Route: PUT /api/skill-roots/:id — update (e.g. toggle enabled) a skill root
    if (method === 'PUT' && path.startsWith('/api/skill-roots/')) {
      if (!skillRootsStore) return errorResponse('Skill roots not available', 503);
      const rootId = decodeURIComponent(path.slice('/api/skill-roots/'.length));
      try {
        const body = await req.json();
        const root = await skillRootsStore.updateRoot(rootId, body);
        return json(root);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to update skill root';
        return errorResponse(message, 404);
      }
    }

    // Route: DELETE /api/skill-roots/:id — remove a skill root directory
    if (method === 'DELETE' && path.startsWith('/api/skill-roots/')) {
      if (!skillRootsStore) return errorResponse('Skill roots not available', 503);
      const rootId = decodeURIComponent(path.slice('/api/skill-roots/'.length));
      try {
        await skillRootsStore.removeRoot(rootId);
        // Re-sync skills to evict entries that belonged to this root.
        if (skillStore) {
          const roots = await skillRootsStore.getRoots();
          await skillStore.sync(roots);
          setDynamicSkillCommands(await skillStore.getSkills());
        }
        return new Response(null, { status: 204 });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to remove skill root';
        return errorResponse(message, 404);
      }
    }

    // ─── Script Routes ────────────────────────────────────────────

    // Route: GET /api/scripts
    if (method === 'GET' && path === '/api/scripts') {
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      const entries = await scriptStore.getEntries();
      return json(entries);
    }

    // Route: POST /api/scripts
    if (method === 'POST' && path === '/api/scripts') {
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      try {
        const body = await req.json();
        if (!body.name || !body.content) {
          return errorResponse('name and content are required', 400);
        }
        const entry = await scriptStore.createEntry({
          name: body.name,
          description: body.description ?? '',
          content: body.content,
          language: body.language,
          projectDir: body.projectDir,
        });
        return json(entry, 201);
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    // Route: POST /api/scripts/sync
    if (method === 'POST' && path === '/api/scripts/sync') {
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      const scriptsDir = scriptStore.scriptsDir;
      if (!scriptsDir) return errorResponse('Scripts directory not configured', 500);
      try {
        const result = await scriptStore.syncFromDirectory(scriptsDir);
        return json(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Sync failed';
        return errorResponse(message, 500);
      }
    }

    // Route: POST /api/scripts/:id/run
    const scriptRunMatch = path.match(/^\/api\/scripts\/([^/]+)\/run$/);
    if (scriptRunMatch && method === 'POST') {
      if (!scriptStore || !effectiveScriptExecutionService) {
        return errorResponse('Script execution not available', 503);
      }
      if ((await req.text()).trim().length > 0) {
        return errorResponse('Script run requests do not accept command or interpreter overrides', 400);
      }
      const id = scriptRunMatch[1];
      try {
        const entry = await scriptStore.getEntry(id);
        if (!entry) return errorResponse('Script not found', 404);
        const plan = await effectiveScriptExecutionService.prepareExecution({ scriptId: id });
        const card = await store.createCard({
          title: entry.name,
          description: entry.description || `Run script: ${entry.name}`,
          projectDir: plan.cwd,
          executionKind: 'script',
          scriptRunId: plan.runId,
          scriptName: plan.scriptName,
        });
        const accepted = await effectiveScriptExecutionService.startPreparedExecution(plan, card.id);
        return json(accepted, 202);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Run failed';
        return errorResponse(message, dispatchErrorStatus(e));
      }
    }

    // Route: GET /api/scripts/:id/history
    const scriptHistoryMatch = path.match(/^\/api\/scripts\/([^/]+)\/history$/);
    if (scriptHistoryMatch && method === 'GET') {
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      const id = scriptHistoryMatch[1];
      const entry = await scriptStore.getEntry(id);
      if (!entry) return errorResponse('Script not found', 404);
      return json(entry.history);
    }

    // Match /api/scripts/:id
    const scriptMatch = path.match(/^\/api\/scripts\/([^/]+)$/);
    if (scriptMatch) {
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      const id = scriptMatch[1];

      if (method === 'GET') {
        const entry = await scriptStore.getEntry(id);
        if (!entry) return errorResponse('Script not found', 404);
        return json(entry);
      }

      if (method === 'PATCH') {
        try {
          const body = await req.json();
          const entry = await scriptStore.updateEntry(id, body);
          return json(entry);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : '';
          if (message.includes('not found')) return errorResponse('Script not found', 404);
          return errorResponse('Update failed', 500);
        }
      }

      if (method === 'DELETE') {
        const entry = await scriptStore.getEntry(id);
        if (!entry) return errorResponse('Script not found', 404);
        if (quickActionStore && await quickActionStore.hasScriptReference(id)) {
          return errorResponse('Script is referenced by a quick action', 409);
        }
        try {
          await scriptStore.deleteEntry(id);
          return new Response(null, { status: 204 });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : 'Delete failed';
          if (message.includes('Script entry is running')) {
            return errorResponse(message, 409);
          }
          return errorResponse(message, 500);
        }
      }
    }

    // ─── Screenshot Routes ──────────────────────────────────────────

    // Route: POST /api/cards/:id/screenshots (multipart upload)
    const screenshotUploadMatch = path.match(/^\/api\/cards\/([^/]+)\/screenshots$/);
    if (screenshotUploadMatch && method === 'POST') {
      const cardId = screenshotUploadMatch[1];
      try {
        const card = await store.getCard(cardId);
        if (!card) return errorResponse('Card not found', 404);

        const contentType = req.headers.get('content-type') ?? '';
        if (!contentType.includes('multipart/form-data')) {
          return errorResponse('Content-Type must be multipart/form-data', 400);
        }

        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
          return errorResponse('file field is required', 400);
        }

        const arrayBuffer = await file.arrayBuffer();
        const screenshot = await store.saveScreenshot(
          cardId,
          arrayBuffer,
          file.name,
          file.type || 'image/png',
        );
        return json(screenshot, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Upload failed';
        if (message.includes('not found')) return errorResponse(message, 404);
        return errorResponse(message, 500);
      }
    }

    // Route: DELETE /api/cards/:id/screenshots/:screenshotId
    const screenshotDeleteMatch = path.match(/^\/api\/cards\/([^/]+)\/screenshots\/([^/]+)$/);
    if (screenshotDeleteMatch && method === 'DELETE') {
      const cardId = screenshotDeleteMatch[1];
      const screenshotId = screenshotDeleteMatch[2];
      try {
        await store.deleteScreenshot(cardId, screenshotId);
        return new Response(null, { status: 204 });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Delete failed';
        if (message.includes('not found')) return errorResponse(message, 404);
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/screenshots/:filename (serve screenshot file)
    const screenshotServeMatch = path.match(/^\/api\/screenshots\/([^/]+)$/);
    if (screenshotServeMatch && method === 'GET') {
      const filename = decodeURIComponent(screenshotServeMatch[1]);
      const filePath = store.getScreenshotPath(filename);
      if (!existsSync(filePath)) {
        return errorResponse('Screenshot not found', 404);
      }
      const ext = extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const content = await Bun.file(filePath).arrayBuffer();
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    }

    // ─── Models Route ────────────────────────────────────────────

    // Route: GET /api/models
    if (method === 'GET' && path === '/api/models') {
      if (!modelsFn) return errorResponse('Models not available', 503);
      try {
        const models = await modelsFn();
        return json(models);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to fetch models';
        return errorResponse(message, 500);
      }
    }

    // ─── Question Routes ──────────────────────────────────────────

    // Route: GET /api/questions
    if (method === 'GET' && path === '/api/questions') {
      if (!questionMonitor) return json([]);
      return json(questionMonitor.getQuestions());
    }

    // Route: POST /api/questions/mock — inject a fake question for UI testing (DEV ONLY)
    if (method === 'POST' && path === '/api/questions/mock') {
      if (!questionMonitor) return errorResponse('Question monitor not available', 503);
      try {
        const body = await req.json() as { sessionID: string };
        if (!body.sessionID) return errorResponse('sessionID required', 400);
        const fakeQuestion: QuestionRequest = {
          id: `mock-${Date.now()}`,
          sessionID: body.sessionID,
          questions: [{
            question: '어떤 프로그래밍 언어로 작업할까요?',
            header: '언어 선택',
            options: [
              { label: 'Python', description: '범용 스크립트 언어' },
              { label: 'TypeScript', description: '타입 안전한 JS' },
              { label: 'Go', description: '시스템 프로그래밍' },
            ],
          }],
        };
        questionMonitor.addMockQuestion(fakeQuestion);
        return json(fakeQuestion, 201);
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    // Route: DELETE /api/questions/mock — clear all mock questions (DEV ONLY)
    if (method === 'DELETE' && path === '/api/questions/mock') {
      if (!questionMonitor) return errorResponse('Question monitor not available', 503);
      const questions = questionMonitor.getQuestions();
      const mockIds = questions.filter(q => q.id.startsWith('mock-')).map(q => q.id);
      for (const id of mockIds) {
        questionMonitor.removeQuestion(id);
      }
      return json({ deleted: mockIds.length, ids: mockIds });
    }


    // Route: POST /api/questions/:id/reply  — body: { answers: string[][] }
    const questionReplyMatch = path.match(/^\/api\/questions\/([^/]+)\/reply$/);
    if (questionReplyMatch && method === 'POST') {
      if (!questionMonitor) return errorResponse('Question monitor not available', 503);
      const id = questionReplyMatch[1];
      try {
        const body = await req.json() as { answers: string[][] };
        if (!Array.isArray(body.answers)) return errorResponse('answers array required', 400);

        // Capture question BEFORE reply (reply removes it from the map)
        const question = questionMonitor.getQuestions().find(q => q.id === id);

        // Mock questions: remove directly from map (no opencode proxy)
        const isMock = id.startsWith('mock-');
        const ok = isMock
          ? questionMonitor.removeQuestion(id)
          : await questionMonitor.reply(id, body.answers);

        // Record Q&A history to card's progressSummary
        if (ok && question) {
          const card = await store.findCardBySessionId(question.sessionID);
          if (card) {
            const entry = formatQuestionHistory(question, body.answers);
            const summary = card.progressSummary
              ? `${card.progressSummary}\n\n${entry}`
              : entry;
            await store.updateCard(card.id, { progressSummary: summary });
          }
        }

        return json({ ok });
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    // Route: POST /api/questions/:id/reject
    const questionRejectMatch = path.match(/^\/api\/questions\/([^/]+)\/reject$/);
    if (questionRejectMatch && method === 'POST') {
      if (!questionMonitor) return errorResponse('Question monitor not available', 503);
      const id = questionRejectMatch[1];

      // Capture question BEFORE reject (reject removes it from the map)
      const question = questionMonitor.getQuestions().find(q => q.id === id);

      // Mock questions: remove directly from map (no opencode proxy)
      const isMock = id.startsWith('mock-');
      const ok = isMock
        ? questionMonitor.removeQuestion(id)
        : await questionMonitor.reject(id);

      // Record rejection history to card's progressSummary
      if (ok && question) {
        const card = await store.findCardBySessionId(question.sessionID);
        if (card) {
          const entry = formatQuestionHistory(question, null);
          const summary = card.progressSummary
            ? `${card.progressSummary}\n\n${entry}`
            : entry;
          await store.updateCard(card.id, { progressSummary: summary });
        }
      }

      return json({ ok });
    }

    // ─── Scope Routes ────────────────────────────────────────────

    // Route: GET /api/scope/targets
    if (method === 'GET' && path === '/api/scope/targets') {
      if (!placementTargetsStore) return errorResponse('Placement targets not available', 503);
      const targets = await placementTargetsStore.getTargets();
      return json(targets);
    }

    // Route: POST /api/scope/targets
    if (method === 'POST' && path === '/api/scope/targets') {
      if (!placementTargetsStore) return errorResponse('Placement targets not available', 503);
      try {
        const body = await req.json() as {
          label?: string;
          dir?: string;
          kind?: string;
          teamShared?: boolean;
          runtime?: McpRuntime;
        };
        if (!body.label || !body.dir || !body.kind) {
          return errorResponse('label, dir, and kind are required', 400);
        }
        if (body.runtime !== undefined && body.runtime !== 'claude' && body.runtime !== 'codex') {
          return errorResponse('runtime must be claude or codex', 400);
        }
        const expandedDir =
          typeof body.dir === 'string' && body.dir.startsWith('~')
            ? join(homedir(), body.dir.slice(1))
            : body.dir;
        if (!existsSync(expandedDir) || !statSync(expandedDir).isDirectory()) {
          return errorResponse(`Directory does not exist: ${body.dir}`, 400);
        }
        const target = await placementTargetsStore.addTarget({
          label: body.label,
          dir: body.dir,
          kind: body.kind as import('../core/types').CapScope,
          teamShared: body.teamShared ?? false,
          runtime: body.runtime ?? 'claude',
        });
        return json(target, 201);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to add placement target';
        return errorResponse(message, 400);
      }
    }

    // Route: DELETE /api/scope/targets/:id
    const scopeTargetDeleteMatch = path.match(/^\/api\/scope\/targets\/([^/]+)$/);
    if (scopeTargetDeleteMatch && method === 'DELETE') {
      if (!placementTargetsStore) return errorResponse('Placement targets not available', 503);
      const targetId = decodeURIComponent(scopeTargetDeleteMatch[1]);
      try {
        await placementTargetsStore.removeTarget(targetId);
        return new Response(null, { status: 204 });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to remove placement target';
        if (message.includes('builtin')) return errorResponse(message, 400);
        if (message.includes('not found')) return errorResponse(message, 404);
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/scope/inventory
    if (method === 'GET' && path === '/api/scope/inventory') {
      const skills = skillStore ? await skillStore.getSkills() : [];

      const { diagnostics, skillOverrides } = await readCcDiagnostics();

      // Collect project dirs from placement targets so .mcp.json files are scanned
      const placementTargets = placementTargetsStore
        ? await placementTargetsStore.getTargets()
        : [];
      const mcpDiscovery = await (scopeMcpInventoryFn ?? readAllMcpInventoryWithDiagnostics)(
        placementTargets,
      );
      const mcp = mcpDiscovery.items;

      // Annotate each skill with computed visibility
      const skillsWithVisibility = skills.map((skill) => ({
        ...skill,
        ...computeSkillVisibility(
          skill.skillName,
          skill.disableModelInvocation ?? false,
          skillOverrides,
        ),
      }));

      // Fill in diagnostics aggregate counts
      diagnostics.userScopeMcpCount = mcp.filter((item) => item.runtime === 'claude' &&
        item.placements.some((p) => p.scope === 'user'),
      ).length;
      diagnostics.alwaysLoadCount = mcp.filter((item) => item.runtime === 'claude' &&
        item.placements.some((p) => p.alwaysLoad),
      ).length;
      diagnostics.mcpDiscovery = mcpDiscovery.diagnostics;

      return json({ mcp, skills: skillsWithVisibility, diagnostics });
    }

    // Route: PATCH /api/scope/skill/:id/visibility
    const skillVisibilityMatch = path.match(/^\/api\/scope\/skill\/([^/]+)\/visibility$/);
    if (skillVisibilityMatch && method === 'PATCH') {
      const skillId = decodeURIComponent(skillVisibilityMatch[1]);
      const isPreview = url.searchParams.get('preview') === '1';

      const skills = skillStore ? await skillStore.getSkills() : [];
      const skill = skills.find((s) => s.id === skillId);
      if (!skill) return errorResponse(`Skill "${skillId}" not found`, 404);

      const body = await req.json() as {
        scope?: 'user' | 'project' | 'local';
        projectDir?: string;
        override?: 'on' | 'name-only' | 'user-invocable-only' | 'off' | null;
        disableModelInvocation?: boolean;
      };

      const changes: Array<{ filePath: string; isProjectFile: boolean; before: string; after: string }> = [];

      // ── skillOverrides change ──────────────────────────────────
      if ('override' in body) {
        const scope = body.scope ?? 'user';
        let settingsPath: string;
        if (scope === 'user') {
          settingsPath = USER_SETTINGS_PATH;
        } else if (body.projectDir) {
          settingsPath = join(
            body.projectDir,
            '.claude',
            scope === 'local' ? 'settings.local.json' : 'settings.json',
          );
        } else {
          return errorResponse('projectDir required for project/local scope', 400);
        }

        const { oldContent, newContent } = previewSkillOverride(settingsPath, skill.skillName, body.override ?? null);
        changes.push({ filePath: settingsPath, isProjectFile: scope === 'project', before: oldContent, after: newContent });

        if (!isPreview) {
          await setSkillOverride(settingsPath, skill.skillName, body.override ?? null);
        }
      }

      // ── disable-model-invocation change ───────────────────────
      if ('disableModelInvocation' in body && body.disableModelInvocation !== undefined) {
        if (!skill.filePath) {
          return errorResponse('Skill has no SKILL.md file path — cannot modify frontmatter', 400);
        }
        const value = body.disableModelInvocation;
        const rawContent = existsSync(skill.filePath)
          ? readFileSync(skill.filePath, 'utf8')
          : '';
        const newContent = applyDisableModelInvocation(rawContent, value);
        // Determine if SKILL.md is in a project directory (not under user home ~/.claude)
        const isProjectFile = !skill.filePath.startsWith(homedir() + '/.claude/');
        changes.push({ filePath: skill.filePath, isProjectFile, before: rawContent, after: newContent });

        if (!isPreview) {
          setDisableModelInvocation(skill.filePath, value);
          // Re-scan skills so next inventory fetch reflects the frontmatter change
          if (skillStore) {
            await skillStore.sync();
            setDynamicSkillCommands(await skillStore.getSkills());
          }
        }
      }

      if (isPreview) {
        return json({ preview: true, changes });
      }

      return json({ ok: true, changes: changes.length });
    }

    // Route: PATCH /api/scope/mcp/:name/always-load
    const mcpAlwaysLoadMatch = path.match(/^\/api\/scope\/mcp\/([^/]+)\/always-load$/);
    if (mcpAlwaysLoadMatch && method === 'PATCH') {
      const mcpName = decodeURIComponent(mcpAlwaysLoadMatch[1]);
      const isPreview = url.searchParams.get('preview') === '1';

      const body = await req.json() as {
        location?: string;
        scope?: 'user' | 'project';
        alwaysLoad?: boolean;
        runtime?: McpRuntime;
        inventoryIdentity?: string;
        placementIdentity?: string;
      };

      if (typeof body.location !== 'string' || !body.location) {
        return errorResponse('location (file path) is required', 400);
      }
      if (typeof body.alwaysLoad !== 'boolean') {
        return errorResponse('alwaysLoad (boolean) is required', 400);
      }
      const runtime = body.runtime ?? 'claude';
      if (!getMcpRuntimeAdapter(runtime).capabilities.alwaysLoad) {
        return errorResponse('alwaysLoad is only supported by the Claude MCP runtime', 400);
      }

      if (body.inventoryIdentity || body.placementIdentity) {
        const targets = placementTargetsStore ? await placementTargetsStore.getTargets() : [];
        const inventory = scopeMcpInventoryFn
          ? (await scopeMcpInventoryFn(targets)).items
          : await getMcpRuntimeAdapter(runtime).readInventory(targets);
        const item = inventory.find((candidate) => candidate.runtime === runtime && candidate.name === mcpName &&
          (!body.inventoryIdentity || candidate.identity === body.inventoryIdentity));
        const placement = item?.placements.find((candidate) =>
          (!body.placementIdentity || candidate.identity === body.placementIdentity) && candidate.location === body.location);
        if (!placement) return errorResponse('MCP placement identity does not match location', 404);
      }

      const scope = body.scope ?? 'user';
      const isProjectFile = scope === 'project';

      try {
        const oldContent = existsSync(body.location)
          ? readFileSync(body.location, 'utf8')
          : '{}';
        const newContent = applyAlwaysLoad(oldContent, mcpName, body.alwaysLoad);

        if (isPreview) {
          return json({
            preview: true,
            changes: [{ filePath: body.location, isProjectFile, before: oldContent, after: newContent }],
          });
        }

        await setAlwaysLoad(body.location, mcpName, body.alwaysLoad);
        return json({ ok: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to update alwaysLoad';
        return errorResponse(message, 400);
      }
    }

    // ─── MCP Write Routes (Phase 3) ──────────────────────────────

    const resolveMcpMutationSource = async (
      runtime: McpRuntime,
      name: string,
      inventoryIdentity?: string,
      placementIdentity?: string,
    ): Promise<{ def: import('../core/types').McpServerDef; placement?: McpPlacement } | null> => {
      const targets = placementTargetsStore ? await placementTargetsStore.getTargets() : [];
      const inventory = scopeMcpInventoryFn
        ? (await scopeMcpInventoryFn(targets)).items
        : await getMcpRuntimeAdapter(runtime).readInventory(targets);
      const item = inventory.find((candidate) =>
        candidate.runtime === runtime && candidate.name === name &&
        (!inventoryIdentity || candidate.identity === inventoryIdentity));
      if (!item) return null;
      const placement = placementIdentity
        ? item.placements.find((candidate) => candidate.identity === placementIdentity)
        : undefined;
      if (placementIdentity && !placement) return null;
      return { def: placement?.definition ?? item.def, placement };
    };

    const resolveMcpDestination = async (body: {
      runtime?: McpRuntime;
      targetId?: string;
      toScope?: string;
      targetDir?: string;
      projectDir?: string;
    }): Promise<{ scope: 'user' | 'local' | 'project'; targetDir?: string; projectDir?: string; teamShared: boolean } | null> => {
      const runtime = body.runtime ?? 'claude';
      if (body.targetId) {
        if (!placementTargetsStore) return null;
        const target = (await placementTargetsStore.getTargets()).find((candidate) => candidate.id === body.targetId);
        if (!target || target.runtime !== runtime || target.kind === 'cold') return null;
        return {
          scope: target.kind === 'user' ? 'user' : target.kind,
          targetDir: target.kind === 'local' ? target.dir : undefined,
          projectDir: target.kind === 'project' ? target.dir : undefined,
          teamShared: target.teamShared,
        };
      }
      if (!body.toScope || !['user', 'local', 'project'].includes(body.toScope)) return null;
      return {
        scope: body.toScope as 'user' | 'local' | 'project',
        targetDir: body.targetDir,
        projectDir: body.projectDir,
        teamShared: body.toScope === 'project',
      };
    };

    // Route: POST /api/scope/mcp/:name/copy
    const mcpCopyMatch = path.match(/^\/api\/scope\/mcp\/([^/]+)\/copy$/);
    if (mcpCopyMatch && method === 'POST') {
      const mcpName = decodeURIComponent(mcpCopyMatch[1]);
      const body = await req.json() as {
        toScope?: string;
        targetDir?: string;
        projectDir?: string;
        forceSecret?: boolean;
        runtime?: McpRuntime;
        inventoryIdentity?: string;
        sourcePlacementIdentity?: string;
        targetId?: string;
      };
      const isPreview = url.searchParams.get('preview') === '1';
      const runtime = body.runtime ?? 'claude';
      if (runtime !== 'claude' && runtime !== 'codex') {
        return errorResponse('runtime must be claude or codex', 400);
      }

      const source = await resolveMcpMutationSource(runtime, mcpName, body.inventoryIdentity, body.sourcePlacementIdentity);
      if (!source) return errorResponse(`MCP server "${mcpName}" placement not found in inventory`, 404);
      const destination = await resolveMcpDestination(body);
      if (!destination) return errorResponse('A matching runtime destination target or toScope is required', 400);
      const toScope = destination.scope;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(resolveKanbanDataDir(), 'cold-storage', 'backups');

      try {
        const opts = {
          ts,
          backupDir,
          targetDir: destination.targetDir,
          projectDir: destination.projectDir,
        };

        if (destination.teamShared && !body.forceSecret && detectPlaintextSecret(source.def)) {
          return json({ secretWarning: true, message: 'This MCP server definition contains a potential plaintext secret. Confirm forceSecret:true to continue.' }, 409);
        }
        if (isPreview) {
          const changes = runtime === 'claude'
            ? previewCopyMcp(mcpName, source.def, toScope, opts)
            : previewCopyCodexMcp(mcpName, source.def, toScope, opts);
          return json({ preview: true, changes });
        }
        const result = runtime === 'claude'
          ? await copyMcp(mcpName, source.def, toScope, opts, body.forceSecret ?? false)
          : await copyCodexMcp(mcpName, source.def, toScope, opts, body.forceSecret ?? false);

        if (result.secretWarning) {
          return json({
            secretWarning: true,
            message:
              'This MCP server definition contains a potential plaintext secret. ' +
              'Copying to a git-shared (project) scope may expose it. ' +
              'Refactor to use env references, then retry with forceSecret:true.',
          }, 409);
        }

        return json({ ok: true, before: result.before, after: result.after });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'copy failed';
        const code =
          (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
        return errorResponse(msg, code);
      }
    }

    // Route: POST /api/scope/mcp/:name/move
    const mcpMoveMatch = path.match(/^\/api\/scope\/mcp\/([^/]+)\/move$/);
    if (mcpMoveMatch && method === 'POST') {
      const mcpName = decodeURIComponent(mcpMoveMatch[1]);
      const body = await req.json() as {
        fromScope?: string;
        fromDir?: string;
        toScope?: string;
        targetDir?: string;
        projectDir?: string;
        forceSecret?: boolean;
        runtime?: McpRuntime;
        inventoryIdentity?: string;
        sourcePlacementIdentity?: string;
        targetId?: string;
      };
      if (!body.fromScope && !body.sourcePlacementIdentity) {
        return errorResponse('fromScope or sourcePlacementIdentity is required', 400);
      }
      if (body.fromScope && !['user', 'local', 'project'].includes(body.fromScope)) {
        return errorResponse('fromScope must be user, local, or project', 400);
      }
      if (!body.targetId && (!body.toScope || !['user', 'local', 'project'].includes(body.toScope))) {
        return errorResponse('toScope must be user, local, or project', 400);
      }
      const runtime = body.runtime ?? 'claude';
      const isPreview = url.searchParams.get('preview') === '1';
      if (runtime !== 'claude' && runtime !== 'codex') {
        return errorResponse('runtime must be claude or codex', 400);
      }

      const source = await resolveMcpMutationSource(runtime, mcpName, body.inventoryIdentity, body.sourcePlacementIdentity);
      if (!source) return errorResponse(`MCP server "${mcpName}" placement not found in inventory`, 404);
      const destination = await resolveMcpDestination(body);
      if (!destination) return errorResponse('A matching runtime destination target or toScope is required', 400);

      const fromScope = source.placement?.scope && source.placement.scope !== 'cold'
        ? source.placement.scope : body.fromScope as 'user' | 'local' | 'project';
      const fromDir = source.placement?.dir ?? body.fromDir;
      const toScope = destination.scope;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(resolveKanbanDataDir(), 'cold-storage', 'backups');

      try {
        const opts = { ts, backupDir, targetDir: destination.targetDir, projectDir: destination.projectDir };
        if (destination.teamShared && !body.forceSecret && detectPlaintextSecret(source.def)) {
          return json({ secretWarning: true, message: 'This MCP server definition contains a potential plaintext secret. Confirm forceSecret:true to continue.' }, 409);
        }
        if (isPreview) {
          const changes = runtime === 'claude'
            ? previewMoveMcp(mcpName, source.def, fromScope, fromDir, toScope, opts)
            : previewMoveCodexMcp(mcpName, source.def, fromScope, fromDir, toScope, opts);
          return json({ preview: true, changes });
        }
        const result = runtime === 'claude'
          ? await moveMcp(mcpName, source.def, fromScope, fromDir, toScope, opts, body.forceSecret ?? false)
          : await moveCodexMcp(mcpName, source.def, fromScope, fromDir, toScope, opts, body.forceSecret ?? false);

        if (result.secretWarning) {
          return json({
            secretWarning: true,
            message:
              'This MCP server definition contains a potential plaintext secret. ' +
              'Moving to a git-shared (project) scope may expose it. ' +
              'Refactor to use env references, then retry with forceSecret:true.',
          }, 409);
        }

        return json({ ok: true, before: result.before, after: result.after });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'move failed';
        const code =
          (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
        return errorResponse(msg, code);
      }
    }

    // Route: DELETE /api/scope/mcp/:name
    const mcpDeleteMatch = path.match(/^\/api\/scope\/mcp\/([^/]+)$/);
    if (mcpDeleteMatch && method === 'DELETE') {
      const mcpName = decodeURIComponent(mcpDeleteMatch[1]);
      const body = await req.json() as {
        scope?: string;
        targetDir?: string;
        projectDir?: string;
        runtime?: McpRuntime;
        inventoryIdentity?: string;
        placementIdentity?: string;
      };
      if (!body.scope && !body.placementIdentity) return errorResponse('scope or placementIdentity is required', 400);
      if (body.scope && !['user', 'local', 'project'].includes(body.scope)) {
        return errorResponse('scope must be user, local, or project', 400);
      }
      const runtime = body.runtime ?? 'claude';
      const isPreview = url.searchParams.get('preview') === '1';
      if (runtime !== 'claude' && runtime !== 'codex') {
        return errorResponse('runtime must be claude or codex', 400);
      }

      const source = await resolveMcpMutationSource(runtime, mcpName, body.inventoryIdentity, body.placementIdentity);
      if (!source) return errorResponse(`MCP server "${mcpName}" placement not found in inventory`, 404);
      const scope = source.placement?.scope && source.placement.scope !== 'cold'
        ? source.placement.scope : body.scope as 'user' | 'local' | 'project';
      const sourceDir = source.placement?.dir;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(resolveKanbanDataDir(), 'cold-storage', 'backups');

      try {
        const opts = {
          ts,
          backupDir,
          targetDir: scope === 'local' ? sourceDir ?? body.targetDir : body.targetDir,
          projectDir: scope === 'project' ? sourceDir ?? body.projectDir : body.projectDir,
        };
        if (isPreview) {
          const changes = runtime === 'claude'
            ? previewRemoveMcp(mcpName, scope, opts)
            : previewRemoveCodexMcp(mcpName, scope, opts);
          return json({ preview: true, changes });
        }
        const result = runtime === 'claude'
          ? await removeMcp(mcpName, scope, opts)
          : await removeCodexMcp(mcpName, scope, opts);
        return json({ ok: true, before: result.before, after: result.after });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'remove failed';
        const code =
          (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
        return errorResponse(msg, code);
      }
    }

    // ─── Skill Move / Remove Routes (Phase 4) ────────────────────

    // Route: POST /api/scope/skill/:id/move — move skill folder to another root, or to a
    // placement target's runtime-appropriate skills subdir (e.g. <target.dir>/.claude/skills).
    const skillMoveMatch = path.match(/^\/api\/scope\/skill\/([^/]+)\/move$/);
    if (skillMoveMatch && method === 'POST') {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      const skillId = decodeURIComponent(skillMoveMatch[1]);
      try {
        const skills = await skillStore.getSkills();
        const skill = skills.find((s) => s.id === skillId);
        if (!skill) return errorResponse('Skill not found', 404);
        if (!skill.filePath) return errorResponse('Skill has no file path', 404);

        const roots = await skillRootsStore.getRoots();
        const enabledRoots = roots.filter((r) => r.enabled).map((r) => r.dir);
        if (!validateSkillPath(skill.filePath, enabledRoots)) {
          return errorResponse('Skill file is outside configured roots', 403);
        }

        const body = await req.json() as { targetRootId?: string; placementTargetId?: string };

        let destRootDir: string;
        let syncRoots = roots;

        if (body.placementTargetId) {
          if (!placementTargetsStore) return errorResponse('Placement targets not available', 503);
          const targets = await placementTargetsStore.getTargets();
          const target = targets.find((t) => t.id === body.placementTargetId);
          if (!target) return errorResponse('Placement target not found', 404);
          if (target.kind === 'cold') {
            return errorResponse('Use Freeze to move a skill to Cold Storage', 400);
          }

          destRootDir = target.kind === 'user'
            ? target.dir
            : join(target.dir, ...SKILL_RUNTIME_SUBDIR[skill.runtime]);
          mkdirSync(destRootDir, { recursive: true });

          // Auto-register the destination as a tracked skill root so the moved
          // skill keeps showing up after the move (it's outside the source roots).
          const existingRoot = roots.find((r) => r.dir === destRootDir);
          if (!existingRoot) {
            await skillRootsStore.addRoot({
              dir: destRootDir,
              agent: skill.runtime,
              source: `placement:${target.id}`,
              enabled: true,
            });
          } else if (!existingRoot.enabled) {
            await skillRootsStore.updateRoot(existingRoot.id, { enabled: true });
          }
          syncRoots = await skillRootsStore.getRoots();
        } else if (body.targetRootId) {
          const targetRoot = roots.find((r) => r.id === body.targetRootId && r.enabled);
          if (!targetRoot) return errorResponse('Target root not found or disabled', 404);
          destRootDir = targetRoot.dir;
        } else {
          return errorResponse('targetRootId or placementTargetId is required', 400);
        }

        const destDir = join(destRootDir, skill.skillName);
        if (existsSync(destDir)) {
          return errorResponse('A skill with this name already exists in the target directory', 409);
        }

        cpSync(skill.directory, destDir, { recursive: true });
        rmSync(skill.directory, { recursive: true, force: true });

        const syncResult = await skillStore.sync(syncRoots);
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(syncResult);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to move skill';
        return errorResponse(message, 500);
      }
    }

    // Route: DELETE /api/scope/skill/:id — permanently remove a skill from disk
    const skillScopeDeleteMatch = path.match(/^\/api\/scope\/skill\/([^/]+)$/);
    if (skillScopeDeleteMatch && method === 'DELETE') {
      if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);
      const skillId = decodeURIComponent(skillScopeDeleteMatch[1]);
      try {
        const skills = await skillStore.getSkills();
        const skill = skills.find((s) => s.id === skillId);
        if (!skill) return errorResponse('Skill not found', 404);
        if (!skill.filePath) return errorResponse('Skill has no file path', 404);

        const roots = await skillRootsStore.getRoots();
        const enabledRoots = roots.filter((r) => r.enabled).map((r) => r.dir);
        if (!validateSkillPath(skill.filePath, enabledRoots)) {
          return errorResponse('Skill file is outside configured roots', 403);
        }

        rmSync(skill.directory, { recursive: true, force: true });

        const syncResult = await skillStore.sync(roots);
        setDynamicSkillCommands(await skillStore.getSkills());
        return json(syncResult);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to remove skill';
        return errorResponse(message, 500);
      }
    }

    // ─── Cold Storage Routes (Phase 4) ───────────────────────────

    // Route: GET /api/scope/cold — list cold storage manifest (with summaries)
    if (method === 'GET' && path === '/api/scope/cold') {
      return json(getColdManifestView());
    }

    // Route: POST /api/scope/cold/freeze — freeze a skill or MCP to cold storage
    if (method === 'POST' && path === '/api/scope/cold/freeze') {
      const isPreview = url.searchParams.get('preview') === '1';
      const body = await req.json() as {
        kind?: 'skill' | 'mcp';
        skillId?: string;
        mcpName?: string;
        scope?: string;
        fromDir?: string;
        runtime?: McpRuntime;
        inventoryIdentity?: string;
        placementIdentity?: string;
      };

      if (!body.kind) return errorResponse('kind is required', 400);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');

      if (body.kind === 'skill') {
        if (!body.skillId) return errorResponse('skillId is required', 400);
        if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);

        const skills = await skillStore.getSkills();
        const skill = skills.find((s) => s.id === body.skillId);
        if (!skill) return errorResponse('Skill not found', 404);

        const roots = await skillRootsStore.getRoots();
        const enabledRoots = roots.filter((r) => r.enabled).map((r) => r.dir);
        if (skill.filePath && !validateSkillPath(skill.filePath, enabledRoots)) {
          return errorResponse('Skill file is outside configured roots', 403);
        }

        try {
          const entry = await freezeSkill(skill);
          await skillStore.sync(roots);
          setDynamicSkillCommands(await skillStore.getSkills());
          return json({ ok: true, entry }, 201);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'freeze failed';
          const code = (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
          return errorResponse(msg, code);
        }
      }

      if (body.kind === 'mcp') {
        if (!body.mcpName) return errorResponse('mcpName is required', 400);
        if (!body.scope && !body.placementIdentity) return errorResponse('scope or placementIdentity is required', 400);
        if (body.scope && !['user', 'local', 'project'].includes(body.scope)) {
          return errorResponse('scope must be user, local, or project', 400);
        }
        const runtime = body.runtime ?? 'claude';
        if (runtime !== 'claude' && runtime !== 'codex') {
          return errorResponse('runtime must be claude or codex', 400);
        }

        const source = await resolveMcpMutationSource(runtime, body.mcpName, body.inventoryIdentity, body.placementIdentity);
        if (!source) return errorResponse(`MCP server "${body.mcpName}" placement not found`, 404);
        const sourceScope = source.placement?.scope ?? body.scope;
        const sourceDir = source.placement?.dir ?? body.fromDir;

        try {
          if (isPreview) {
            const opts = {
              ts,
              backupDir: join(resolveKanbanDataDir(), 'cold-storage', 'backups'),
              targetDir: sourceScope === 'local' ? sourceDir : undefined,
              projectDir: sourceScope === 'project' ? sourceDir : undefined,
            };
            const changes = runtime === 'claude'
              ? previewRemoveMcp(body.mcpName, sourceScope as 'user' | 'local' | 'project', opts)
              : previewRemoveCodexMcp(body.mcpName, sourceScope as 'user' | 'local' | 'project', opts);
            return json({ preview: true, changes });
          }
          const entry = await freezeMcp(
            body.mcpName,
            source.def,
            sourceScope as import('../core/types').CapScope,
            sourceDir,
            { ts, runtime, sourcePlacement: source.placement },
          );
          return json({ ok: true, entry }, 201);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'freeze failed';
          const code = (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
          return errorResponse(msg, code);
        }
      }

      return errorResponse('kind must be skill or mcp', 400);
    }

    // Route: POST /api/scope/cold/restore — restore an entry from cold storage
    if (method === 'POST' && path === '/api/scope/cold/restore') {
      const isPreview = url.searchParams.get('preview') === '1';
      const body = await req.json() as {
        kind?: 'skill' | 'mcp';
        ref?: string;
        targetRootId?: string;
        toScope?: string;
        targetDir?: string;
        projectDir?: string;
        runtime?: McpRuntime;
      };

      if (!body.kind || !body.ref) return errorResponse('kind and ref are required', 400);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');

      if (body.kind === 'skill') {
        if (!body.targetRootId) return errorResponse('targetRootId required for skill restore', 400);
        if (!skillStore || !skillRootsStore) return errorResponse('Skills not available', 503);

        const roots = await skillRootsStore.getRoots();
        const targetRoot = roots.find((r) => r.id === body.targetRootId && r.enabled);
        if (!targetRoot) return errorResponse('Target root not found or disabled', 404);

        const parts = body.ref.split('/');
        if (parts.length < 2) return errorResponse('Invalid skill ref format', 400);
        const skillName = parts.slice(1).join('/');
        const targetDir = join(targetRoot.dir, skillName);

        try {
          await restoreSkill(body.ref, targetDir);
          const syncResult = await skillStore.sync(roots);
          setDynamicSkillCommands(await skillStore.getSkills());
          return json({ ok: true, syncResult });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'restore failed';
          const code = (e as { code?: string }).code === 'CONFLICT_409' ? 409 : 500;
          return errorResponse(msg, code);
        }
      }

      if (body.kind === 'mcp') {
        if (body.toScope && !['user', 'local', 'project'].includes(body.toScope)) {
          return errorResponse('toScope must be user, local, or project', 400);
        }
        try {
          if (isPreview) {
            const cold = getColdMcpEntry(body.ref);
            if (!cold) return errorResponse(`Cold storage MCP not found: ${body.ref}`, 404);
            if (body.runtime && body.runtime !== cold.runtime) {
              return errorResponse(`Cold MCP runtime is ${cold.runtime}, not ${body.runtime}`, 400);
            }
            const scope = body.toScope as 'user' | 'local' | 'project' | undefined
              ?? (cold.sourcePlacement?.scope !== 'cold' ? cold.sourcePlacement?.scope : undefined)
              ?? cold.originScope;
            if (scope === 'cold') return errorResponse('Original MCP placement is not writable', 400);
            const name = cold.runtime === 'codex' && body.ref.startsWith('codex/')
              ? body.ref.slice('codex/'.length) : body.ref;
            const opts = {
              ts,
              backupDir: join(resolveKanbanDataDir(), 'cold-storage', 'backups'),
              targetDir: body.targetDir ?? (scope === 'local' ? cold.sourcePlacement?.dir : undefined),
              projectDir: body.projectDir ?? (scope === 'project' ? cold.sourcePlacement?.dir : undefined),
            };
            const changes = cold.runtime === 'claude'
              ? previewCopyMcp(name, cold.def, scope, opts)
              : previewCopyCodexMcp(name, cold.def, scope, opts);
            return json({ preview: true, changes });
          }
          await restoreMcp(body.ref, body.toScope as 'user' | 'local' | 'project' | undefined, {
            ts,
            targetDir: body.targetDir,
            projectDir: body.projectDir,
            runtime: body.runtime,
          });
          return json({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'restore failed';
          const errorCode = (e as { code?: string }).code;
          const code = errorCode === 'CONFLICT_409' ? 409 : errorCode === 'RUNTIME_MISMATCH' ? 400 : 500;
          return errorResponse(msg, code);
        }
      }

      return errorResponse('kind must be skill or mcp', 400);
    }

    // Route: GET|DELETE /api/scope/cold/:kind/:ref — detail / permanent delete
    const coldDeleteMatch = path.match(/^\/api\/scope\/cold\/(skill|mcp)\/(.+)$/);
    if (coldDeleteMatch && method === 'GET') {
      const kind = coldDeleteMatch[1] as 'skill' | 'mcp';
      const ref = decodeURIComponent(coldDeleteMatch[2]);
      const entry = getColdManifest().find((e) => e.kind === kind && e.ref === ref);
      if (!entry) return errorResponse(`Cold storage entry not found: ${ref}`, 404);
      if (kind === 'skill') {
        const file = readColdSkillContent(ref);
        return json({ entry, filePath: file?.filePath, content: file?.content });
      }
      const cold = getColdMcpEntry(ref);
      return json({ entry, def: cold?.def });
    }
    if (coldDeleteMatch && method === 'DELETE') {
      const kind = coldDeleteMatch[1] as 'skill' | 'mcp';
      const ref = decodeURIComponent(coldDeleteMatch[2]);
      try {
        await deleteColdEntry(kind, ref);
        return new Response(null, { status: 204 });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'delete failed';
        return errorResponse(msg, 500);
      }
    }

    return errorResponse('Not found', 404);
  }

  return { handleRequest };
}
