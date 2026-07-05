import type { KanbanStore } from '../../core/store';
import { resolveAgentRuntime } from '../../core/runtime-config';
import type { RuntimeRunStore } from './runtime-run-store';

const CHECK_INTERVAL = 30_000;
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

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

      const activeRun = await this.runStore.findActiveRunByCard(card.id);
      if (!activeRun) {
        // Orphaned: in_progress with no active run → move back to todo
        await this.store.updateCard(card.id, {
          status: 'todo',
          progressSummary: `[watchdog] no active ${runtime} run found; card returned to todo`,
          staleStatus: null,
          staleDetectedAt: null,
        }).catch(() => undefined);
        continue;
      }

      // Active run present — check wall-clock stuck threshold
      const lastUpdate = new Date(card.updatedAt).getTime();
      if (now - lastUpdate > STUCK_THRESHOLD_MS) {
        if (card.staleStatus !== 'stuck') {
          await this.store.updateCard(card.id, {
            staleStatus: 'stuck',
            staleDetectedAt: card.staleDetectedAt ?? new Date().toISOString(),
          }).catch(() => undefined);
        }
      } else if (card.staleStatus) {
        await this.store.updateCard(card.id, {
          staleStatus: null,
          staleDetectedAt: null,
        }).catch(() => undefined);
      }
    }
  }
}
