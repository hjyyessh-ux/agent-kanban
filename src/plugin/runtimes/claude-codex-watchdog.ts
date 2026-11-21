import type { KanbanStore } from '../../core/store';
import { resolveAgentRuntime } from '../../core/runtime-config';
import type { RuntimeRunStore } from './runtime-run-store';
import { matchesInProgressExecution } from './runtime-restart-sync';

const CHECK_INTERVAL = 30_000;
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;
const ORGANIC_CLI_SOURCE_CONTEXTS = new Set(['claude-code', 'codex']);

export class ClaudeCodexWatchdog {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: KanbanStore,
    private readonly runStore: RuntimeRunStore,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.check().catch(() => {});
    }, CHECK_INTERVAL);
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
    this.check().catch(() => {});
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async check(): Promise<void> {
    const inProgressCards = await this.store.getCards({ status: 'in_progress' });
    const now = Date.now();

    for (const card of inProgressCards) {
      const runtime = resolveAgentRuntime(card);
      if (runtime !== 'claude' && runtime !== 'codex') continue;

      // Interactive CLI cards are tracked by their prompt and stop hooks.
      if (card.sourceContext && ORGANIC_CLI_SOURCE_CONTEXTS.has(card.sourceContext)) continue;

      const activeRun = await this.runStore.findActiveRunByCard(card.id);
      const matches = (current: typeof card) =>
        matchesInProgressExecution(current, card) && current.updatedAt === card.updatedAt;
      if (!activeRun) {
        if (card.staleStatus !== 'orphan') {
          await this.store.updateCardIf(card.id, {
            progressSummary: `[watchdog] No active ${runtime} run found. Completion could not be verified.`,
            staleStatus: 'orphan',
            staleDetectedAt: card.staleDetectedAt ?? new Date().toISOString(),
          }, matches);
        }
        continue;
      }

      // Active run present — check wall-clock stuck threshold
      const lastUpdate = new Date(card.updatedAt).getTime();
      if (now - lastUpdate > STUCK_THRESHOLD_MS) {
        if (card.staleStatus !== 'stuck') {
          await this.store.updateCardIf(card.id, {
            staleStatus: 'stuck',
            staleDetectedAt: card.staleDetectedAt ?? new Date().toISOString(),
          }, matches);
        }
      } else if (card.staleStatus) {
        await this.store.updateCardIf(card.id, {
          staleStatus: null,
          staleDetectedAt: null,
        }, matches);
      }
    }
  }
}
