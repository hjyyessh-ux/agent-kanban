import type { PluginInput } from '@opencode-ai/plugin';
import type { KanbanStore } from '../core/store';
import type { KanbanCard } from '../core/types';
import { resolveAgentRuntime } from '../core/runtime-config';
import { isTopLevelParentWaitingOnDirectChild } from './parent-card-guard';

/** How often to check for stale cards (ms). */
const CHECK_INTERVAL = 30_000; // 30s

/** How long a card must be in_progress with no updates to be considered "stuck" (ms). */
const STUCK_THRESHOLD = 15 * 60 * 1000; // 15 minutes

/**
 * StaleCardChecker — periodic timer that detects orphan/stuck in_progress cards.
 *
 * - Orphan: in_progress card whose session no longer exists (process crashed, etc.)
 * - Stuck: in_progress card with no updatedAt change for STUCK_THRESHOLD minutes
 *
 * Follows ServerMonitor's .unref() timer pattern so it doesn't prevent process exit.
 * Cards are FLAGGED only — never auto-completed. The user must decide what to do.
 */
export class StaleCardChecker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly store: KanbanStore;
  private readonly input: PluginInput;

  constructor(store: KanbanStore, input: PluginInput) {
    this.store = store;
    this.input = input;
  }

  /** Start periodic stale card checking. */
  start(): void {
    if (this.intervalId) return; // Don't start duplicate checkers

    this.intervalId = setInterval(() => {
      this.check().catch(() => {
        // Swallow errors — checker should never crash the plugin
      });
    }, CHECK_INTERVAL);

    // Unref so timer doesn't prevent process exit
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }

    // Run initial check immediately (non-blocking)
    this.check().catch(() => {});
  }

  /** Stop periodic checking. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run a single stale card detection pass. Returns cards that were flagged. */
  async check(): Promise<KanbanCard[]> {
    const inProgressCards = await this.store.getCards({ status: 'in_progress' });
    if (inProgressCards.length === 0) return [];

    // Get active session IDs for orphan detection
    const activeSessions = await this.getActiveSessionIds();

    const now = Date.now();
    const flaggedCards: KanbanCard[] = [];

    for (const card of inProgressCards) {
      const newStaleStatus = this.detectStaleStatus(card, inProgressCards, activeSessions, now);

      if (newStaleStatus && card.staleStatus !== newStaleStatus) {
        // Card is stale and either wasn't flagged or changed state
        const updated = await this.store.updateCard(card.id, {
          staleStatus: newStaleStatus,
          staleDetectedAt: card.staleDetectedAt ?? new Date().toISOString(),
        });
        flaggedCards.push(updated);
      } else if (!newStaleStatus && card.staleStatus) {
        // Card is no longer stale — clear the flag
        await this.store.updateCard(card.id, {
          staleStatus: null,
          staleDetectedAt: null,
        });
      }
    }

    return flaggedCards;
  }

  /**
   * Determine the stale status for a card.
   * Returns 'orphan', 'stuck', or null (healthy).
   */
  private detectStaleStatus(
    card: KanbanCard,
    inProgressCards: KanbanCard[],
    activeSessions: Set<string>,
    now: number,
  ): 'orphan' | 'stuck' | null {
    if (card.executionKind === 'script') {
      return null;
    }

    if (isTopLevelParentWaitingOnDirectChild(card, inProgressCards)) {
      return null;
    }

    if (resolveAgentRuntime(card) !== 'opencode') {
      return null;
    }

    // Orphan: has a sessionId but the session no longer exists
    if (card.sessionId && !activeSessions.has(card.sessionId)) {
      return 'orphan';
    }

    // Stuck: still running but no update for STUCK_THRESHOLD ms
    const lastUpdate = new Date(card.updatedAt).getTime();
    if (now - lastUpdate > STUCK_THRESHOLD) {
      return 'stuck';
    }

    return null;
  }

  /** Get the set of active session IDs from the opencode SDK. */
  private async getActiveSessionIds(): Promise<Set<string>> {
    try {
      const response = await this.input.client.session.list();
      if (response.data && Array.isArray(response.data)) {
        return new Set(response.data.map((s: { id: string }) => s.id));
      }
      return new Set();
    } catch {
      // If we can't list sessions, assume all sessions are active
      // to avoid false positives (better to miss an orphan than flag a live card)
      return new Set(
        (await this.store.getCards({ status: 'in_progress' }))
          .map(c => c.sessionId)
          .filter((id): id is string => id !== undefined)
      );
    }
  }
}
