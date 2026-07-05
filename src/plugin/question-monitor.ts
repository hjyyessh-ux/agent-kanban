import type { PluginInput } from '@opencode-ai/plugin';
import type { KanbanStore } from '../core/store';

/** A single question option presented to the user */
export interface QuestionOption {
  label: string;
  description: string;
}

/** A single question within a request */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** The full question request as returned by GET /question and question.asked SSE event */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Reply body shape for POST /question/:id/reply */
export interface QuestionReply {
  answers: string[][];
}

/**
 * QuestionMonitor — watches the opencode server for pending questions.
 *
 * Strategy:
 * 1. Connect to `{serverUrl}/event` SSE stream, listen for `question.asked` events
 * 2. Also polls `GET /question` every POLL_INTERVAL_MS as a safety net
 *    (covers missed events, process restarts, and the SSE backlog on reconnect)
 * 3. Exposes `getQuestions()` so the kanban HTTP server can proxy them to the web UI
 * 4. Exposes `reply()` and `reject()` to forward user answers back to opencode
 *
 * Lifecycle follows StaleCardChecker / ServerMonitor patterns:
 * - `start()` begins SSE + polling; timers are `.unref()`'d
 * - `stop()` tears down SSE + polling
 */
export class QuestionMonitor {
  private readonly serverUrl: URL;
  private readonly store?: KanbanStore;
  private enableRecommendedAutoReply: boolean;
  private questions: Map<string, QuestionRequest> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private sseController: AbortController | null = null;
  private sseActive = false;

  // How often to poll as SSE fallback
  private static readonly POLL_INTERVAL_MS = 3_000;
  // How long to wait before giving up on a fetch (ms)
  private static readonly FETCH_TIMEOUT_MS = 5_000;

  constructor(
    input: PluginInput,
    store?: KanbanStore,
    options?: { enableRecommendedAutoReply?: boolean; enableTelegramAutoReply?: boolean },
  ) {
    this.serverUrl = input.serverUrl;
    this.store = store;
    this.enableRecommendedAutoReply =
      options?.enableRecommendedAutoReply ?? options?.enableTelegramAutoReply ?? true;
  }

  setRecommendedAutoReplyEnabled(enabled: boolean): void {
    this.enableRecommendedAutoReply = enabled;
  }

  setTelegramAutoReplyEnabled(enabled: boolean): void {
    this.setRecommendedAutoReplyEnabled(enabled);
  }

  /** Start SSE listener + polling fallback. Non-blocking. */
  start(): void {
    // Start SSE (async, non-blocking)
    this.connectSSE();

    // Start polling fallback (also handles initial load)
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.poll().catch(() => {});
    }, QuestionMonitor.POLL_INTERVAL_MS);

    // Unref so timer doesn't prevent process exit
    if (
      this.intervalId &&
      typeof this.intervalId === 'object' &&
      'unref' in this.intervalId
    ) {
      (this.intervalId as NodeJS.Timeout).unref();
    }

    // Kick off an immediate poll
    this.poll().catch(() => {});
  }

  /** Stop SSE listener and polling. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
    this.sseActive = false;
  }

  /** Return all currently pending questions (snapshot). */
  getQuestions(): QuestionRequest[] {
    return Array.from(this.questions.values());
  }

  addMockQuestion(question: QuestionRequest): void {
    this.questions.set(question.id, question);
  }

  removeQuestion(requestId: string): boolean {
    return this.questions.delete(requestId);
  }

  /**
   * Reply to a question request.
   * `answers` is an array of Answer[] — one per question in the request.
   * Each Answer is an array of selected option labels (or custom text).
   */
  async reply(requestId: string, answers: string[][]): Promise<boolean> {
    const url = new URL(`/question/${requestId}/reply`, this.serverUrl);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers } satisfies QuestionReply),
        signal: AbortSignal.timeout(QuestionMonitor.FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        this.questions.delete(requestId);
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Reject a question request (dismiss without answering).
   */
  async reject(requestId: string): Promise<boolean> {
    const url = new URL(`/question/${requestId}/reject`, this.serverUrl);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(QuestionMonitor.FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        this.questions.delete(requestId);
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  /** Poll GET /question and merge results into in-memory map. */
  private async poll(): Promise<void> {
    const url = new URL('/question', this.serverUrl);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(QuestionMonitor.FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const data = await res.json() as QuestionRequest[];
      if (!Array.isArray(data)) return;

      // Build set of currently pending IDs from server
      const pendingIds = new Set<string>();
      for (const q of data) {
        if (q && typeof q.id === 'string') {
          pendingIds.add(q.id);
          const isNew = !this.questions.has(q.id);
          this.questions.set(q.id, q);
          // Auto-reply for newly discovered questions from tracked card sessions.
          if (isNew) {
            this.tryAutoReply(q).catch(() => {});
          }
        }
      }

      // Remove any questions no longer reported by server
      for (const [id] of this.questions) {
        if (!pendingIds.has(id)) {
          this.questions.delete(id);
        }
      }
    } catch {
      // Server may be starting up or not support /question — ignore
    }
  }

  /** Connect to SSE /event endpoint and listen for question.asked events. */
  private connectSSE(): void {
    if (this.sseActive) return;
    this.sseActive = true;

    const url = new URL('/event', this.serverUrl);
    const controller = new AbortController();
    this.sseController = controller;

    // Async IIFE — fire-and-forget with auto-reconnect
    (async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            // Server not ready yet — wait before retrying
            await sleep(5_000);
            continue;
          }

          await this.consumeSSEStream(res.body, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) break;
          // Network error / timeout — wait then reconnect
          await sleep(5_000);
        }
      }
      this.sseActive = false;
    })().catch(() => {
      this.sseActive = false;
    });
  }

  /** Consume an SSE response body line-by-line, dispatching question events. */
  private async consumeSSEStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();

    let eventType = '';
    let dataLines: string[] = [];

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();

          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          } else if (line === '') {
            // Blank line = end of SSE event
            if (eventType || dataLines.length > 0) {
              this.handleSSEEvent(eventType, dataLines.join('\n'));
            }
            eventType = '';
            dataLines = [];
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Dispatch an SSE event to the appropriate handler. */
  private handleSSEEvent(type: string, data: string): void {
    if (type === 'question.asked') {
      try {
        const request = JSON.parse(data) as QuestionRequest;
        if (request && typeof request.id === 'string') {
          this.questions.set(request.id, request);
          // Auto-reply for tracked card sessions.
          this.tryAutoReply(request).catch(() => {});
        }
      } catch {
        // Malformed JSON — ignore
      }
    } else if (type === 'question.replied' || type === 'question.rejected') {
      // Remove the question from our map when it's answered/rejected
      try {
        const payload = JSON.parse(data) as { requestID?: string; id?: string };
        const id = payload.requestID ?? payload.id;
        if (typeof id === 'string') {
          this.questions.delete(id);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // ──────────────────────────────────────────────
  // Recommended-option auto-reply
  // ──────────────────────────────────────────────

  /**
   * If the question belongs to a tracked card session, automatically reply
   * with the first option for each question. The question tool presents the
   * recommended option first, so this keeps headless runs moving.
   */
  private async tryAutoReply(request: QuestionRequest): Promise<void> {
    if (!this.enableRecommendedAutoReply) return;
    if (!this.store) return;

    // Look up the card for this session
    const card = await this.store.findCardBySessionId(request.sessionID);
    if (!card) return;

    // Build answers: pick the first option for each question
    const answers = request.questions.map((q) => {
      if (q.options.length > 0) {
        return [q.options[0].label];
      }
      return [];
    });

    // Send the auto-reply
    const ok = await this.reply(request.id, answers);

    // Record Q&A history to card's progressSummary
    if (ok) {
      const entry = QuestionMonitor.formatQuestionHistory(request, answers);
      const summary = card.progressSummary
        ? `${card.progressSummary}\n\n${entry}`
        : entry;
      await this.store.updateCard(card.id, { progressSummary: summary });
    }
  }

  /** Format Q&A exchange for progressSummary recording. */
  static formatQuestionHistory(
    question: QuestionRequest,
    answers: string[][] | null,
  ): string {
    const timestamp = new Date().toISOString();
    const lines: string[] = [];

    if (answers === null) {
      lines.push(`[${timestamp}] ❌ Question rejected`);
    } else {
      lines.push(`[${timestamp}] 🤖 Auto-answered (recommended default)`);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
