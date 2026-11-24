import { Database } from 'bun:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { selectSqliteBoardStorage } from './sqlite-board-storage';
import { BoardJournal, type BoardJournalInput } from './board-journal';
import { fileIdentity, type JsonSaveObserver } from './json-save-observer';
import { FileLock } from './filelock';
import type { KanbanCard, KanbanStatus, Work, WorkStatus } from './types';

/**
 * Dedicated, metadata-only Card/Work change sidecar for one local consumer.
 *
 * The application's Board storage stays authoritative. This module never writes
 * its records; it observes `KanbanStore.save()` / `WorkStore.save()` around their own
 * atomic rename and records ID, status enum, soft-delete presence and
 * `updatedAt`. Titles, prompts, results, paths and attachments are never read
 * into the sidecar.
 *
 * Completeness is claimed only where it was observed:
 * - a durable intent row is written before each JSON rename and cleared after
 *   a successful capture; a crash in between leaves it for reconciliation;
 * - a file-identity fence records the JSON file each successful capture saw; a
 *   writer that bypassed capture (older build, direct edit) changes the file
 *   and is detected at the next save, boot reconcile, or consumer read;
 * - both cases are published as explicit coverage gaps. The final state is
 *   still diffed, but intermediate transitions inside a gap may be collapsed.
 * History before the capture baseline is never reconstructed from current state.
 *
 * Inert until `installBoardHistory()` writes `board-history/consumer.json`.
 */

export const BOARD_HISTORY_PROJECT_ID = 'local-board';
export const BOARD_HISTORY_DIR = 'board-history';
const CONSUMER_FILE = 'consumer.json';
const JOURNAL_FILE = 'journal.sqlite';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const SUBSCRIPTION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_STATES: readonly KanbanStatus[] = ['todo', 'in_progress', 'complete', 'done'];
const WORK_STATES: readonly WorkStatus[] = ['active', 'done', 'discarded'];
const MAX_REPORTED_GAPS = 20;
const MAX_STORED_GAPS = 200;

type Kind = 'card' | 'work';
type Presence = 'active' | 'deleted' | 'archived' | 'gone';
type Operation = BoardJournalInput['operation'];
export type GapReason = 'unobserved_writer' | 'interrupted_capture';

/** Minimal projection a store hands over. Never pass a full record. */
export interface BoardEntityObservation {
  id: string;
  status: string;
  updatedAt?: string;
  deleted?: boolean;
}

export interface ConsumerRecord {
  version: 1;
  subscriptionId: string;
  projectId: string;
  tokenSha256: string;
  installedAt: string;
}

export interface CapturedRow {
  entity_id: string;
  presence: Presence;
  state: string;
  updated: string | null;
  /** Count of events published for this entity; separates repeated identical transitions. */
  rev?: number;
}

/** Stable error codes exposed to the consumer. Raw errors never leave the process. */
export type BoardHistoryErrorCode =
  | 'board_history_not_installed'
  | 'board_cursor_expired'
  | 'invalid_board_delivery'
  | 'invalid_board_page_size'
  | 'board_journal_capacity_reached'
  | 'board_history_unavailable';

const PUBLIC_CODES = new Set<string>([
  'board_cursor_expired', 'invalid_board_delivery', 'invalid_board_page_size', 'board_journal_capacity_reached',
]);

export class BoardHistoryError extends Error {
  constructor(readonly code: BoardHistoryErrorCode) { super(code); }
}

function toPublicError(error: unknown): BoardHistoryError {
  if (error instanceof BoardHistoryError) return error;
  const message = error instanceof Error ? error.message : '';
  if (message === 'invalid_board_identifier') return new BoardHistoryError('invalid_board_delivery');
  if (PUBLIC_CODES.has(message)) return new BoardHistoryError(message as BoardHistoryErrorCode);
  return new BoardHistoryError('board_history_unavailable');
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');
const isCanonicalIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,120}$/;
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);
const stamp = (ms: number) => new Date(ms).toISOString();

export function boardHistoryPaths(dataDir: string) {
  const dir = join(dataDir, BOARD_HISTORY_DIR);
  return { dir, consumer: join(dir, CONSUMER_FILE), journal: join(dir, JOURNAL_FILE) };
}

export function readConsumer(path: string): ConsumerRecord | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ConsumerRecord>;
  if (parsed.version !== 1 || typeof parsed.subscriptionId !== 'string' || !SUBSCRIPTION_PATTERN.test(parsed.subscriptionId)
    || parsed.projectId !== BOARD_HISTORY_PROJECT_ID || typeof parsed.tokenSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(parsed.tokenSha256) || typeof parsed.installedAt !== 'string')
    throw new Error('invalid_board_history_consumer');
  return parsed as ConsumerRecord;
}

/** Capture-state tables, beside (not inside) the journal's own tables. */
function openCaptureDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS board_capture_meta (kind TEXT PRIMARY KEY, baseline_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS board_capture_entities (
        kind TEXT NOT NULL, entity_id TEXT NOT NULL, presence TEXT NOT NULL, state TEXT NOT NULL, updated TEXT,
        rev INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(kind, entity_id));
      CREATE TABLE IF NOT EXISTS board_capture_fence (kind TEXT PRIMARY KEY, identity TEXT NOT NULL, captured_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS board_capture_intent (kind TEXT PRIMARY KEY, started_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS board_capture_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT NOT NULL);`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function writeBaseline(db: Database, kind: Kind, entities: readonly BoardEntityObservation[], identity: string, now: number): void {
  db.transaction(() => {
    if (db.query('SELECT 1 FROM board_capture_meta WHERE kind=?').get(kind)) return;
    const insert = db.query('INSERT OR REPLACE INTO board_capture_entities(kind,entity_id,presence,state,updated) VALUES (?,?,?,?,?)');
    const states: readonly string[] = kind === 'card' ? CARD_STATES : WORK_STATES;
    for (const e of entities) {
      if (!isIdentifier(e.id) || !states.includes(e.status)) continue;
      insert.run(kind, e.id, e.deleted ? 'deleted' : 'active', e.status, isCanonicalIso(e.updatedAt) ? e.updatedAt : null);
    }
    db.query('INSERT INTO board_capture_meta(kind,baseline_ms) VALUES (?,?)').run(kind, now);
    db.query('INSERT OR REPLACE INTO board_capture_fence(kind,identity,captured_ms) VALUES (?,?,?)').run(kind, identity, now);
  }).immediate();
}

/**
 * Deterministic so a replayed capture dedupes inside the journal. The prior
 * captured row is part of the key, so the same target reached twice from
 * different predecessors (even within one millisecond) stays two events.
 */
function eventId(kind: Kind, entityId: string, operation: Operation, state: string, timeKey: string, prior: CapturedRow | undefined): string {
  const from = prior ? `${prior.presence}:${prior.state}:${prior.updated ?? ''}:${prior.rev ?? 0}` : 'none';
  return 'bh-' + sha256([kind, entityId, operation, state, timeKey, from].join('|')).slice(0, 48);
}

/**
 * Pure diff: previous captured rows + current observation → journal inputs and next rows.
 *
 * Same-state saves publish `update` only when `updatedAt` strictly advances.
 * An equal (no-op) or regressed (replayed/older snapshot) timestamp publishes
 * nothing and does not move the captured row backwards. A real state change
 * whose timestamp did not advance is published without a mutation time.
 */
export function diffBoardEntities(kind: Kind, previous: readonly CapturedRow[], current: readonly BoardEntityObservation[]) {
  const allowed = (kind === 'card' ? CARD_STATES : WORK_STATES) as readonly string[];
  const before = new Map(previous.map(row => [row.entity_id, row]));
  const seen = new Set<string>();
  const events: BoardJournalInput[] = [];
  const rows: CapturedRow[] = [];
  let skipped = 0;
  const push = (entityId: string, operation: Operation, state: string, occurredAt: string | null, prior: CapturedRow | undefined) => {
    events.push({
      eventId: eventId(kind, entityId, operation, state, occurredAt ?? 'append_fallback', prior),
      projectId: BOARD_HISTORY_PROJECT_ID, kind, entityId, operation,
      state: state as NonNullable<BoardJournalInput['state']>,
      ...(occurredAt ? { occurredAt } : {}),
    });
  };
  for (const entity of current) {
    if (!isIdentifier(entity.id) || seen.has(entity.id)) { skipped++; continue; }
    // Present on disk even if unrepresentable: never report it as archived/deleted.
    seen.add(entity.id);
    if (!allowed.includes(entity.status)) { skipped++; continue; }
    const updated = isCanonicalIso(entity.updatedAt) ? entity.updatedAt : null;
    const presence: Presence = entity.deleted ? 'deleted' : 'active';
    const prior = before.get(entity.id);
    const next: CapturedRow = { entity_id: entity.id, presence, state: entity.status, updated, rev: (prior?.rev ?? 0) + 1 };
    const advanced = updated !== null && (prior?.updated == null || updated > prior.updated);
    const time = advanced || !prior ? updated : null;
    if (!prior || prior.presence === 'gone') {
      push(entity.id, presence === 'deleted' ? 'delete' : 'create', entity.status, updated, prior);
    } else if (prior.presence === 'archived') {
      push(entity.id, presence === 'deleted' ? 'delete' : 'restore', entity.status, time, prior);
    } else if (presence === 'deleted' && prior.presence !== 'deleted') {
      push(entity.id, 'delete', entity.status, time, prior);
    } else if (presence === 'active' && prior.presence === 'deleted') {
      push(entity.id, 'restore', entity.status, time, prior);
    } else if (prior.state !== entity.status) {
      push(entity.id, 'update', entity.status, time, prior);
    } else if (advanced && presence === 'active') {
      push(entity.id, 'update', entity.status, updated, prior);
    } else {
      continue; // no-op, replayed/regressed timestamp, or edits to an already-deleted record
    }
    // Never move the captured time key backwards on a replayed/regressed timestamp.
    const keptUpdated = !advanced && prior?.updated ? prior.updated : null;
    rows.push(keptUpdated ? { ...next, updated: keptUpdated } : next);
  }
  for (const prior of previous) {
    if (seen.has(prior.entity_id) || prior.presence === 'archived' || prior.presence === 'gone') continue;
    if (kind === 'card' && prior.presence === 'active') {
      // A card leaves active.json without a soft-delete stamp only through archiveCards.
      push(prior.entity_id, 'archive', prior.state, null, prior);
      rows.push({ ...prior, presence: 'archived', rev: (prior.rev ?? 0) + 1 });
    } else if (prior.presence === 'active') {
      push(prior.entity_id, 'delete', prior.state, null, prior);
      rows.push({ ...prior, presence: 'gone', rev: (prior.rev ?? 0) + 1 });
    } else {
      // Purge of an already reported soft-delete: nothing new to publish.
      rows.push({ ...prior, presence: 'gone' });
    }
  }
  return { events, rows, skipped };
}

export interface BoardHistoryOptions {
  clock?: () => number;
  /** Lower journal admission ceilings (synthetic tests only). */
  limits?: ConstructorParameters<typeof BoardJournal>[2];
  onCaptureFailure?: (kind: Kind, code: string) => void;
}

interface Opened { journal: BoardJournal; captureDb: Database; consumer: ConsumerRecord }

/**
 * Process-local façade. Cheap when not installed (one `existsSync`). Capture
 * failures never fail a board or Work write; they are reported through
 * `onCaptureFailure` and stay visible to the consumer as a pending intent and,
 * once recovered, as a coverage gap.
 */
export class BoardHistoryService {
  private readonly paths: ReturnType<typeof boardHistoryPaths>;
  private readonly clock: () => number;
  private opened: Opened | null = null;
  /** Kinds whose current save found an intent left by an earlier, unfinished capture. */
  private readonly staleIntent = new Map<Kind, number>();
  /** Kinds whose `prepare` failed for the current save: the fence check could not run. */
  private readonly unprepared = new Set<Kind>();

  constructor(readonly dataDir: string, private readonly options: BoardHistoryOptions = {}) {
    this.paths = boardHistoryPaths(dataDir);
    this.clock = options.clock ?? Date.now;
  }

  isInstalled(): boolean { return existsSync(this.paths.consumer); }

  private open(): Opened | null {
    const consumer = readConsumer(this.paths.consumer);
    if (!consumer) { this.close(); return null; }
    const cached = this.opened;
    if (cached && cached.consumer.subscriptionId === consumer.subscriptionId
      && cached.consumer.tokenSha256 === consumer.tokenSha256) return cached;
    this.close();
    const journal = new BoardJournal(this.paths.journal, this.clock, this.options.limits);
    let captureDb: Database;
    try { captureDb = openCaptureDb(this.paths.journal); } catch (error) { journal.close(); throw error; }
    this.opened = { journal, captureDb, consumer };
    return this.opened;
  }

  close(): void {
    this.opened?.journal.close();
    this.opened?.captureDb.close();
    this.opened = null;
  }

  private report(kind: Kind, error: unknown): void {
    const message = error instanceof Error ? error.message : '';
    this.options.onCaptureFailure?.(kind, PUBLIC_CODES.has(message) ? message : 'board_history_capture_failed');
  }

  /** Records gaps for anything since the last successful capture and leaves a durable intent. */
  private prepareKind(db: Database, kind: Kind, identity: string, now: number): void {
    db.transaction(() => {
      const intent = db.query<{ started_ms: number }, [string]>('SELECT started_ms FROM board_capture_intent WHERE kind=?').get(kind);
      if (intent) {
        // An earlier capture never finished (crash or failure). Keep its start; close it on success.
        this.staleIntent.set(kind, intent.started_ms);
        return;
      }
      this.staleIntent.delete(kind);
      const fence = db.query<{ identity: string; captured_ms: number }, [string]>(
        'SELECT identity,captured_ms FROM board_capture_fence WHERE kind=?').get(kind);
      if (fence && fence.identity !== identity) this.addGap(db, kind, fence.captured_ms, now, 'unobserved_writer');
      db.query('INSERT INTO board_capture_intent(kind,started_ms) VALUES (?,?)').run(kind, now);
    }).immediate();
  }

  private addGap(db: Database, kind: Kind, from: number, to: number, reason: GapReason): void {
    db.query('INSERT INTO board_capture_gaps(kind,from_ms,to_ms,reason) VALUES (?,?,?,?)').run(kind, from, Math.max(from, to), reason);
    db.query('DELETE FROM board_capture_gaps WHERE id <= (SELECT MAX(id) FROM board_capture_gaps) - ?').run(MAX_STORED_GAPS);
  }

  private commitKind(opened: Opened, kind: Kind, entities: readonly BoardEntityObservation[], identity: string, now: number): void {
    const { journal, captureDb } = opened;
    const previous = captureDb.query<CapturedRow, [string]>(
      'SELECT entity_id,presence,state,updated,rev FROM board_capture_entities WHERE kind=?').all(kind);
    const { events, rows } = diffBoardEntities(kind, previous, entities);
    // Append first (idempotent by deterministic eventId), then advance state, fence and intent
    // in one transaction. A crash in between replays the same IDs instead of losing a change.
    for (const event of events) journal.append(event);
    captureDb.transaction(() => {
      const upsert = captureDb.query('INSERT OR REPLACE INTO board_capture_entities(kind,entity_id,presence,state,updated,rev) VALUES (?,?,?,?,?,?)');
      for (const row of rows) upsert.run(kind, row.entity_id, row.presence, row.state, row.updated, row.rev ?? 0);
      const intent = captureDb.query<{ started_ms: number }, [string]>('SELECT started_ms FROM board_capture_intent WHERE kind=?').get(kind);
      const stale = this.staleIntent.get(kind);
      if (intent && stale !== undefined && intent.started_ms === stale) {
        this.addGap(captureDb, kind, stale, now, 'interrupted_capture');
      } else if (!intent && this.unprepared.has(kind)) {
        // No intent and no fence check for this save: anything since the last
        // successful capture is unverifiable, so declare it rather than overwrite the fence.
        const fence = captureDb.query<{ captured_ms: number }, [string]>('SELECT captured_ms FROM board_capture_fence WHERE kind=?').get(kind);
        this.addGap(captureDb, kind, fence?.captured_ms ?? now, now, 'interrupted_capture');
      }
      captureDb.query('DELETE FROM board_capture_intent WHERE kind=?').run(kind);
      captureDb.query('INSERT OR REPLACE INTO board_capture_fence(kind,identity,captured_ms) VALUES (?,?,?)').run(kind, identity, now);
    }).immediate();
    this.staleIntent.delete(kind);
    this.unprepared.delete(kind);
  }

  private hasBaseline(opened: Opened, kind: Kind): boolean {
    return !!opened.captureDb.query('SELECT 1 FROM board_capture_meta WHERE kind=?').get(kind);
  }

  prepare(kind: Kind, identity: string): void {
    if (!this.isInstalled()) return;
    try {
      const opened = this.open();
      if (!opened || !this.hasBaseline(opened, kind)) return;
      this.prepareKind(opened.captureDb, kind, identity, this.clock());
      this.unprepared.delete(kind);
    } catch (error) {
      this.unprepared.add(kind);
      this.report(kind, error);
    }
  }

  /** Called after a successful JSON rename. Never throws. */
  commit(kind: Kind, entities: readonly BoardEntityObservation[], identity: string): void {
    if (!this.isInstalled()) return;
    try {
      const opened = this.open();
      if (!opened) return;
      if (!this.hasBaseline(opened, kind)) {
        // Installed without this kind's baseline: record it; never invent events from current state.
        writeBaseline(opened.captureDb, kind, entities, identity, this.clock());
        return;
      }
      this.commitKind(opened, kind, entities, identity, this.clock());
    } catch (error) { this.report(kind, error); }
  }

  /** Boot / read-time recovery: capture on-disk state if the fence moved or an intent is left. */
  reconcile(kind: Kind, entities: readonly BoardEntityObservation[], identity: string): void {
    if (!this.isInstalled()) return;
    try {
      const opened = this.open();
      if (!opened || !this.hasBaseline(opened, kind)) return;
      const db = opened.captureDb;
      const fence = db.query<{ identity: string }, [string]>('SELECT identity FROM board_capture_fence WHERE kind=?').get(kind);
      const intent = db.query('SELECT 1 FROM board_capture_intent WHERE kind=?').get(kind);
      if (fence?.identity === identity && !intent) return;
      const now = this.clock();
      this.prepareKind(db, kind, identity, now);
      this.commitKind(opened, kind, entities, identity, now);
    } catch (error) { this.report(kind, error); }
  }

  observer<T>(kind: Kind, project: (items: readonly T[]) => BoardEntityObservation[]): JsonSaveObserver<T> {
    return {
      isActive: () => this.isInstalled(),
      prepare: identity => this.prepare(kind, identity),
      commit: (items, identity) => this.commit(kind, project(items), identity),
      reconcile: (items, identity) => this.reconcile(kind, project(items), identity),
    };
  }

  /** Returns the server-fixed subscription ID for a valid consumer bearer token. */
  authenticate(authorization: string | null): string | null {
    try {
      if (!authorization?.startsWith('Bearer ')) return null;
      const consumer = readConsumer(this.paths.consumer);
      if (!consumer) return null;
      const provided = Buffer.from(sha256(authorization.slice(7).trim()), 'hex');
      const expected = Buffer.from(consumer.tokenSha256, 'hex');
      return provided.length === expected.length && timingSafeEqual(provided, expected) ? consumer.subscriptionId : null;
    } catch {
      return null;
    }
  }

  private run<T>(fn: (opened: Opened, subscriptionId: string) => T): T {
    let opened;
    try { opened = this.open(); } catch (error) { throw toPublicError(error); }
    if (!opened) throw new BoardHistoryError('board_history_not_installed');
    try { return fn(opened, opened.consumer.subscriptionId); } catch (error) { throw toPublicError(error); }
  }

  status() {
    return this.run(({ journal, captureDb }, id) => {
      const status = journal.status(id);
      return { subscriptionId: id, status, coverage: captureCoverage(captureDb, status.cutoffUtc) };
    });
  }

  page(limit = 100) {
    return this.run(({ journal, captureDb }, id) => {
      const page = journal.page(id, limit);
      return { subscriptionId: id, ...page, coverage: captureCoverage(captureDb, page.status.cutoffUtc) };
    });
  }

  ack(deliveryId: string) {
    return this.run(({ journal }, id) => ({ subscriptionId: id, committedSequence: journal.ack(id, deliveryId) }));
  }
}

/**
 * What this subscription can and cannot vouch for. `preCaptureGap` is the part
 * of the fixed 7-day window before capture began: no events exist there and
 * none are synthesized. `gaps` are intervals where a writer bypassed capture
 * or a capture was interrupted. `pendingSince` is an unfinished capture.
 * Reads only; also used by the owner status summary on a read-only handle.
 */
export function captureCoverage(db: Database, cutoffUtc: string) {
  const cutoff = Date.parse(cutoffUtc);
  const baseline = db.query<{ ms: number | null; kinds: number }, []>(
    "SELECT MAX(baseline_ms) AS ms, COUNT(*) AS kinds FROM board_capture_meta WHERE kind IN ('card','work')").get()!;
  const started = baseline.kinds === 2 ? baseline.ms : null;
  const gaps = db.query<{ kind: Kind; from_ms: number; to_ms: number; reason: GapReason }, [number, number]>(
    'SELECT kind,from_ms,to_ms,reason FROM board_capture_gaps WHERE to_ms>=? ORDER BY id DESC LIMIT ?').all(cutoff, MAX_REPORTED_GAPS);
  const gapCount = db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM board_capture_gaps WHERE to_ms>=?').get(cutoff)!.n;
  const pending = db.query<{ ms: number | null }, []>('SELECT MIN(started_ms) AS ms FROM board_capture_intent').get()!.ms;
  const preCaptureGap = started !== null && started > cutoff ? { from: cutoffUtc, to: stamp(started) } : null;
  return {
    windowStart: cutoffUtc,
    capturedFrom: started === null ? null : stamp(started),
    preCaptureGap,
    gaps: gaps.reverse().map(g => ({ kind: g.kind, from: stamp(g.from_ms), to: stamp(g.to_ms), reason: g.reason })),
    gapCount,
    pendingSince: pending === null ? null : stamp(pending),
    continuousSinceWindowStart: started !== null && preCaptureGap === null && gapCount === 0 && pending === null,
  };
}

/** Projects raw JSON store records to observations without retaining other fields. */
export function observeCards(cards: readonly Pick<KanbanCard, 'id' | 'status' | 'updatedAt' | 'deletedAt'>[]): BoardEntityObservation[] {
  return cards.map(card => ({ id: card.id, status: card.status, updatedAt: card.updatedAt, deleted: !!card.deletedAt }));
}
export function observeWorks(works: readonly Pick<Work, 'id' | 'status' | 'updatedAt'>[]): BoardEntityObservation[] {
  return works.map(work => ({ id: work.id, status: work.status, updatedAt: work.updatedAt }));
}

function readJsonList(path: string, key: 'cards' | 'works'): unknown[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const list = parsed[key];
  return Array.isArray(list) ? list : [];
}
function asObservations(list: unknown[], withDeleted: boolean): BoardEntityObservation[] {
  const out: BoardEntityObservation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.status !== 'string') continue;
    out.push({ id: r.id, status: r.status, updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
      ...(withDeleted ? { deleted: !!r.deletedAt } : {}) });
  }
  return out;
}

export interface InstallBoardHistoryInput {
  dataDir: string;
  subscriptionId: string;
  token: string;
  clock?: () => number;
}

/**
 * One-time install. Each baseline is read under that store's cross-process
 * file lock (never both at once, so no lock-order inversion). Writes landing
 * between the phases and the consumer file are caught by the fence as a gap.
 * Stores only the token's SHA-256; the plaintext stays with the caller.
 */
export async function installBoardHistory(input: InstallBoardHistoryInput) {
  if (!SUBSCRIPTION_PATTERN.test(input.subscriptionId)) throw new Error('invalid_board_history_subscription');
  if (!TOKEN_PATTERN.test(input.token)) throw new Error('invalid_board_history_token');
  const clock = input.clock ?? Date.now;
  const sqlite = selectSqliteBoardStorage(input.dataDir);
  const paths = boardHistoryPaths(input.dataDir);
  if (existsSync(paths.consumer)) throw new Error('board_history_already_installed');
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const journal = new BoardJournal(paths.journal, clock);
  let status;
  try {
    const captureDb = openCaptureDb(paths.journal);
    try {
      const phases: [Kind, string, string, 'cards' | 'works'][] = [
        ['card', '.board.json.lock', 'active.json', 'cards'],
        ['work', '.works.json.lock', 'works.json', 'works'],
      ];
      if(sqlite) {
        const storage=sqlite;
        await storage.write(async()=>{
          for(const [kind,,,key] of phases) {
            const items = storage.readDocument<Record<string, unknown[]>>(key)?.[key] ?? [];
            writeBaseline(captureDb,kind,asObservations(items,kind==='card'),storage.identity(key),clock());
          }
        });
      } else {
        for (const [kind, lock, file, key] of phases) {
          const path = join(input.dataDir, file);
          await new FileLock(join(input.dataDir, lock)).withLock(async () => {
            writeBaseline(captureDb, kind, asObservations(readJsonList(path, key), kind === 'card'), fileIdentity(path), clock());
          });
        }
      }
    } finally { captureDb.close(); }
    status = journal.subscribe(input.subscriptionId, BOARD_HISTORY_PROJECT_ID);
  } finally { journal.close(); }
  chmodSync(paths.journal, 0o600);
  const record: ConsumerRecord = {
    version: 1, subscriptionId: input.subscriptionId, projectId: BOARD_HISTORY_PROJECT_ID,
    tokenSha256: sha256(input.token), installedAt: new Date(clock()).toISOString(),
  };
  const tmp = `${paths.consumer}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    linkSync(tmp, paths.consumer); // EEXIST if a concurrent install won
  } finally { rmSync(tmp, { force: true }); }
  return { subscriptionId: input.subscriptionId, projectId: BOARD_HISTORY_PROJECT_ID, status };
}
