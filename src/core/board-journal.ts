import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { KanbanStatus, WorkStatus } from './types';

const DAY = 86400000;
const JOURNAL_ROW_CEILING = { eventKeys: 100_000, subscriptions: 1_000, receipts: 100_000 } as const;
type JournalLimit = keyof typeof JOURNAL_ROW_CEILING;
type JournalLimits = Readonly<Record<JournalLimit, number>>;
const TABLE_FOR_LIMIT = {
  eventKeys: 'board_journal_event_keys',
  subscriptions: 'board_journal_subscriptions',
  receipts: 'board_journal_receipts',
} as const;
const TOKEN = /^[A-Za-z0-9_-]{1,120}$/;
const KINDS = ['card', 'work'] as const;
const OPERATIONS = ['create', 'update', 'archive', 'restore', 'delete'] as const;
const CARD_STATES: readonly KanbanStatus[] = ['todo', 'in_progress', 'complete', 'done'];
const WORK_STATES: readonly WorkStatus[] = ['active', 'done', 'discarded'];
const FIELDS = new Set(['eventId', 'projectId', 'kind', 'entityId', 'operation', 'state', 'occurredAt']);
type Kind = typeof KINDS[number];
type Operation = typeof OPERATIONS[number];
type BoardState = KanbanStatus | WorkStatus;

/** Explicit, already-sanitized board identifiers and enums; never pass a board record. */
export interface BoardJournalInput {
  eventId: string;
  projectId: string;
  kind: Kind;
  entityId: string;
  operation: Operation;
  state?: BoardState;
  /** Trusted store mutation time; absent for older append-time callers. */
  occurredAt?: string;
}
export interface BoardJournalEvent extends BoardJournalInput {
  sequence: number;
  appendedAt: string;
  timeBasis: 'trusted_mutation' | 'append_fallback';
  earlierMutationPublishedAfterRegistration?: true;
}
interface Subscription {
  id: string;
  project_id: string;
  cutoff_ms: number;
  initial_high: number;
  prior_prune_generation: number;
  committed: number;
}
interface EventRow {
  seq: number;
  event_id: string;
  project_id: string;
  kind: Kind;
  entity_id: string;
  operation: Operation;
  state: BoardState | null;
  appended_ms: number;
  occurred_ms: number | null;
}
interface Delivery { id: string; start_seq: number; through_seq: number }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('invalid_board_identifier');
  return value;
}
export function normalizeBoardJournalInput(value: BoardJournalInput): BoardJournalInput {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key =>
    typeof key !== 'string' || !FIELDS.has(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)))
    throw new Error('unexpected_board_field');
  const { eventId, projectId, kind, entityId, operation, state, occurredAt } = value;
  if (occurredAt !== undefined && (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))
    || new Date(occurredAt).toISOString() !== occurredAt)) throw new Error('invalid_board_occurrence_time');
  if (!KINDS.includes(kind) || !OPERATIONS.includes(operation) || (state !== undefined && !(kind === 'card' ? CARD_STATES as readonly BoardState[] : WORK_STATES as readonly BoardState[]).includes(state)))
    throw new Error('invalid_board_enumeration');
  return { eventId: identifier(eventId), projectId: identifier(projectId), kind, entityId: identifier(entityId),
    operation, ...(state === undefined ? {} : { state }), ...(occurredAt === undefined ? {} : { occurredAt }) };
}
const stamp = (ms: number) => new Date(ms).toISOString();

/**
 * Standalone, caller-owned SQLite file. Not connected to app startup or source readers.
 * Producers send actual board mutations, never an activation snapshot. Titles and
 * descriptions are not accepted; the input consists of identifiers and enums only. Only one explicit
 * project per subscription; the future route/integration layer owns authorization.
 * 30-day event metadata retention is reclaimed on subscription operations. Small event keys
 * and ACK receipts are retained for the lifetime of this file for permanent retry identity.
 * Admission ceilings bound logical rows without dropping identity or acknowledged data.
 * These are not byte quotas, compaction, or a policy for safely releasing capacity.
 */
export class BoardJournal {
  private readonly db: Database;
  private readonly limits: JournalLimits;
  constructor(readonly path: string, private readonly clock: () => number = Date.now,
    limits: Partial<JournalLimits> = {}) {
    this.limits = { ...JOURNAL_ROW_CEILING, ...limits };
    for (const key of Object.keys(JOURNAL_ROW_CEILING) as JournalLimit[]) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > JOURNAL_ROW_CEILING[key])
        throw new Error('invalid_board_journal_capacity');
    }
    if (!isAbsolute(path)) throw new Error('absolute_board_journal_path_required');
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS board_journal_clock (id INTEGER PRIMARY KEY, started_ms INTEGER NOT NULL, prune_generation INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS board_journal_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL,
          kind TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT, appended_ms INTEGER NOT NULL, occurred_ms INTEGER);
        CREATE INDEX IF NOT EXISTS board_journal_events_project ON board_journal_events(project_id,seq);
        CREATE INDEX IF NOT EXISTS board_journal_events_time ON board_journal_events(appended_ms);
        CREATE TABLE IF NOT EXISTS board_journal_event_keys (
          event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
          appended_ms INTEGER NOT NULL, prune_generation INTEGER NOT NULL DEFAULT 0, occurred_ms INTEGER);
        CREATE INDEX IF NOT EXISTS board_journal_event_keys_unpruned_time ON board_journal_event_keys(appended_ms) WHERE prune_generation=0;
        CREATE INDEX IF NOT EXISTS board_journal_pruned_project ON board_journal_event_keys(project_id,prune_generation,seq);
        CREATE TABLE IF NOT EXISTS board_journal_subscriptions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cutoff_ms INTEGER NOT NULL, initial_high INTEGER NOT NULL,
          prior_prune_generation INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS board_journal_pending (
          subscription TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, start_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS board_journal_receipts (
          subscription TEXT NOT NULL, delivery TEXT NOT NULL, committed INTEGER NOT NULL,
          PRIMARY KEY(subscription,delivery));`);
      this.db.transaction(() => {
        for (const table of ['board_journal_events', 'board_journal_event_keys']) {
          if (!this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(column => column.name === 'occurred_ms'))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN occurred_ms INTEGER`);
        }
      }).immediate();
      this.db.query('INSERT OR IGNORE INTO board_journal_clock(id,started_ms) VALUES (1,?)').run(this.now());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void { this.db.close(); }
  private now(): number {
    const ms = this.clock();
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8.64e15) throw new Error('invalid_board_clock');
    return ms;
  }
  private metadata() {
    return this.db.query<{ started_ms: number; prune_generation: number }, []>('SELECT started_ms,prune_generation FROM board_journal_clock WHERE id=1').get()!;
  }
  private high(): number {
    return this.db.query<{ seq: number }, []>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='board_journal_events'),0) AS seq").get()!.seq;
  }
  private subscription(id: string): Subscription {
    const row = this.db.query<Subscription, [string]>('SELECT * FROM board_journal_subscriptions WHERE id=?').get(identifier(id));
    if (!row) throw new Error('board_subscription_not_found');
    return row;
  }
  private capacityUsage(key: JournalLimit) {
    const used = this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM ${TABLE_FOR_LIMIT[key]}`).get()!.count;
    const reserved = key === 'receipts'
      ? this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM board_journal_pending').get()!.count
      : 0;
    return { used, reserved, ceiling: this.limits[key] };
  }
  // Caller must hold the same immediate transaction as the subsequent write.
  private assertCapacity(key: JournalLimit): void {
    const { used, reserved, ceiling } = this.capacityUsage(key);
    if (used + reserved >= ceiling) throw new Error('board_journal_capacity_reached');
  }
  /** Local operator diagnostic only. Do not expose global counts on scoped HTTP. */
  capacityDiagnostics() {
    return this.db.transaction(() => {
      const item = (key: JournalLimit) => {
        const usage = this.capacityUsage(key);
        const total = usage.used + usage.reserved;
        return { ...usage, remaining: Math.max(0, usage.ceiling - total),
          condition: total >= usage.ceiling ? 'saturated' as const
            : total * 5 >= usage.ceiling * 4 ? 'near_capacity' as const : 'normal' as const };
      };
      const pages = this.db.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count;
      const pageSize = this.db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
      return { eventKeys: item('eventKeys'), subscriptions: item('subscriptions'), receipts: item('receipts'),
        sqliteLogicalBytes: pages * pageSize };
    })();
  }
  /** Trusted maintenance caller only; do not perform blocking checkpoint I/O
   * in scoped requests. Busy readers keep their snapshots and are not killed. */
  checkpointStorage() {
    const size = (file: string) => {
      try { return statSync(file).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    };
    const beforeWalBytes = size(this.path + '-wal');
    const timeout = this.db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()!.timeout;
    try {
      this.db.exec('PRAGMA busy_timeout=0');
      const checkpoint = this.db.query<{ busy: number; log: number; checkpointed: number }, []>(
        'PRAGMA wal_checkpoint(TRUNCATE)').get()!;
      return { outcome: checkpoint.busy ? 'busy' as const : 'checkpointed' as const,
        remainingLogFrames: Math.max(0, checkpoint.log - checkpoint.checkpointed),
        beforeWalBytes, afterWalBytes: size(this.path + '-wal'), databaseBytes: size(this.path) };
    } finally {
      this.db.exec(`PRAGMA busy_timeout=${timeout}`);
    }
  }
  append(value: BoardJournalInput): number {
    const e = normalizeBoardJournalInput(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(e)).digest('hex');
    return this.db.transaction(() => {
      const previous = this.db.query<{ seq: number; fingerprint: string }, [string]>(
        'SELECT seq,fingerprint FROM board_journal_event_keys WHERE event_id=?').get(e.eventId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('board_event_id_conflict');
        return previous.seq;
      }
      this.assertCapacity('eventKeys');
      const now = this.now();
      this.prune(now);
      const occurred = e.occurredAt === undefined ? null : Date.parse(e.occurredAt);
      const added = this.db.query('INSERT INTO board_journal_events(event_id,project_id,kind,entity_id,operation,state,appended_ms,occurred_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run(e.eventId, e.projectId, e.kind, e.entityId, e.operation, e.state ?? null, now, occurred);
      const seq = Number(added.lastInsertRowid);
      if (!Number.isSafeInteger(seq)) throw new Error('board_sequence_exhausted');
      this.db.query('INSERT INTO board_journal_event_keys(event_id,seq,fingerprint,project_id,appended_ms,occurred_ms) VALUES (?,?,?,?,?,?)')
        .run(e.eventId, seq, fingerprint, e.projectId, now, occurred);
      return seq;
    }).immediate();
  }
  subscribe(id: string, projectId: string) {
    identifier(id); identifier(projectId);
    return this.db.transaction(() => {
      const now = this.now();
      this.prune(now);
      const existing = this.db.query<Pick<Subscription, 'id'>, [string]>(
        'SELECT id FROM board_journal_subscriptions WHERE id=?').get(id);
      if (!existing) {
        this.assertCapacity('subscriptions');
        this.db.query('INSERT INTO board_journal_subscriptions(id,project_id,cutoff_ms,initial_high,prior_prune_generation) VALUES (?,?,?,?,?)')
          .run(id, projectId, now - 7 * DAY, this.high(), this.metadata().prune_generation);
      }
      const s = this.subscription(id);
      if (s.project_id !== projectId) throw new Error('board_subscription_conflict');
      return this.statusOf(s);
    }).immediate();
  }
  private prune(now: number): void {
    const old = now - 30 * DAY;
    const generation = this.metadata().prune_generation + 1;
    const marked = this.db.query('UPDATE board_journal_event_keys SET prune_generation=? WHERE prune_generation=0 AND appended_ms<?').run(generation, old);
    if (marked.changes) {
      this.db.query('DELETE FROM board_journal_events WHERE appended_ms<?').run(old);
      this.db.query('UPDATE board_journal_clock SET prune_generation=? WHERE id=1').run(generation);
    }
  }
  private statusOf(s: Subscription) {
    const oldest = this.db.query<{ ms: number | null }, [string]>('SELECT MIN(appended_ms) AS ms FROM board_journal_events WHERE project_id=?').get(s.project_id)!.ms;
    const expired = this.db.query('SELECT 1 FROM board_journal_event_keys WHERE project_id=? AND prune_generation>? AND seq>? AND (seq>? OR COALESCE(occurred_ms,appended_ms)>=?) LIMIT 1')
      .get(s.project_id, s.prior_prune_generation, s.committed, s.initial_high, s.cutoff_ms) !== null;
    const pruned = this.db.query('SELECT 1 FROM board_journal_event_keys WHERE project_id=? AND prune_generation>0 AND (seq>? OR COALESCE(occurred_ms,appended_ms)>=?) LIMIT 1')
      .get(s.project_id, s.initial_high, s.cutoff_ms) !== null;
    const unknown = this.db.query<{ count: number }, [string, number, number]>(
      'SELECT COUNT(*) AS count FROM board_journal_events WHERE project_id=? AND seq<=? AND occurred_ms IS NULL AND appended_ms>=?')
      .get(s.project_id, s.initial_high, s.cutoff_ms)!.count;
    return {
      initialTimeBasis: 'trusted_mutation_with_reported_legacy_append_fallback' as const,
      retainedInitialEventsWithoutMutationTime: unknown,
      committedSequence: s.committed, cutoffUtc: stamp(s.cutoff_ms), registrationHighWatermark: s.initial_high,
      journalStartedAt: stamp(this.metadata().started_ms), oldestRetainedProjectAppend: oldest === null ? null : stamp(oldest),
      historyCoverage: 'retained_board_changes_only' as const, knownEligiblePruning: pruned,
      journalStartedAfterCutoff: this.metadata().started_ms > s.cutoff_ms, cursorExpired: expired,
    };
  }
  status(id: string) {
    return this.db.transaction(() => {
      this.prune(this.now());
      return this.statusOf(this.subscription(id));
    }).immediate();
  }
  page(id: string, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_board_page_size');
    const result = this.db.transaction(() => {
      this.prune(this.now());
      const s = this.subscription(id);
      const status = this.statusOf(s);
      if (status.cursorExpired) return null;
      const pending = this.db.query<Delivery, [string]>('SELECT id,start_seq,through_seq FROM board_journal_pending WHERE subscription=?').get(id);
      const max = pending?.through_seq ?? this.high();
      const base = pending?.start_seq ?? s.committed;
      const rows = this.db.query<EventRow, [string, number, number, number, number, number]>(
        'SELECT * FROM board_journal_events WHERE project_id=? AND seq>? AND seq<=? AND (seq>? OR COALESCE(occurred_ms,appended_ms)>=?) ORDER BY seq LIMIT ?')
        .all(s.project_id, base, max, s.initial_high, s.cutoff_ms, pending ? 101 : limit + 1);
      const entries = pending ? rows : rows.slice(0, limit);
      const events: BoardJournalEvent[] = entries.map(row => ({
        eventId: row.event_id, projectId: row.project_id, kind: row.kind, entityId: row.entity_id,
        operation: row.operation, ...(row.state === null ? {} : { state: row.state }),
        sequence: row.seq, appendedAt: stamp(row.appended_ms),
        timeBasis: row.occurred_ms === null ? 'append_fallback' : 'trusted_mutation',
        ...(row.occurred_ms === null ? {} : { occurredAt: stamp(row.occurred_ms) }),
        ...(row.seq > s.initial_high && row.occurred_ms !== null && row.occurred_ms < s.cutoff_ms
          ? { earlierMutationPublishedAfterRegistration: true as const } : {}),
      }));
      const throughSequence = pending?.through_seq ?? (rows.length > limit ? entries.at(-1)!.seq : max);
      const deliveryId = pending?.id ?? (throughSequence === s.committed ? null : randomUUID());
      if (deliveryId && !pending) {
        // Reserve the receipt before promising a delivery. Never strand an
        // existing delivery at ACK even when reopened with a lower ceiling.
        this.assertCapacity('receipts');
        this.db.query('INSERT INTO board_journal_pending VALUES (?,?,?,?)').run(id, deliveryId, base, throughSequence);
      }
      return { deliveryId, throughSequence, events, status };
    }).immediate();
    // Commit the prune that establishes expiry before rejecting the caller.
    // A later regressed clock must not revive that cursor or payload.
    if (result === null) throw new Error('board_cursor_expired');
    return result;
  }
  ack(id: string, deliveryId: string): number {
    identifier(deliveryId);
    const result = this.db.transaction(() => {
      this.prune(this.now());
      const s = this.subscription(id);
      const saved = this.db.query<{ committed: number }, [string, string]>('SELECT committed FROM board_journal_receipts WHERE subscription=? AND delivery=?').get(id, deliveryId);
      if (saved) return saved.committed;
      if (this.statusOf(s).cursorExpired) return null;
      const delivery = this.db.query<Delivery, [string, string]>('SELECT id,start_seq,through_seq FROM board_journal_pending WHERE subscription=? AND id=?').get(id, deliveryId);
      if (!delivery || delivery.start_seq !== s.committed || delivery.through_seq <= s.committed) throw new Error('invalid_board_delivery');
      this.db.query('UPDATE board_journal_subscriptions SET committed=? WHERE id=?').run(delivery.through_seq, id);
      this.db.query('INSERT INTO board_journal_receipts VALUES (?,?,?)').run(id, deliveryId, delivery.through_seq);
      this.db.query('DELETE FROM board_journal_pending WHERE subscription=?').run(id);
      return delivery.through_seq;
    }).immediate();
    if (result === null) throw new Error('board_cursor_expired');
    return result;
  }
}
