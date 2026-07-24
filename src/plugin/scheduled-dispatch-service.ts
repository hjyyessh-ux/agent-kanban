import type { KanbanStore } from '../core/store';
import type { DispatchResult, KanbanCard } from '../core/types';

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_STALE_CLAIM_MS = 30_000;

interface IntervalHandle {
  unref?: () => void;
}

interface TimerApi {
  setInterval(fn: () => void, delayMs: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

interface ScheduledDispatchLifecycleDeps {
  store: KanbanStore;
  dispatchFn: (cardId: string) => Promise<DispatchResult>;
  now?: () => Date;
  tickMs?: number;
  staleClaimMs?: number;
  timer?: TimerApi;
}

export interface DispatchScheduledCardOptions {
  store: KanbanStore;
  dispatchFn: (cardId: string) => Promise<DispatchResult>;
  cardId: string;
  now?: () => Date;
  claimScheduled?: boolean;
}

function defaultTimerApi(): TimerApi {
  return {
    setInterval(fn, delayMs) {
      return globalThis.setInterval(fn, delayMs) as IntervalHandle;
    },
    clearInterval(handle) {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markScheduledDispatchFailed(
  store: KanbanStore,
  cardId: string,
  message: string,
  failedAt: string,
): Promise<void> {
  const card = await store.getCard(cardId);
  if (card) {
    await store.updateCard(cardId, {
      status: 'todo',
      progressSummary: `[failed] ${message}`,
      staleStatus: null,
      staleDetectedAt: null,
    });
  }
  await store.finalizeScheduledDispatch(cardId, { status: 'failed', error: message }, failedAt);
}

async function maybeClaimScheduledCard(
  store: KanbanStore,
  card: KanbanCard,
  claimAt: string,
  claimScheduled: boolean,
): Promise<boolean> {
  if (!claimScheduled || !card.scheduledDispatch) {
    return false;
  }
  if (card.scheduledDispatch.status === 'dispatching') {
    throw Object.assign(new Error('Scheduled dispatch already in progress'), { statusCode: 409 });
  }
  if (card.scheduledDispatch.status !== 'scheduled') {
    return false;
  }

  const claimed = await store.claimScheduledDispatch(card.id, claimAt);
  if (!claimed) {
    throw Object.assign(new Error('Scheduled dispatch already claimed'), { statusCode: 409 });
  }
  return true;
}

export async function dispatchCardWithScheduledReservation(
  options: DispatchScheduledCardOptions,
): Promise<DispatchResult> {
  const now = options.now ?? (() => new Date());
  const card = await options.store.getCard(options.cardId);
  if (!card) {
    throw Object.assign(new Error('Card not found'), { statusCode: 404 });
  }

  const claimAt = now().toISOString();
  const claimedScheduled = await maybeClaimScheduledCard(
    options.store,
    card,
    claimAt,
    options.claimScheduled ?? true,
  );

  try {
    const result = await options.dispatchFn(options.cardId);
    if (claimedScheduled) {
      await options.store.finalizeScheduledDispatch(options.cardId, {
        status: 'dispatched',
        dispatchedAt: result.startedAt,
      }, result.startedAt);
    }
    return result;
  } catch (error) {
    if (claimedScheduled) {
      await markScheduledDispatchFailed(
        options.store,
        options.cardId,
        failureMessage(error),
        now().toISOString(),
      );
    }
    throw error;
  }
}

export class ScheduledDispatchService {
  private readonly store: KanbanStore;
  private readonly dispatchFn: (cardId: string) => Promise<DispatchResult>;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly staleClaimMs: number;
  private readonly timer: TimerApi;
  private started = false;
  private intervalHandle: IntervalHandle | null = null;
  private scanPromise: Promise<void> | null = null;
  private rescanRequested = false;

  constructor(deps: ScheduledDispatchLifecycleDeps) {
    this.store = deps.store;
    this.dispatchFn = deps.dispatchFn;
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.staleClaimMs = deps.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    this.timer = deps.timer ?? defaultTimerApi();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.intervalHandle = this.timer.setInterval(() => {
      void this.kick();
    }, this.tickMs);
    this.intervalHandle.unref?.();
    await this.kick();
  }

  stop(): void {
    this.started = false;
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async kick(): Promise<void> {
    if (this.scanPromise) {
      this.rescanRequested = true;
      await this.scanPromise;
      return;
    }

    this.scanPromise = this.runScanLoop();
    try {
      await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }

  private async runScanLoop(): Promise<void> {
    do {
      this.rescanRequested = false;
      if (!this.started) return;
      await this.scanOnce();
    } while (this.started && this.rescanRequested);
  }

  private async scanOnce(): Promise<void> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.staleClaimMs).toISOString();
    await this.store.recoverStaleScheduledDispatchClaims(staleBefore, now.toISOString());
    const claimedCards = await this.store.claimDueScheduledDispatch(now.toISOString());

    for (const card of claimedCards) {
      if (!this.started) return;
      try {
        const result = await this.dispatchFn(card.id);
        await this.store.finalizeScheduledDispatch(card.id, {
          status: 'dispatched',
          dispatchedAt: result.startedAt,
        }, result.startedAt);
      } catch (error) {
        await markScheduledDispatchFailed(
          this.store,
          card.id,
          failureMessage(error),
          this.now().toISOString(),
        );
      }
    }
  }
}
