import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { BOARD_HISTORY_PROJECT_ID, boardHistoryPaths, captureCoverage, readConsumer } from './board-history';
import type { BoardHistoryStatusSummary } from './types';

/** Mirrors the journal's retention: events appended earlier are pruned on its next write. */
const RETENTION_MS = 30 * 86400000;
const stamp = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

interface SubscriptionRow {
  cutoff_ms: number;
  initial_high: number;
  prior_prune_generation: number;
  committed: number;
}

/**
 * Owner status summary for the dedicated Card/Works History subscription.
 *
 * Strictly read-only: the journal is opened with a read-only SQLite handle, no
 * reconcile runs, no prune runs and no table is created. It therefore reports
 * what the sidecar last recorded (an unobserved writer shows up only after the
 * next save, boot or consumer read reconciles it).
 *
 * The result never carries event, entity, delivery or subscription IDs, the
 * token or its hash, or any board content. Raw errors never leave: any read
 * failure on an installed consumer becomes `unavailable`.
 */
export function readBoardHistorySummary(dataDir: string, now: number = Date.now()): BoardHistoryStatusSummary {
  const checkedAt = new Date(now).toISOString();
  const paths = boardHistoryPaths(dataDir);
  if (!existsSync(paths.consumer)) return { state: 'not_registered', checkedAt };
  let db: Database | null = null;
  try {
    const consumer = readConsumer(paths.consumer);
    if (!consumer) return { state: 'not_registered', checkedAt };
    if (!existsSync(paths.journal)) return { state: 'unavailable', checkedAt };
    db = new Database(paths.journal, { readonly: true, strict: true });
    db.exec('PRAGMA busy_timeout=2000');
    const handle = db;
    // One deferred read transaction: every figure comes from the same snapshot.
    return handle.transaction((): BoardHistoryStatusSummary => {
      const s = handle.query<SubscriptionRow, [string]>(
        'SELECT cutoff_ms,initial_high,prior_prune_generation,committed FROM board_journal_subscriptions WHERE id=?')
        .get(consumer.subscriptionId);
      if (!s) return { state: 'unavailable', checkedAt };
      const project = BOARD_HISTORY_PROJECT_ID;
      const staleBefore = now - RETENTION_MS;
      // Same scope as the consumer's page: post-registration, or inside the fixed window.
      const inScope = '(seq>? OR COALESCE(occurred_ms,appended_ms)>=?)';
      const count = (sql: string, ...args: number[]) =>
        handle.query<{ n: number }, (string | number)[]>(sql).get(project, ...args)!.n;
      const exists = (sql: string, ...args: number[]) =>
        handle.query<{ x: number }, (string | number)[]>(sql).get(project, ...args) !== null;

      // Expired / pruned as the journal itself would decide on its next prune.
      const cursorExpired = exists(
        `SELECT 1 AS x FROM board_journal_event_keys WHERE project_id=? AND seq>? AND ${inScope}
          AND (prune_generation>? OR (prune_generation=0 AND appended_ms<?)) LIMIT 1`,
        s.committed, s.initial_high, s.cutoff_ms, s.prior_prune_generation, staleBefore);
      const partial = exists(
        `SELECT 1 AS x FROM board_journal_event_keys WHERE project_id=? AND ${inScope}
          AND (prune_generation>0 OR appended_ms<?) LIMIT 1`,
        s.initial_high, s.cutoff_ms, staleBefore);
      const unacked = count(
        `SELECT COUNT(*) AS n FROM board_journal_event_keys WHERE project_id=? AND seq>? AND ${inScope}`,
        s.committed, s.initial_high, s.cutoff_ms);
      const acked = count(
        `SELECT COUNT(*) AS n FROM board_journal_event_keys WHERE project_id=? AND seq<=? AND ${inScope}`,
        s.committed, s.initial_high, s.cutoff_ms);
      const ackedThrough = s.committed > 0
        ? handle.query<{ ms: number }, [string, number]>(
          'SELECT appended_ms AS ms FROM board_journal_events WHERE project_id=? AND seq=?').get(project, s.committed)?.ms ?? null
        : null;
      const lastChange = handle.query<{ ms: number | null }, [string]>(
        'SELECT MAX(appended_ms) AS ms FROM board_journal_event_keys WHERE project_id=?').get(project)!.ms;
      const lastSave = handle.query<{ ms: number | null }, []>('SELECT MAX(captured_ms) AS ms FROM board_capture_fence').get()!.ms;
      const awaiting = handle.query('SELECT 1 FROM board_journal_pending WHERE subscription=?').get(consumer.subscriptionId) !== null;
      const coverage = captureCoverage(handle, new Date(s.cutoff_ms).toISOString());

      return {
        state: 'registered',
        checkedAt,
        registration: {
          installedAt: consumer.installedAt,
          windowStart: coverage.windowStart,
          captureStartedAt: coverage.capturedFrom,
          preCaptureGap: coverage.preCaptureGap,
          gaps: coverage.gaps,
          gapCount: coverage.gapCount,
          pendingSince: coverage.pendingSince,
          continuousSinceWindowStart: coverage.continuousSinceWindowStart,
          lastChangeRecordedAt: stamp(lastChange),
          lastSaveObservedAt: stamp(lastSave),
          consumer: {
            readAndAckTimesCollected: false,
            ackedThroughRecordedAt: stamp(ackedThrough),
            deliveryAwaitingAck: awaiting,
            unackedEvents: cursorExpired ? null : unacked,
            ackedEvents: partial ? null : acked,
            cursorExpired,
          },
        },
      };
    })();
  } catch {
    return { state: 'unavailable', checkedAt };
  } finally {
    db?.close();
  }
}
