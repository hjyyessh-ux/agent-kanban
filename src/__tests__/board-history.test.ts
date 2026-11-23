import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import type { KanbanCard } from '../core/types';
import {
  BoardHistoryService, diffBoardEntities, installBoardHistory, observeCards, observeWorks, type CapturedRow,
} from '../core/board-history';
import type { JsonSaveObserver } from '../core/json-save-observer';
import { handleBoardHistoryRequest, MAX_ACK_BODY_BYTES, readCappedBody } from '../server/board-history-routes';
import { BoardJournal } from '../core/board-journal';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

// Synthetic fixtures only. The secret-looking strings exist to prove they never leave the board files.
const TOKEN = 'dot_synthetic_token_0123456789abcdefABCDEF';
const PEER = 'peer_synthetic_token_0123456789abcdefABCDEF';
const SECRET_TITLE = 'SYNTHETIC-TITLE-must-not-leak';
const SECRET_BODY = 'SYNTHETIC-BODY /synthetic-home/private/path synthetic-key';
const LOCAL = '127.0.0.1';

function wire(dir: string, limits?: { eventKeys?: number }) {
  const store = new KanbanStore(dir);
  const workStore = new WorkStore(dir);
  const failures: string[] = [];
  const history = new BoardHistoryService(dir, { limits, onCaptureFailure: (_, code) => failures.push(code) });
  store.setChangeObserver(history.observer('card', observeCards));
  workStore.setChangeObserver(history.observer('work', observeWorks));
  return { store, workStore, history, failures };
}
const install = (dir: string) => installBoardHistory({ dataDir: dir, subscriptionId: 'dot', token: TOKEN });
const ops = (events: { kind: string; operation: string; state?: string }[]) => events.map(e => `${e.kind}:${e.operation}:${e.state}`);

const auth = { authorization: `Bearer ${TOKEN}` };
const req = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:24680${path}`, init);
/** `clientAddress: null` models a request whose peer address the server could not determine. */
async function call(history: BoardHistoryService, path: string, init: RequestInit = {}, clientAddress: string | null = LOCAL) {
  const r = req(path, init);
  const res = await handleBoardHistoryRequest(r, new URL(r.url), { service: history, clientAddress: clientAddress ?? undefined });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('not installed: stores behave exactly as before and nothing is created', () => withTempDir(async dir => {
  const { store, workStore, history, failures } = wire(dir);
  const card = await store.createCard({ title: SECRET_TITLE, description: SECRET_BODY });
  await store.updateCard(card.id, { status: 'in_progress' });
  await workStore.createWork({ title: SECRET_TITLE });
  await store.reconcileChangeObserver();
  expect(existsSync(join(dir, 'board-history'))).toBe(false);
  expect(failures).toEqual([]);
  expect((await call(history, '/api/board-history/events', { headers: auth })).status).toBe(404);
  expect((await store.getCard(card.id))?.status).toBe('in_progress');
}));

test('install publishes no synthetic history and declares the pre-capture part of the 7-day window', () => withTempDir(async dir => {
  const { store, history } = wire(dir);
  await store.createCard({ title: SECRET_TITLE, description: SECRET_BODY });
  const result = await install(dir);
  expect(result.status).toMatchObject({ committedSequence: 0, journalStartedAfterCutoff: true, historyCoverage: 'retained_board_changes_only' });
  expect(statSync(join(dir, 'board-history', 'consumer.json')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'board-history', 'consumer.json'), 'utf-8')).not.toContain(TOKEN);
  const page = history.page();
  expect(page.events).toEqual([]);
  const capturedFrom = page.coverage.capturedFrom;
  if (capturedFrom === null) throw new Error('expected both capture baselines');
  expect(page.coverage.preCaptureGap).toEqual({ from: page.status.cutoffUtc, to: capturedFrom });
  expect(page.coverage).toMatchObject({ gapCount: 0, pendingSince: null, continuousSinceWindowStart: false });
  // The window is fixed at registration: 7 days before install.
  expect(Date.parse(page.coverage.capturedFrom!) - Date.parse(page.status.cutoffUtc)).toBeGreaterThanOrEqual(7 * 86400000 - 5000);
}));

test('only trusted journal appends already inside the fixed 7-day window are replayed at install', () => withTempDir(async dir => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'board-history'), { recursive: true });
  const path = join(dir, 'board-history', 'journal.sqlite');
  const now = Date.now();
  let clock = now - 8 * 86400000;
  const earlier = new BoardJournal(path, () => clock);
  const base = { projectId: 'local-board', kind: 'card', entityId: 'synthetic-card', operation: 'update' } as const;
  earlier.append({ ...base, eventId: 'older-than-window', state: 'todo', occurredAt: new Date(clock).toISOString() });
  clock = now - 2 * 86400000;
  earlier.append({ ...base, eventId: 'inside-window', state: 'in_progress', occurredAt: new Date(clock).toISOString() });
  earlier.close();
  await install(dir);
  const page = wire(dir).history.page();
  expect(page.events.map(e => e.eventId)).toEqual(['inside-window']);
  expect(page.events[0].timeBasis).toBe('trusted_mutation');
  // Capture itself only starts at install; the rest of the window is declared, not filled in.
  expect(page.coverage.preCaptureGap).not.toBeNull();
}));

test('lifecycle and same-state updates are published; no-op and replayed saves are not', () => withTempDir(async dir => {
  const { store, workStore, history, failures } = wire(dir);
  const before = await store.createCard({ title: SECRET_TITLE, description: SECRET_BODY });
  await install(dir);
  // ISO timestamps have millisecond resolution; space same-state edits so updatedAt advances.
  await Bun.sleep(3);
  await store.updateCard(before.id, { title: 'edited title' }); // same state, newer updatedAt
  await store.save(await store.load()); // unintended no-op save
  const created = await store.createCard({ title: SECRET_TITLE, description: SECRET_BODY });
  await store.updateCard(created.id, { status: 'in_progress' });
  await store.updateCard(before.id, { status: 'done' });
  await store.archiveCards([before.id]);
  await store.unarchiveCards([before.id]);
  await store.deleteCard(created.id);
  await store.restoreCard(created.id);
  await store.deleteCard(created.id);
  await store.purgeDeletedCards();
  const work = await workStore.createWork({ title: SECRET_TITLE });
  await Bun.sleep(3);
  await workStore.updateWork(work.id, { title: 'renamed' }); // same state, newer updatedAt
  await workStore.updateWork(work.id, { status: 'discarded' });
  await workStore.deleteWork(work.id);

  const page = history.page();
  expect(failures).toEqual([]);
  const named = page.events.map(e => [e.kind, e.entityId === before.id ? 'before' : e.entityId === created.id ? 'created' : 'work', e.operation, e.state]);
  expect(named).toEqual([
    ['card', 'before', 'update', 'todo'],
    ['card', 'created', 'create', 'todo'],
    ['card', 'created', 'update', 'in_progress'],
    ['card', 'before', 'update', 'done'],
    ['card', 'before', 'archive', 'done'],
    ['card', 'before', 'restore', 'done'],
    ['card', 'created', 'delete', 'in_progress'],
    ['card', 'created', 'restore', 'in_progress'],
    ['card', 'created', 'delete', 'in_progress'],
    ['work', 'work', 'create', 'active'],
    ['work', 'work', 'update', 'active'],
    ['work', 'work', 'update', 'discarded'],
    ['work', 'work', 'delete', 'discarded'],
  ]);
  for (const e of page.events) {
    if (e.operation === 'archive' || (e.kind === 'work' && e.operation === 'delete')) expect(e.timeBasis).toBe('append_fallback');
    if (e.operation === 'create') expect(e.timeBasis).toBe('trusted_mutation');
    expect(Object.keys(e).every(k => ['eventId', 'projectId', 'kind', 'entityId', 'operation', 'state', 'occurredAt',
      'sequence', 'appendedAt', 'timeBasis', 'earlierMutationPublishedAfterRegistration'].includes(k))).toBe(true);
    expect(e.projectId).toBe('local-board');
  }
  expect(page.coverage).toMatchObject({ gapCount: 0, pendingSince: null });
  const db = join(dir, 'board-history', 'journal.sqlite');
  const bytes = [db, `${db}-wal`].filter(existsSync).map(f => readFileSync(f).toString('latin1')).join('');
  expect(bytes).not.toContain('SYNTHETIC');
  expect(JSON.stringify(page)).not.toContain('synthetic-home');
}));

test('diff rejects replayed/regressed timestamps, invalid records and duplicate IDs', () => {
  const prior: CapturedRow[] = [{ entity_id: 'a', presence: 'active', state: 'todo', updated: '2026-11-20T00:00:00.000Z' }];
  const at = (updatedAt: string, status = 'todo') => [{ id: 'a', status, updatedAt }];
  expect(diffBoardEntities('card', prior, at('2026-11-20T00:00:00.000Z')).events).toEqual([]); // equal → no-op
  expect(diffBoardEntities('card', prior, at('2026-11-19T00:00:00.000Z')).events).toEqual([]); // regressed → replay
  expect(diffBoardEntities('card', prior, at('not-a-time')).events).toEqual([]);
  const advanced = diffBoardEntities('card', prior, at('2026-11-21T00:00:00.000Z'));
  expect(advanced.events).toMatchObject([{ operation: 'update', state: 'todo', occurredAt: '2026-11-21T00:00:00.000Z' }]);
  // A real state change with a regressed clock is published, without a mutation time,
  // and the captured time key is not moved backwards.
  const regressedChange = diffBoardEntities('card', prior, at('2026-11-19T00:00:00.000Z', 'done'));
  expect(regressedChange.events).toHaveLength(1);
  expect(regressedChange.events[0].occurredAt).toBeUndefined();
  expect(regressedChange.rows[0].updated).toBe('2026-11-20T00:00:00.000Z');
  const invalid = diffBoardEntities('card', [], [
    { id: '../x', status: 'todo' }, { id: 'b', status: 'opaque' }, { id: 'c', status: 'todo' }, { id: 'c', status: 'done' },
  ]);
  expect(invalid.events.map(e => e.entityId)).toEqual(['c']);
  expect(invalid.skipped).toBe(3);
});

test('crash between JSON rename and capture: intent is visible, then reconciled with a declared gap', () => withTempDir(async dir => {
  const { store, history } = wire(dir);
  await install(dir);
  const card = await store.createCard({ title: 't', description: 'd' });
  history.ack(history.page().deliveryId!);
  // A writer whose process dies after the rename: prepare ran, commit never did.
  const real = history.observer<KanbanCard>('card', observeCards);
  const crashing = new KanbanStore(dir);
  const dying: JsonSaveObserver<KanbanCard> = { ...real, commit: () => { throw new Error('process died'); } };
  crashing.setChangeObserver(dying);
  await crashing.updateCard(card.id, { status: 'in_progress' });
  expect((await store.getCard(card.id))?.status).toBe('in_progress'); // JSON write intact
  const pending = history.page();
  expect(pending.events).toEqual([]);
  expect(pending.coverage.pendingSince).not.toBeNull();
  expect(pending.coverage.continuousSinceWindowStart).toBe(false);
  // Boot/read-time reconcile captures it once and closes the interval as a gap.
  await store.reconcileChangeObserver();
  await store.reconcileChangeObserver(); // idempotent: nothing more
  const recovered = history.page();
  expect(ops(recovered.events)).toEqual(['card:update:in_progress']);
  expect(recovered.coverage).toMatchObject({ pendingSince: null, gapCount: 1 });
  expect(recovered.coverage.gaps[0]).toMatchObject({ kind: 'card', reason: 'interrupted_capture' });
}));

test('replaying the same capture after a crash between append and state commit adds nothing', () => withTempDir(async dir => {
  const { store, history } = wire(dir);
  await install(dir);
  const { Database } = await import('bun:sqlite');
  const path = join(dir, 'board-history', 'journal.sqlite');
  const db = new Database(path, { readonly: true, strict: true });
  const before = db.query<CapturedRow, [string]>('SELECT entity_id,presence,state,updated FROM board_capture_entities WHERE kind=?').all('card');
  db.close();
  await store.createCard({ title: 't', description: 'd' });
  const first = history.page();
  const { BoardJournal } = await import('../core/board-journal');
  const journal = new BoardJournal(path);
  const replayed = diffBoardEntities('card', before, observeCards((await store.load()).cards)).events.map(e => journal.append(e));
  journal.close();
  expect(replayed).toEqual(first.events.map(e => e.sequence));
  expect(history.page()).toEqual(first);
}));

test('a writer without the observer (older build) is fenced: change captured, interval declared', () => withTempDir(async dir => {
  const { store, history } = wire(dir);
  await install(dir);
  const card = await store.createCard({ title: 't', description: 'd' });
  history.ack(history.page().deliveryId!);
  const legacy = new KanbanStore(dir); // no observer: same lock, same file, no capture
  await legacy.updateCard(card.id, { status: 'complete' });
  await store.reconcileChangeObserver(); // as on boot or before a consumer read
  const page = history.page();
  expect(ops(page.events)).toEqual(['card:update:complete']);
  expect(page.coverage.gaps).toMatchObject([{ kind: 'card', reason: 'unobserved_writer' }]);
  expect(page.coverage.continuousSinceWindowStart).toBe(false);
  // The next ordinary save sees a fence that matches again: no further gap.
  await store.updateCard(card.id, { status: 'done' });
  expect(history.status().coverage.gapCount).toBe(1);
}));

test('a broken sidecar never fails a board or Work write and is declared once it recovers', () => withTempDir(async dir => {
  const { store, workStore, history, failures } = wire(dir);
  await install(dir);
  const consumer = join(dir, 'board-history', 'consumer.json');
  const saved = readFileSync(consumer, 'utf-8');
  writeFileSync(consumer, '{ not json');
  const card = await store.createCard({ title: 't', description: 'd' });
  await store.updateCard(card.id, { status: 'in_progress' });
  await workStore.createWork({ title: 'w' });
  expect((await store.getCard(card.id))?.status).toBe('in_progress');
  expect(failures.length).toBeGreaterThan(0);
  expect(new Set(failures)).toEqual(new Set(['board_history_capture_failed']));
  expect((await call(history, '/api/board-history/events', { headers: auth })).status).toBe(401);
  writeFileSync(consumer, saved);
  await store.reconcileChangeObserver();
  await workStore.reconcileChangeObserver();
  const page = history.page();
  // Final states only (intermediate todo→in_progress collapsed), and the gap says so.
  expect(ops(page.events).sort()).toEqual(['card:create:in_progress', 'work:create:active']);
  expect(page.coverage.gaps.map(g => `${g.kind}:${g.reason}`).sort()).toEqual(['card:unobserved_writer', 'work:unobserved_writer']);
}));

test('ACK is idempotent, survives restart, and resumes from the committed checkpoint', () => withTempDir(async dir => {
  let wired = wire(dir);
  await install(dir);
  const card = await wired.store.createCard({ title: 't', description: 'd' });
  await wired.store.updateCard(card.id, { status: 'in_progress' });
  const first = wired.history.page(1);
  expect(first.events).toHaveLength(1);
  wired.history.close();
  wired = wire(dir); // restart before ACK: the same delivery is served again
  expect(wired.history.page(1)).toEqual(first);
  expect(() => wired.history.ack('bogus-delivery')).toThrow('invalid_board_delivery');
  expect(wired.history.ack(first.deliveryId!).committedSequence).toBe(first.throughSequence);
  expect(wired.history.ack(first.deliveryId!).committedSequence).toBe(first.throughSequence);
  wired.history.close();
  wired = wire(dir); // restart after ACK: only the rest
  const second = wired.history.page();
  expect(ops(second.events)).toEqual(['card:update:in_progress']);
  wired.history.ack(second.deliveryId!);
  expect(wired.history.page()).toMatchObject({ deliveryId: null, events: [] });
}));

test('concurrent saves across two store instances record each transition once', () => withTempDir(async dir => {
  const a = wire(dir);
  const b = wire(dir);
  await install(dir);
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? a : b).store.createCard({ title: `c${i}`, description: 'd' })));
  const page = a.history.page();
  expect(page.events.filter(e => e.operation === 'create')).toHaveLength(10);
  expect(new Set(page.events.map(e => e.entityId)).size).toBe(10);
  expect(page.coverage.gapCount).toBe(0);
  expect([...a.failures, ...b.failures]).toEqual([]);
}));

test('capacity saturation: fixed code, board write succeeds, change kept pending and recovered later', () => withTempDir(async dir => {
  const { store, history, failures } = wire(dir, { eventKeys: 1 });
  await install(dir);
  const first = await store.createCard({ title: 't', description: 'd' });
  const second = await store.createCard({ title: 't', description: 'd' });
  expect((await store.getCards()).map(c => c.id)).toEqual([first.id, second.id]);
  expect(failures).toEqual(['board_journal_capacity_reached']);
  const served = history.page();
  expect(served.events.map(e => e.entityId)).toEqual([first.id]);
  expect(served.coverage.pendingSince).not.toBeNull();
  history.ack(served.deliveryId!);
  history.close();
  const roomy = wire(dir);
  await roomy.store.reconcileChangeObserver();
  const page = roomy.history.page();
  expect(page.events.map(e => `${e.entityId === second.id ? 'second' : 'first'}:${e.operation}`)).toEqual(['second:create']);
  expect(page.coverage).toMatchObject({ pendingSince: null, gapCount: 1 });
}));

test('consumer API: own token only, loopback only (unknown refused), fixed scope, bounded ACK body', () => withTempDir(async dir => {
  const { store, history } = wire(dir);
  await install(dir);
  await store.createCard({ title: SECRET_TITLE, description: SECRET_BODY });
  const events = '/api/board-history/events';
  expect((await call(history, events)).status).toBe(401);
  expect((await call(history, events, { headers: { authorization: `Bearer ${PEER}` } })).status).toBe(401);
  expect((await call(history, events, { headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401);
  expect((await call(history, events, { headers: auth }, '192.168.0.9')).status).toBe(403);
  expect((await call(history, events, { headers: auth }, null)).status).toBe(403);
  for (const q of ['projectId=other', 'subscriptionId=x', 'since=2020-01-01', 'owner=x', 'cursor=0', 'limit=1&limit=2'])
    expect((await call(history, `${events}?${q}`, { headers: auth })).body).toEqual({ error: 'unsupported_parameter' });
  for (const limit of ['0', '101', '-1', 'abc', '1e2'])
    expect((await call(history, `${events}?limit=${limit}`, { headers: auth })).status).toBe(400);
  const ok = await call(history, `${events}?limit=5`, { headers: auth });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ subscriptionId: 'dot', coverage: { windowStart: expect.any(String) } });
  expect(JSON.stringify(ok.body)).not.toContain('SYNTHETIC');

  const ack = '/api/board-history/ack';
  // Declared length over the cap is refused before the body is touched.
  let touched = false;
  const declared = { headers: new Headers({ 'content-length': '5000' }), get body() { touched = true; return null; } };
  expect(await readCappedBody(declared, MAX_ACK_BODY_BYTES)).toBeNull();
  expect(touched).toBe(false);
  expect((await call(history, ack, { method: 'POST', headers: auth, body: 'x'.repeat(5000) })).status).toBe(413);
  // An undeclared streamed body is cut off at the cap.
  const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4096).fill(32)); c.close(); } });
  expect((await call(history, ack, { method: 'POST', headers: auth, body: big })).status).toBe(413);
  const post = (body: string) => call(history, ack, { method: 'POST', headers: auth, body });
  expect((await post('not json')).body).toEqual({ error: 'invalid_json' });
  expect((await post(JSON.stringify({ deliveryId: ok.body.deliveryId, projectId: 'other' }))).status).toBe(400);
  expect((await post(JSON.stringify({ deliveryId: '../../etc' }))).body).toEqual({ error: 'invalid_board_delivery' });
  expect((await post(JSON.stringify({ deliveryId: 'unknown-delivery' }))).status).toBe(409);
  const acked = await post(JSON.stringify({ deliveryId: ok.body.deliveryId }));
  expect(acked.body).toMatchObject({ subscriptionId: 'dot', committedSequence: ok.body.throughSequence });
  expect((await post(JSON.stringify({ deliveryId: ok.body.deliveryId }))).body).toEqual(acked.body);
  expect((await call(history, '/api/board-history/other', { headers: auth })).status).toBe(404);
}));

test('route order: consumer token unlocks nothing else and the peer token cannot read history', () => withTempDir(async dir => {
  const { store, workStore, history } = wire(dir);
  await install(dir);
  const { handleRequest } = createRouteHandler(store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, () => PEER, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, workStore, history);
  const local = { clientAddress: LOCAL };
  const ack = await handleRequest(req('/api/board-history/ack', { method: 'POST', headers: auth, body: '{"deliveryId":"x"}' }), local);
  expect(ack.status).toBe(409); // reached the consumer handler, not the peer-token gate
  const mutate = await handleRequest(req('/api/cards', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"title":"t","description":"d"}' }), local);
  expect(mutate.status).toBe(401);
  expect((await handleRequest(req('/api/board-history/status', { headers: { authorization: `Bearer ${PEER}` } }), local)).status).toBe(401);
  expect((await handleRequest(req('/api/board-history/status', { headers: auth }))).status).toBe(403); // address unknown
  const status = await handleRequest(req('/api/board-history/status', { headers: auth }), local);
  expect(await status.json()).toMatchObject({ subscriptionId: 'dot', status: { cutoffUtc: expect.any(String) }, coverage: expect.any(Object) });
}));

test('install is one-time and validates its inputs', () => withTempDir(async dir => {
  await expect(installBoardHistory({ dataDir: dir, subscriptionId: 'dot', token: 'short' })).rejects.toThrow('invalid_board_history_token');
  await expect(installBoardHistory({ dataDir: dir, subscriptionId: '../x', token: TOKEN })).rejects.toThrow('invalid_board_history_subscription');
  await install(dir);
  await expect(installBoardHistory({ dataDir: dir, subscriptionId: 'other', token: TOKEN + 'x' })).rejects.toThrow('board_history_already_installed');
}));


test('consumer reconciliation does not migrate a legacy primary board', () => withTempDir(async dir => {
  const legacy = join(dir, 'board.json');
  const before = JSON.stringify({ cards: [] });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(legacy, before);
  const { store, history } = wire(dir);
  await install(dir);
  await store.reconcileChangeObserver();
  expect(history.page().events).toEqual([]);
  expect(readFileSync(legacy, 'utf-8')).toBe(before);
  expect(existsSync(join(dir, 'active.json'))).toBe(false);
  expect(existsSync(legacy + '.bak')).toBe(false);
}));
