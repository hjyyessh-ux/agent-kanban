import type { KanbanStore } from '../core/store';
import type { SchedulerStore } from '../core/scheduler-store';
import type { SchedulerEngine } from '../plugin/scheduler-engine';
import { dispatchCardWithScheduledReservation } from '../plugin/scheduled-dispatch-service';
import type { SettingsStore } from '../core/settings-store';
import type { ScriptStore } from '../core/script-store';
import type { SkillStore } from '../core/skill-store';
import type { SkillRootsStore } from '../core/skill-roots-store';
import type { PlacementTargetsStore } from '../core/placement-targets-store';
import { validateSkillPath } from '../core/validate-skill-path';
import type { QuestionMonitor } from '../plugin/question-monitor';
import type { QuestionRequest } from '../plugin/question-monitor';
import type { WikiWorker } from '../plugin/wiki/wiki-worker';
import type { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { buildRunProgress, buildTranscriptProgress } from '../plugin/runtimes/run-progress';
import { resolveClaudeTranscriptPath } from '../plugin/wiki/wiki-transcript';
import { getSettingValueOrDefault } from '../core/settings-store';
import type {
  AgentRuntime,
  DispatchResult,
  McpInventoryDiscoveryResult,
  McpPlacement,
  McpRuntime,
  PlacementTarget,
  SchedulerScheduleInputState,
  SchedulerSimpleRepeat,
  SkillRuntime,
  WikiArchiveCardStatusFilter,
} from '../core/types';
import { RUNTIME_CATALOG, resolveAgentRuntime, type RuntimeCatalogEntry } from '../core/runtime-config';
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
) {
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
        const allCards = await store.getCards({ includeArchived: true });

        if (!aggregateSessionsFn) {
          const sessionMap = new Map<string, {
            sessionId: string;
            sessionTitle?: string;
            cardTitle: string;
            cardId: string;
            cardStatus: string;
            agentRuntime: AgentRuntime;
            agentType?: string;
            model?: string;
            updatedAt: string;
          }>();
          for (const c of allCards) {
            if (!c.sessionId) continue;
            const existing = sessionMap.get(c.sessionId);
            if (!existing || new Date(c.updatedAt) > new Date(existing.updatedAt)) {
              sessionMap.set(c.sessionId, {
                sessionId: c.sessionId,
                sessionTitle: c.sessionTitle,
                cardTitle: c.title,
                cardId: c.id,
                cardStatus: c.status,
                agentRuntime: resolveAgentRuntime(c),
                agentType: c.agentType,
                model: c.model,
                updatedAt: c.updatedAt,
              });
            }
          }
          const sessions = Array.from(sessionMap.values()).sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          );
          return json(sessions);
        }

        const nativeSessions = await aggregateSessionsFn();
        const cardsBySession = new Map<string, typeof allCards>();
        for (const card of allCards) {
          if (!card.sessionId) continue;
          const list = cardsBySession.get(card.sessionId);
          if (list) {
            list.push(card);
          } else {
            cardsBySession.set(card.sessionId, [card]);
          }
        }

        for (const cards of cardsBySession.values()) {
          cards.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        }

        const nativeBySession = new Map<string, NativeSessionInfo[]>();
        for (const native of nativeSessions) {
          const list = nativeBySession.get(native.sessionId);
          if (list) {
            list.push(native);
          } else {
            nativeBySession.set(native.sessionId, [native]);
          }
        }

        const sessions = Array.from(nativeBySession.entries()).map(([sessionId, nativeEntries]) => {
          const native = nativeEntries[0];
          if (!native) {
            return {
              sessionId,
              sessionTitle: undefined,
              sessionCreatedAt: undefined,
              cardTitle: '(No linked card)',
              cardId: '',
              cardStatus: 'untracked',
              agentType: undefined,
              model: undefined,
              agentRuntime: 'opencode' as const,
              linkState: 'none' as const,
              relatedCardCount: 0,
              isSubagentOnly: false,
              hasTopLevelLinkedCard: false,
              hasSubagentLinkedCard: false,
              visiblePeerCount: 0,
              primaryPeerInstanceId: undefined,
              primaryPeerPort: undefined,
              primaryPeerIsLocal: false,
              primaryPeerCwd: undefined,
              updatedAt: new Date(0).toISOString(),
            };
          }

          const cards = cardsBySession.get(native.sessionId) ?? [];
          const primaryCard = cards.find(card => !card.parentCardId) ?? cards[0];
          const hasTopLevelLinkedCard = cards.some((card) => !card.parentCardId);
          const hasSubagentLinkedCard = cards.some((card) => Boolean(card.parentCardId));
          const isSubagentOnly = cards.length > 0 && !hasTopLevelLinkedCard;
          const peerKeys = new Set<string>();
          for (const entry of nativeEntries) {
            peerKeys.add(`${entry.sourceInstanceId ?? 'unknown'}:${entry.sourcePort ?? 0}`);
          }
          const updatedAt = primaryCard?.updatedAt
            ?? native.updatedAt
            ?? native.sessionCreatedAt
            ?? new Date(0).toISOString();

          return {
            sessionId: native.sessionId,
            sessionTitle: primaryCard?.sessionTitle ?? native.sessionTitle,
            sessionCreatedAt: primaryCard?.sessionCreatedAt ?? native.sessionCreatedAt,
            cardTitle: primaryCard?.title ?? '(No linked card)',
            cardId: primaryCard?.id ?? '',
            cardStatus: primaryCard?.status ?? 'untracked',
            agentRuntime: primaryCard ? resolveAgentRuntime(primaryCard) : 'opencode',
            agentType: primaryCard?.agentType,
            model: primaryCard?.model,
            linkState: cards.length === 0 ? 'none' : cards.length === 1 ? 'single' : 'multiple',
            relatedCardCount: cards.length,
            isSubagentOnly,
            hasTopLevelLinkedCard,
            hasSubagentLinkedCard,
            visiblePeerCount: peerKeys.size,
            primaryPeerInstanceId: native.sourceInstanceId,
            primaryPeerPort: native.sourcePort,
            primaryPeerIsLocal: native.sourceIsLocal ?? false,
            primaryPeerCwd: native.sourceCwd,
            updatedAt,
          };
        });

        for (const [sessionId, cards] of cardsBySession.entries()) {
          if (nativeBySession.has(sessionId)) continue;
          const primaryCard = cards.find(card => !card.parentCardId) ?? cards[0];
          if (!primaryCard) continue;
          sessions.push({
            sessionId,
            sessionTitle: primaryCard.sessionTitle,
            sessionCreatedAt: primaryCard.sessionCreatedAt,
            cardTitle: primaryCard.title,
            cardId: primaryCard.id,
            cardStatus: primaryCard.status,
            agentRuntime: resolveAgentRuntime(primaryCard),
            agentType: primaryCard.agentType,
            model: primaryCard.model,
            linkState: cards.length === 1 ? 'single' : 'multiple',
            relatedCardCount: cards.length,
            isSubagentOnly: cards.length > 0 && !cards.some((card) => !card.parentCardId),
            hasTopLevelLinkedCard: cards.some((card) => !card.parentCardId),
            hasSubagentLinkedCard: cards.some((card) => Boolean(card.parentCardId)),
            visiblePeerCount: 0,
            primaryPeerInstanceId: undefined,
            primaryPeerPort: undefined,
            primaryPeerIsLocal: true,
            primaryPeerCwd: undefined,
            updatedAt: primaryCard.updatedAt,
          });
        }

        sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return json(sessions);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to fetch sessions';
        return errorResponse(message, 500);
      }
    }

    // Route: GET /api/cards
    if (method === 'GET' && path === '/api/cards') {
      const status = url.searchParams.get('status') as Parameters<typeof store.getCards>[0] extends { status?: infer S } ? S : never;
      const includeArchived = url.searchParams.get('include_archived') === 'true';
      const cards = await store.getCards(status ? { status, includeArchived } : includeArchived ? { includeArchived } : undefined);
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
        };
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
        const card = await store.createCard({
          ...body,
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
        const card = await store.getCard(id);
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
          const card = await store.updateCard(id, body);
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
      if (!scriptStore) return errorResponse('Scripts not available', 503);
      const id = scriptRunMatch[1];
      try {
        const entry = await scriptStore.getEntry(id);
        if (!entry) return errorResponse('Script not found', 404);

        const { nanoid } = await import('nanoid');
        const runId = nanoid();
        const startedAt = new Date().toISOString();

        // Record initial 'running' status
        const initialRun: import('../core/types').ScriptRun = {
          id: runId,
          scriptId: id,
          startedAt,
          status: 'running',
        };
        await scriptStore.addRun(id, initialRun);

        // Determine shell command
        const cmd: string[] = entry.language === 'python'
          ? ['python3', '-c', entry.content]
          : ['bash', '-c', entry.content];

        const spawnOpts: { cmd: string[]; cwd?: string; stdout: 'pipe'; stderr: 'pipe' } = {
          cmd,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
        };
        if (entry.projectDir) {
          spawnOpts.cwd = entry.projectDir;
        }

        const proc = Bun.spawn(spawnOpts.cmd, {
          cwd: spawnOpts.cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;

        const finalRun: import('../core/types').ScriptRun = {
          id: runId,
          scriptId: id,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: exitCode === 0 ? 'success' : 'fail',
          exitCode,
          stdout,
          stderr,
        };
        await scriptStore.addRun(id, finalRun);

        return json(finalRun);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Run failed';
        return errorResponse(message, 500);
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
        await scriptStore.deleteEntry(id);
        return new Response(null, { status: 204 });
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
