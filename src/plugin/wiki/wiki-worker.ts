import type { KanbanStore } from '../../core/store';
import type { SettingsStore } from '../../core/settings-store';
import type {
  CardWikiState,
  CodexReasoningEffort,
  KanbanCard,
  WikiLlmRoute,
  WikiConfigDto,
  WikiConfigInput,
  WikiLogEntry,
  WikiWorkerStatus,
} from '../../core/types';
import {
  CODEX_REASONING_EFFORT_VALUES,
  DEFAULT_CODEX_REASONING_EFFORT,
} from '../../core/runtime-config';
import { loadWikiConfig, WIKI_PROMPT_VERSION, WIKI_SETTING_KEYS } from './wiki-config';
import {
  buildTriagePrompt,
  buildClassifyPrompt,
  parseTriageResult,
  parseClassifyResult,
  type WikiSourceGroup,
} from './wiki-prompts';
import { createWikiLlm, resolveWikiLlmRoute, type WikiLlmRunner } from './wiki-llm';
import { WikiVaultWriter } from './wiki-writer';
import { loadClaudeTranscript } from './wiki-transcript';

/** How often to look for pending wiki cards (ms). */
const CHECK_INTERVAL = 60_000;

/** Max worker activity log lines kept in memory. */
const LOG_CAP = 200;

function groupLabel(group: WikiSourceGroup): string {
  return group.sessionTitle?.trim() || group.cards[0]?.title || group.key;
}

interface WikiRunMetadata {
  model: string;
  route: WikiLlmRoute;
  effort: CodexReasoningEffort;
}

/** Group pending cards by session so one work stream becomes one document. */
export function groupCardsBySession(cards: KanbanCard[]): WikiSourceGroup[] {
  const groups = new Map<string, WikiSourceGroup>();
  for (const card of cards) {
    const key = card.sessionId ?? `card:${card.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, sessionId: card.sessionId, cards: [] };
      groups.set(key, group);
    }
    group.cards.push(card);
    group.sessionTitle = group.sessionTitle ?? card.sessionTitle;
    group.projectDir = group.projectDir ?? card.projectDir;
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return result;
}

/**
 * WikiWorker — async consumer of wiki-pending archived cards.
 *
 * Archiving only stamps `wiki.status = 'pending'`; this worker picks pending
 * cards up on an interval (or an explicit kick after backfill/reprocess),
 * groups them by session, runs the two-stage triage → classify LLM pipeline,
 * writes documents into the Obsidian vault, and records the outcome back on
 * the archived cards. Failed groups stay `failed` (no auto-retry storm) and
 * become backfill targets again.
 *
 * Follows StaleCardChecker's .unref() timer pattern. Must only run on the
 * singleton runtime owner.
 */
export class WikiWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private processedInRun = 0;
  private totalInRun = 0;
  private lastError?: string;
  private lastFinishedAt?: string;
  private readonly logs: WikiLogEntry[] = [];
  private readonly llmRunner: WikiLlmRunner;
  private readonly concurrency: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KanbanStore,
    private readonly settingsStore: SettingsStore,
    options?: { llmRunner?: WikiLlmRunner; concurrency?: number },
  ) {
    this.concurrency = Math.max(1, options?.concurrency ?? 1);
    this.llmRunner = options?.llmRunner ?? createWikiLlm({
      settingsStore,
      model: async () => (await loadWikiConfig(settingsStore)).model,
      effort: async () => (await loadWikiConfig(settingsStore)).effort,
    });
  }

  /**
   * Vault writes (doc/index/log) and result bookkeeping are read-modify-write,
   * so concurrent groups serialize through this in-process mutex. LLM calls
   * stay outside the lock — that's where concurrency pays off.
   */
  private withVaultWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Append a worker activity line (ring buffer, capped at LOG_CAP). */
  private log(level: WikiLogEntry['level'], message: string, metadata?: WikiRunMetadata): void {
    this.logs.push({ at: new Date().toISOString(), level, message, ...metadata });
    if (this.logs.length > LOG_CAP) {
      this.logs.splice(0, this.logs.length - LOG_CAP);
    }
  }

  private runMetadata(config: Awaited<ReturnType<typeof loadWikiConfig>>): WikiRunMetadata {
    return {
      model: config.model,
      route: resolveWikiLlmRoute(config.model),
      effort: config.effort,
    };
  }

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.processQueue().catch(() => {
        // Worker must never crash the plugin.
      });
    }, CHECK_INTERVAL);
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
    this.log('info', 'worker started');
    this.kick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.log('info', 'worker stopped');
  }

  /**
   * Restart the worker — clears the timer, force-resets the reentrancy guard
   * (recovers a run wedged on a hung LLM call), then starts fresh and kicks.
   */
  restart(): void {
    this.stop();
    this.processing = false;
    this.lastError = undefined;
    this.log('warn', 'worker restarted (state reset)');
    this.start();
  }

  /** Trigger a processing pass without waiting for the interval. */
  kick(): void {
    this.processQueue().catch(() => {});
  }

  /** Read a generated wiki document for the UI preview (frontmatter stripped). */
  async readDocument(relPath: string): Promise<string | null> {
    const config = await loadWikiConfig(this.settingsStore);
    if (!config.vaultDir.trim()) return null;
    return new WikiVaultWriter(config.vaultDir).readDocument(relPath);
  }

  async getStatus(): Promise<WikiWorkerStatus> {
    const config = await loadWikiConfig(this.settingsStore);
    const metadata = this.runMetadata(config);
    const stats = await this.store.getWikiStats();
    return {
      enabled: config.enabled,
      running: this.processing,
      pendingCount: stats.pending,
      processedInRun: this.processedInRun,
      totalInRun: this.totalInRun,
      promptVersion: WIKI_PROMPT_VERSION,
      vaultDir: config.vaultDir,
      model: config.model,
      route: metadata.route,
      effort: config.effort,
      stats,
      recentLogs: this.logs.slice(-50),
      lastError: this.lastError,
      lastFinishedAt: this.lastFinishedAt,
    };
  }

  /**
   * Current wiki config for the WIKI tab. `configured` is false until the user
   * saves settings from the tab — there is no boot-time auto-seed, so the tab
   * shows a setup prompt instead of silently running with defaults.
   */
  async getConfig(): Promise<WikiConfigDto> {
    const entries = await this.settingsStore.getEntries();
    const configured = entries.some(e =>
      e.key === WIKI_SETTING_KEYS.enabled
      || e.key === WIKI_SETTING_KEYS.model
      || e.key === WIKI_SETTING_KEYS.effort
      || e.key === WIKI_SETTING_KEYS.vaultDir,
    );
    const config = await loadWikiConfig(this.settingsStore);
    const metadata = this.runMetadata(config);
    return {
      configured,
      enabled: config.enabled,
      model: config.model,
      route: metadata.route,
      effort: config.effort,
      vaultDir: config.vaultDir,
    };
  }

  /**
   * Persist wiki settings from the WIKI tab. Only provided fields are written
   * (creating the keys on first save). Enabling kicks a processing pass right
   * away so the user sees activity immediately.
   */
  async saveConfig(input: WikiConfigInput): Promise<WikiConfigDto> {
    const wikiOpts = { category: 'wiki' as const, masked: false };
    const existing = await loadWikiConfig(this.settingsStore);
    const nextVaultDir = typeof input.vaultDir === 'string' && input.vaultDir.trim()
      ? input.vaultDir.trim()
      : existing.vaultDir;

    if (input.enabled === true && !nextVaultDir.trim()) {
      throw new Error('Wiki vault directory is required before enabling');
    }

    if (typeof input.model === 'string' && input.model.trim()) {
      await this.settingsStore.upsertByKey(WIKI_SETTING_KEYS.model, input.model.trim(), {
        ...wikiOpts,
        description: 'Model for wiki triage/classification (gpt-* → codex CLI, otherwise claude CLI)',
      });
    }
    if (input.effort !== undefined) {
      const effort: CodexReasoningEffort =
        CODEX_REASONING_EFFORT_VALUES.includes(input.effort)
          ? input.effort
          : DEFAULT_CODEX_REASONING_EFFORT;
      await this.settingsStore.upsertByKey(WIKI_SETTING_KEYS.effort, effort, {
        ...wikiOpts,
        description: 'Reasoning effort for wiki LLM runs: low | medium | high | xhigh',
      });
    }
    if (typeof input.vaultDir === 'string' && input.vaultDir.trim()) {
      await this.settingsStore.upsertByKey(WIKI_SETTING_KEYS.vaultDir, input.vaultDir.trim(), {
        ...wikiOpts,
        description: 'Obsidian vault directory where wiki documents are written',
      });
    }
    if (typeof input.enabled === 'boolean') {
      await this.settingsStore.upsertByKey(WIKI_SETTING_KEYS.enabled, input.enabled ? 'true' : 'false', {
        ...wikiOpts,
        description: 'Process archived done cards into the LLM wiki (true/false)',
      });
      this.log('info', `config updated — enabled=${input.enabled}`);
      if (input.enabled) this.kick();
    }

    return this.getConfig();
  }

  /**
   * Queue unprocessed / outdated / failed archived cards, then start
   * processing. `limit` caps the queue at the N most recent candidates —
   * the default guards against burning tokens on a huge archive.
   */
  async backfill(limit?: number): Promise<number> {
    const queued = await this.store.markWikiPending({
      currentPromptVersion: WIKI_PROMPT_VERSION,
      limit,
    });
    this.kick();
    return queued;
  }

  /** Force re-queue specific archived cards (UI "다시 처리"). */
  async reprocess(cardIds: string[]): Promise<number> {
    const queued = await this.store.markWikiPending({
      currentPromptVersion: WIKI_PROMPT_VERSION,
      cardIds,
    });
    this.kick();
    return queued;
  }

  /** Process all pending cards sequentially. Reentrancy-guarded. */
  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const config = await loadWikiConfig(this.settingsStore);
      if (!config.enabled) return;
      if (!config.vaultDir.trim()) {
        const metadata = this.runMetadata(config);
        const message = 'Wiki vault directory is not configured. Set a vault path in Wiki settings before enabling.';
        this.lastError = message;
        this.log('error', message, metadata);
        return;
      }

      const pending = await this.store.getWikiPendingCards();
      if (pending.length === 0) return;

      const writer = new WikiVaultWriter(config.vaultDir);
      writer.ensureVaultDir();

      const metadata = this.runMetadata(config);
      const groups = groupCardsBySession(pending);
      this.totalInRun = pending.length;
      this.processedInRun = 0;
      this.log(
        'info',
        `처리 시작 — ${pending.length}개 카드, ${groups.length}개 세션 그룹 (concurrency ${this.concurrency}) · ${metadata.route}/${metadata.model} · effort ${metadata.effort}`,
        metadata,
      );

      const queue = [...groups];
      const workerCount = Math.min(this.concurrency, queue.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        for (let group = queue.shift(); group; group = queue.shift()) {
          try {
            await this.processGroup(group, writer, metadata);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.lastError = message;
            this.log('error', `fail | ${groupLabel(group)} — ${message}`, metadata);
            await this.recordFailure(group, message, metadata);
          }
          this.processedInRun += group.cards.length;
        }
      }));
      this.lastFinishedAt = new Date().toISOString();
      this.log('info', `처리 완료 — ${this.processedInRun}개 카드 처리됨`, metadata);
    } finally {
      this.processing = false;
    }
  }

  private async processGroup(group: WikiSourceGroup, writer: WikiVaultWriter, metadata: WikiRunMetadata): Promise<void> {
    // Best-effort transcript enrichment (claude runtime only).
    const transcriptSource = group.cards.find(c => c.agentRuntime === 'claude');
    if (transcriptSource) {
      group.transcript = loadClaudeTranscript(transcriptSource);
    }
    const sourceDepth = group.transcript ? 'transcript' as const : 'card' as const;
    const now = new Date().toISOString();

    const triage = parseTriageResult(await this.llmRunner(buildTriagePrompt(group), metadata));
    if (triage.decision === 'skip') {
      await this.withVaultWriteLock(async () => {
        await this.applyWikiState(group, (prev) => ({
          ...prev,
          status: 'processed',
          decision: 'skipped',
          skipReason: triage.reason,
          processedAt: now,
          promptVersion: WIKI_PROMPT_VERSION,
          model: metadata.model,
          route: metadata.route,
          effort: metadata.effort,
        }));
        await writer.appendLog(`- [${now}] skip | ${groupLabel(group)} — ${triage.reason}`);
      });
      this.log('info', `skip | ${groupLabel(group)} — ${triage.reason}`, metadata);
      return;
    }

    const doc = parseClassifyResult(await this.llmRunner(buildClassifyPrompt(group), metadata));
    // Reprocessing overwrites the previous document instead of orphaning it.
    const overwritePath = group.cards.find(c => c.wiki?.docPath)?.wiki?.docPath;
    await this.withVaultWriteLock(async () => {
      const docPath = await writer.writeDocument(
        doc,
        {
          cardIds: group.cards.map(c => c.id),
          sessionId: group.sessionId,
          sessionTitle: group.sessionTitle,
          projectDir: group.projectDir,
          processedAt: now,
          promptVersion: WIKI_PROMPT_VERSION,
          sourceDepth,
        },
        overwritePath,
      );
      await writer.updateIndex({ docPath, title: doc.title, type: doc.type, summary: doc.summary, processed: now, topics: doc.topics });
      await writer.appendLog(`- [${now}] keep | [[${docPath.replace(/\.md$/, '')}|${doc.title}]] ← ${groupLabel(group)} (cards: ${group.cards.length})`);

      await this.applyWikiState(group, (prev) => ({
        queuedAt: prev?.queuedAt,
        status: 'processed',
        decision: 'kept',
        docPath,
        docTitle: doc.title,
        docType: doc.type,
        topics: doc.topics,
        processedAt: now,
        promptVersion: WIKI_PROMPT_VERSION,
        model: metadata.model,
        route: metadata.route,
        effort: metadata.effort,
      }));
    });
    this.log('info', `keep | ${doc.type} · ${doc.title} (cards: ${group.cards.length})`, metadata);
  }

  private async recordFailure(group: WikiSourceGroup, message: string, metadata: WikiRunMetadata): Promise<void> {
    try {
      await this.applyWikiState(group, (prev) => ({
        ...prev,
        status: 'failed',
        error: message,
        model: metadata.model,
        route: metadata.route,
        effort: metadata.effort,
      }));
    } catch {
      // Failure bookkeeping is best-effort.
    }
  }

  private async applyWikiState(
    group: WikiSourceGroup,
    build: (prev: CardWikiState | undefined) => CardWikiState,
  ): Promise<void> {
    const updates: Record<string, CardWikiState> = {};
    for (const card of group.cards) {
      updates[card.id] = build(card.wiki);
    }
    await this.store.updateArchivedCardsWiki(updates);
  }
}
