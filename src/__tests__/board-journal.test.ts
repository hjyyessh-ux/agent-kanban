import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { BoardJournal, type BoardJournalInput } from '../core/board-journal';
import { withTempDir } from './setup';

const DAY = 86400000;
const initial = Date.UTC(2026, 10, 19, 1, 2, 3);
const event = (eventId: string, projectId = 'project-one'): BoardJournalInput =>
  ({ eventId, projectId, entityId: 'card-one', kind: 'card', operation: 'update', state: 'todo' });

test('frozen inclusive backfill, durable page ACK and append identity, with regressed clocks', async () => withTempDir(async dir => {
  const path = join(dir, 'board.sqlite');
  let clock = initial - 8 * DAY;
  let journal = new BoardJournal(path, () => clock);
  try {
    expect(journal.append(event('older'))).toBe(1);
    clock = initial - 7 * DAY;
    expect(journal.append(event('inclusive'))).toBe(2);
    clock = initial - DAY;
    expect(journal.append(event('other-project', 'project-two'))).toBe(3);
    expect(journal.append(event('recent'))).toBe(4);
    clock = initial - 8 * DAY;
    expect(journal.append(event('higher-seq-older-clock'))).toBe(5);
    clock = initial;
    const s = journal.subscribe('reader', 'project-one');
    expect(s).toMatchObject({ committedSequence: 0, registrationHighWatermark: 5, cutoffUtc: new Date(initial - 7 * DAY).toISOString() });
    clock = initial + DAY;
    expect(journal.subscribe('reader', 'project-one')).toEqual(s);
    const first = journal.page('reader', 1);
    expect(first.events.map(e => e.eventId)).toEqual(['inclusive']);
    expect(first.throughSequence).toBe(2);
    expect(first.status.retainedInitialEventsWithoutMutationTime).toBe(2);
    expect(first.events[0].timeBasis).toBe('append_fallback');
    journal.close();
    journal = new BoardJournal(path, () => clock);
    expect(journal.page('reader', 100)).toEqual(first);
    expect(journal.ack('reader', first.deliveryId!)).toBe(2);
    const second = journal.page('reader');
    expect(second.events.map(e => e.eventId)).toEqual(['recent']);
    expect(journal.ack('reader', second.deliveryId!)).toBe(5);
    expect(journal.ack('reader', first.deliveryId!)).toBe(2);
    expect(journal.status('reader').committedSequence).toBe(5);
    expect(journal.page('reader')).toMatchObject({ deliveryId: null, events: [] });
    clock = initial - 9 * DAY;
    expect(journal.append(event('new-regressed'))).toBe(6);
    expect(journal.append(event('new-regressed'))).toBe(6);
    expect(journal.page('reader').events.map(e => e.eventId)).toEqual(['new-regressed']);
    expect(() => journal.append({ ...event('new-regressed'), state: 'complete' })).toThrow('board_event_id_conflict');
    expect(() => journal.append({ ...event('invalid'), body: 'not an accepted field' } as BoardJournalInput)).toThrow('unexpected_board_field');
  } finally { journal.close(); }
}));

test('TTL truthfully exposes an expired unread range without dropping a newer retained sequence', async () => withTempDir(async dir => {
  let clock = initial;
  const journal = new BoardJournal(join(dir, 'board.sqlite'), () => clock);
  try {
    const start = journal.subscribe('unread', 'project-one');
    expect(start.journalStartedAfterCutoff).toBe(true);
    expect(start.oldestRetainedProjectAppend).toBeNull();
    clock = initial + DAY;
    journal.append(event('retained'));
    clock = initial;
    journal.append(event('expired-higher-seq'));
    const first = journal.page('unread', 1);
    clock = initial + 30 * DAY + 1;
    expect(journal.status('unread')).toMatchObject({ knownEligiblePruning: true, cursorExpired: true,
      oldestRetainedProjectAppend: new Date(initial + DAY).toISOString() });
    expect(() => journal.page('unread')).toThrow('board_cursor_expired');
    expect(() => journal.ack('unread', first.deliveryId!)).toThrow('board_cursor_expired');
    expect(journal.append(event('expired-higher-seq'))).toBe(2);
    // A new reader gets a fresh seven-day boundary and no manufactured history.
    const recovery = journal.subscribe('fresh', 'project-one');
    expect(recovery).toMatchObject({ cursorExpired: false, historyCoverage: 'retained_board_changes_only' });
    const empty = journal.page('fresh');
    expect(empty.events).toEqual([]);
    expect(journal.ack('fresh', empty.deliveryId!)).toBe(2);
    // A new subscriber observing an earlier wall clock should still see the retained
    // lower sequence and a truthful availability warning about the missing newer sequence.
    clock = initial + 2 * DAY;
    expect(journal.subscribe('fresh-regressed', 'project-one')).toMatchObject({
      cursorExpired: false, knownEligiblePruning: true,
    });
    expect(journal.page('fresh-regressed').events.map(e => e.eventId)).toEqual(['retained']);
  } finally { journal.close(); }
}));

test('TTL loss in another project does not invalidate this project checkpoint', async () => withTempDir(async dir => {
  let clock = initial;
  const journal = new BoardJournal(join(dir, 'board.sqlite'), () => clock);
  try {
    journal.subscribe('reader', 'project-one');
    journal.append(event('foreign', 'project-two'));
    clock = initial + DAY;
    const work = { ...event('work-change'), entityId: 'work-one', kind: 'work', state: 'discarded' } as const;
    journal.append(work);
    clock = initial + 30 * DAY + 1;
    expect(journal.status('reader')).toMatchObject({ knownEligiblePruning: false, cursorExpired: false });
    const page = journal.page('reader');
    expect(page.events[0]).toMatchObject(work);
    expect(journal.ack('reader', page.deliveryId!)).toBe(2);
    expect(() => journal.subscribe('reader', 'project-two')).toThrow('board_subscription_conflict');
    expect(journal.append({ ...event('card-done'), state: 'done' })).toBe(3);
    expect(() => journal.append({ ...event('wrong-kind'), state: 'discarded' })).toThrow('invalid_board_enumeration');
    expect(() => journal.append({ ...event('unknown-state'), state: 'opaque' } as unknown as BoardJournalInput))
      .toThrow('invalid_board_enumeration');
  } finally { journal.close(); }
}));

test('late initial publication uses trusted mutation time while later deliveries follow sequence', async () => withTempDir(async dir => {
  let clock = initial;
  const journal = new BoardJournal(join(dir, 'board.sqlite'), () => clock);
  try {
    const oldTime = new Date(initial - 8 * DAY).toISOString();
    journal.append({ ...event('late-before-registration'), occurredAt: oldTime });
    journal.append({ ...event('on-time'), occurredAt: new Date(initial - DAY).toISOString() });
    journal.subscribe('reader', 'project-one');
    const first = journal.page('reader');
    expect(first.events.map(e => e.eventId)).toEqual(['on-time']);
    expect(first.events[0].appendedAt).not.toBe(first.events[0].occurredAt);
    journal.ack('reader', first.deliveryId!);
    clock += DAY;
    journal.append({ ...event('late-after-registration'), occurredAt: oldTime });
    expect(journal.page('reader').events[0]).toMatchObject({ eventId: 'late-after-registration', occurredAt: oldTime, timeBasis: 'trusted_mutation', earlierMutationPublishedAfterRegistration: true });
  } finally { journal.close(); }
}));

test('capacity denies only new admissions and reserves ACK before issuing a page across connections', async () => withTempDir(async dir => {
  let clock = initial;
  const path = join(dir, 'bounded.sqlite');
  const limits = { eventKeys: 2, subscriptions: 2, receipts: 1 };
  const writer = new BoardJournal(path, () => clock, limits);
  const reader = new BoardJournal(path, () => clock, limits);
  try {
    const first = writer.subscribe('first', 'project-one');
    reader.subscribe('second', 'project-one');
    expect(() => reader.subscribe('third', 'project-one')).toThrow('board_journal_capacity_reached');
    expect(reader.subscribe('first', 'project-one')).toEqual(first);
    expect(writer.append(event('one'))).toBe(1);
    expect(writer.append(event('two'))).toBe(2);
    expect(() => reader.append(event('three'))).toThrow('board_journal_capacity_reached');
    expect(reader.append(event('one'))).toBe(1);
    expect(() => reader.append({ ...event('one'), state: 'done' })).toThrow('board_event_id_conflict');
    const page = writer.page('first');
    expect(page.events.map(e => e.eventId)).toEqual(['one', 'two']);
    expect(() => reader.page('second')).toThrow('board_journal_capacity_reached');
    expect(reader.status('second').committedSequence).toBe(0);
    expect(reader.page('first')).toEqual(page);
    expect(reader.ack('first', page.deliveryId!)).toBe(2);
    expect(writer.ack('first', page.deliveryId!)).toBe(2);
    expect(writer.page('first')).toMatchObject({ deliveryId: null, events: [] });
    expect(() => writer.page('second')).toThrow('board_journal_capacity_reached');
    expect(writer.status('second').committedSequence).toBe(0);
    clock += 31 * DAY;
    expect(reader.status('second').cursorExpired).toBe(true);
    expect(writer.append(event('one'))).toBe(1); // expired payload never revives
    expect(writer.ack('first', page.deliveryId!)).toBe(2);
  } finally { reader.close(); writer.close(); }
}));

test('new append reclaims expired payload even without a subscribing reader', async () => withTempDir(async dir => {
  const path = join(dir, 'producer.sqlite');
  let clock = initial;
  const journal = new BoardJournal(path, () => clock, { eventKeys: 2 });
  try {
    expect(journal.append(event('old-payload'))).toBe(1);
    clock += 31 * DAY;
    expect(journal.append(event('recent-payload'))).toBe(2);
    // Regress the clock before reading so subscription-side pruning alone
    // would not have removed the first event.
    clock = initial + DAY;
    const s = journal.subscribe('reader', 'project-one');
    expect(s.knownEligiblePruning).toBe(true);
    expect(journal.page('reader').events.map(row => row.eventId)).toEqual(['recent-payload']);
  } finally { journal.close(); }
}));

test('a smaller reopened cap preserves over-capacity receipts and honors the page already promised', async () => withTempDir(async dir => {
  const path = join(dir, 'reopened.sqlite');
  const journal = new BoardJournal(path, () => initial, { receipts: 2 });
  let old: string;
  let promised: ReturnType<BoardJournal['page']>;
  try {
    journal.subscribe('reader', 'project-one');
    journal.append(event('one'));
    old = journal.page('reader').deliveryId!;
    expect(journal.ack('reader', old)).toBe(1);
    journal.append(event('two'));
    promised = journal.page('reader');
  } finally { journal.close(); }
  const smaller = new BoardJournal(path, () => initial, { receipts: 1 });
  try {
    expect(smaller.page('reader')).toEqual(promised);
    expect(smaller.ack('reader', promised.deliveryId!)).toBe(2);
    expect(smaller.ack('reader', old)).toBe(1);
    expect(smaller.status('reader').committedSequence).toBe(2);
    smaller.append(event('three'));
    expect(() => smaller.page('reader')).toThrow('board_journal_capacity_reached');
    expect(smaller.status('reader').committedSequence).toBe(2);
  } finally { smaller.close(); }
}));

test('local capacity diagnostics expose threshold and saturation without evicting state', async () => withTempDir(async dir => {
  const path = join(dir, 'diagnostics.sqlite');
  const limits = { eventKeys: 5, receipts: 5 };
  let clock = initial;
  let journal = new BoardJournal(path, () => clock, limits);
  try {
    journal.subscribe('reader', 'project-one');
    expect(journal.capacityDiagnostics().eventKeys).toMatchObject({ remaining: 5, condition: 'normal' });
    for (let i = 0; i < 4; i++) journal.append(event('event-' + i));
    expect(journal.capacityDiagnostics().eventKeys).toMatchObject({ used: 4, remaining: 1, condition: 'near_capacity' });
    journal.append(event('event-4'));
    const page = journal.page('reader');
    expect(journal.capacityDiagnostics()).toMatchObject({
      eventKeys: { used: 5, remaining: 0, condition: 'saturated' },
      receipts: { used: 0, reserved: 1, ceiling: 5, remaining: 4, condition: 'normal' },
    });
    expect(journal.capacityDiagnostics().sqliteLogicalBytes).toBeGreaterThan(0);
    journal.ack('reader', page.deliveryId!);
    clock += 31 * DAY;
    journal.status('reader'); // expires payloads, not durable retry identities
    journal.close();
    journal = new BoardJournal(path, () => clock, limits);
    expect(journal.capacityDiagnostics()).toMatchObject({
      eventKeys: { used: 5, remaining: 0, condition: 'saturated' },
      receipts: { used: 1, reserved: 0, remaining: 4, condition: 'normal' },
    });
    expect(journal.ack('reader', page.deliveryId!)).toBe(5);
    expect(journal.page('reader').events).toEqual([]);
  } finally { journal.close(); }
}));

test('explicit bounded WAL checkpoint respects a busy reader and preserves a pending page and its ACK after restart', async () => withTempDir(async dir => {
  const path = join(dir, 'wal.sqlite');
  const journal = new BoardJournal(path, () => initial, { eventKeys: 20 });
  const reader = new Database(path, { readonly: true, strict: true });
  let page: ReturnType<BoardJournal['page']>;
  let firstReceipt: string;
  try {
    journal.subscribe('reader', 'project-one');
    journal.append(event('first'));
    firstReceipt = journal.page('reader').deliveryId!;
    expect(journal.ack('reader', firstReceipt)).toBe(1);
    reader.exec('BEGIN');
    expect(reader.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM board_journal_events').get()?.count).toBe(1);
    journal.append(event('second'));
    page = journal.page('reader');
    const busy = journal.checkpointStorage();
    expect(busy.outcome).toBe('busy');
    expect(busy.beforeWalBytes).toBeGreaterThan(0);
    expect(busy.afterWalBytes).toBeGreaterThan(0);
    expect(reader.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM board_journal_events').get()?.count).toBe(1);
    reader.exec('COMMIT');
    const compacted = journal.checkpointStorage();
    expect(compacted.outcome).toBe('checkpointed');
    expect(compacted.remainingLogFrames).toBe(0);
    expect(compacted.afterWalBytes).toBe(0);
    expect(compacted.databaseBytes).toBeGreaterThan(0);
  } finally { reader.close(); journal.close(); }
  const reopened = new BoardJournal(path, () => initial);
  try {
    expect(reopened.page('reader')).toEqual(page);
    expect(reopened.ack('reader', firstReceipt)).toBe(1);
    expect(reopened.ack('reader', page.deliveryId!)).toBe(2);
    expect(reopened.page('reader').events).toEqual([]);
    expect(reopened.append(event('first'))).toBe(1);
  } finally { reopened.close(); }
}));

for (const operation of ['page', 'ack'] as const) {
  test('an expired ' + operation + ' commits pruning even if the clock regresses after the rejection', () => withTempDir(async dir => {
    const path = join(dir, 'durable-expiry.sqlite');
    let clock = initial;
    let journal = new BoardJournal(path, () => clock);
    try {
      journal.subscribe('reader', 'project-one');
      journal.append(event('unread'));
      const pending = journal.page('reader');
      clock += 31 * DAY;
      expect(() => operation === 'page' ? journal.page('reader') : journal.ack('reader', pending.deliveryId!))
        .toThrow('board_cursor_expired');
      // No successful status/append between failure and clock regression.
      journal.close();
      clock = initial + DAY;
      journal = new BoardJournal(path, () => clock);
      expect(() => journal.page('reader')).toThrow('board_cursor_expired');
      expect(() => journal.ack('reader', pending.deliveryId!)).toThrow('board_cursor_expired');
      expect(journal.status('reader')).toMatchObject({ committedSequence: 0, cursorExpired: true, knownEligiblePruning: true });
      expect(journal.append(event('unread'))).toBe(1); // old ID still deduped
    } finally { journal.close(); }
  }));
}
