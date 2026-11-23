import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { BoardHistoryService, installBoardHistory, observeCards, observeWorks } from '../core/board-history';
import { readBoardHistorySummary } from '../core/board-history-summary';
import { BOARD_HISTORY_STATUS_PATH, handleBoardHistoryStatusRequest } from '../server/board-history-status-route';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

// Synthetic fixtures only; nothing here reads or writes a real data dir or token.
const TOKEN = 'dot_status_synthetic_token_0123456789abcdefAB';
const PEER = 'peer_status_synthetic_token_0123456789abcdefAB';
const SECRET_TITLE = 'SYNTHETIC-STATUS-TITLE-must-not-leak';
const LOCAL = '127.0.0.1';
const HOST = '127.0.0.1:24680';

function wire(dir: string) {
  const store = new KanbanStore(dir);
  const workStore = new WorkStore(dir);
  const history = new BoardHistoryService(dir);
  store.setChangeObserver(history.observer('card', observeCards));
  workStore.setChangeObserver(history.observer('work', observeWorks));
  return { store, workStore, history };
}
const install = (dir: string) => installBoardHistory({ dataDir: dir, subscriptionId: 'dot', token: TOKEN });
/** A real server request always carries `Host`; explicit headers override it. */
const req = (path: string, init: RequestInit = {}) => new Request(`http://${HOST}${path}`, {
  ...init, headers: { host: HOST, ...(init.headers as Record<string, string> | undefined) },
});

/** Hashes of every persistent sidecar file. `-shm` is SQLite's shared-memory read index, not data. */
function snapshot(dir: string): Record<string, string> {
  const root = join(dir, 'board-history');
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort().filter(n => !n.endsWith('-shm')))
    out[name] = createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
  return out;
}

test('not installed → not_registered; nothing is created by reading', () => withTempDir(async dir => {
  const summary = readBoardHistorySummary(dir);
  expect(summary.state).toBe('not_registered');
  expect(summary.registration).toBeUndefined();
  expect(readdirSync(dir)).not.toContain('board-history');
}));

test('registered: window start vs pre-install gap, no events yet is not "OFF", counts are zero', () => withTempDir(async dir => {
  wire(dir);
  await install(dir);
  const s = readBoardHistorySummary(dir);
  expect(s.state).toBe('registered');
  const r = s.registration!;
  expect(r.preCaptureGap).toEqual({ from: r.windowStart, to: r.captureStartedAt! });
  expect(Date.parse(r.captureStartedAt!) - Date.parse(r.windowStart)).toBeGreaterThanOrEqual(7 * 86400000 - 5000);
  expect(r).toMatchObject({ gapCount: 0, gaps: [], pendingSince: null, continuousSinceWindowStart: false, lastChangeRecordedAt: null });
  expect(r.consumer).toEqual({
    readAndAckTimesCollected: false, ackedThroughRecordedAt: null, deliveryAwaitingAck: false,
    unackedEvents: 0, ackedEvents: 0, cursorExpired: false,
  });
}));

test('changes, delivery and ACK move the counts; the summary is read-only and carries no IDs or content', () => withTempDir(async dir => {
  const { store, workStore, history } = wire(dir);
  await install(dir);
  const card = await store.createCard({ title: SECRET_TITLE, description: SECRET_TITLE });
  await store.updateCard(card.id, { status: 'in_progress' });
  const work = await workStore.createWork({ title: SECRET_TITLE });

  let r = readBoardHistorySummary(dir).registration!;
  expect(r.consumer.unackedEvents).toBe(3);
  expect(r.lastChangeRecordedAt).not.toBeNull();
  expect(r.lastSaveObservedAt).not.toBeNull();

  const page = history.page(2);
  r = readBoardHistorySummary(dir).registration!;
  expect(r.consumer).toMatchObject({ deliveryAwaitingAck: true, unackedEvents: 3, ackedEvents: 0 });

  history.ack(page.deliveryId!);
  const before = snapshot(dir);
  const after = readBoardHistorySummary(dir);
  expect(snapshot(dir)).toEqual(before); // no write of any sidecar file
  r = after.registration!;
  expect(r.consumer).toMatchObject({ deliveryAwaitingAck: false, unackedEvents: 1, ackedEvents: 2 });
  expect(r.consumer.ackedThroughRecordedAt).toBe(page.events.at(-1)!.appendedAt);

  const text = JSON.stringify(after);
  for (const forbidden of [TOKEN, SECRET_TITLE, card.id, work.id, page.deliveryId!, 'subscriptionId', '"dot"', 'bh-',
    createHash('sha256').update(TOKEN).digest('hex')]) expect(text).not.toContain(forbidden);
}));

test('a declared gap and a pending capture are reported as such', () => withTempDir(async dir => {
  const { store } = wire(dir);
  await install(dir);
  await store.createCard({ title: 't', description: 'd' });
  // An unobserved writer (older build / direct edit) changes the file outside capture.
  const path = join(dir, 'active.json');
  const board = JSON.parse(readFileSync(path, 'utf-8')) as { cards: { status: string }[] };
  board.cards[0]!.status = 'done';
  writeFileSync(path, JSON.stringify(board));
  await store.reconcileChangeObserver();
  const r = readBoardHistorySummary(dir).registration!;
  expect(r.gapCount).toBe(1);
  expect(r.gaps[0]).toMatchObject({ kind: 'card', reason: 'unobserved_writer' });
  expect(r.continuousSinceWindowStart).toBe(false);
}));

test('installed but unreadable → unavailable (never not_registered)', () => withTempDir(async dir => {
  await install(dir);
  writeFileSync(join(dir, 'board-history', 'consumer.json'), '{broken');
  expect(readBoardHistorySummary(dir).state).toBe('unavailable');
}));

test('route gate: loopback peer + loopback host + same origin + local admin; consumer token refused; no CORS', () => withTempDir(async dir => {
  const { history } = wire(dir);
  await install(dir);
  const admin = { authorization: `Bearer ${PEER}` };
  const consumer = { authorization: `Bearer ${TOKEN}` };
  const run = (init: RequestInit, opts: { clientAddress?: string; adminAuthorized?: boolean; service?: BoardHistoryService | null; path?: string } = {}) => {
    const r = req(opts.path ?? BOARD_HISTORY_STATUS_PATH, init);
    return handleBoardHistoryStatusRequest(r, new URL(r.url), {
      clientAddress: 'clientAddress' in opts ? opts.clientAddress : LOCAL,
      adminAuthorized: opts.adminAuthorized ?? true,
      service: opts.service === null ? undefined : history,
    });
  };
  const ok = run({ headers: { ...admin, host: HOST } });
  expect(ok.status).toBe(200);
  expect((await ok.json() as { state: string }).state).toBe('registered');

  const cases: [string, Response, number][] = [
    ['LAN peer', run({ headers: admin }, { clientAddress: '192.168.0.20' }), 403],
    ['unknown peer', run({ headers: admin }, { clientAddress: undefined }), 403],
    ['no admin token', run({}, { adminAuthorized: false }), 401],
    ['consumer token', run({ headers: consumer }, { adminAuthorized: false }), 401],
    ['consumer token even if a gate misfired', run({ headers: consumer }, { adminAuthorized: true }), 401],
    ['rebound host', run({ headers: { ...admin, host: 'attacker.example:24680' } }), 403],
    ['cross origin', run({ headers: { ...admin, origin: 'http://attacker.example' } }), 403],
    ['cross-site fetch', run({ headers: { ...admin, 'sec-fetch-site': 'cross-site' } }), 403],
    ['preflight', run({ method: 'OPTIONS', headers: { origin: 'http://attacker.example' } }), 405],
    ['post', run({ method: 'POST', headers: admin }), 405],
    ['query', run({ headers: admin }, { path: `${BOARD_HISTORY_STATUS_PATH}?subscription=dot` }), 400],
  ];
  for (const [name, res, status] of cases) {
    expect({ name, status: res.status }).toEqual({ name, status });
    for (const key of res.headers.keys()) expect(key.startsWith('access-control-')).toBe(false);
  }
  const same = run({ headers: { ...admin, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' } });
  expect(same.status).toBe(200);
  const inactive = run({ headers: admin }, { service: null });
  expect((await inactive.json() as { state: string }).state).toBe('inactive');
}));

test('router: peer token reaches the summary, consumer API keeps its own gate unchanged', () => withTempDir(async dir => {
  const { store, workStore, history } = wire(dir);
  await install(dir);
  const { handleRequest } = createRouteHandler(store, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, () => PEER, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, workStore, history);
  const local = { clientAddress: LOCAL };
  const peer = { authorization: `Bearer ${PEER}` };
  const consumer = { authorization: `Bearer ${TOKEN}` };
  expect((await handleRequest(req(BOARD_HISTORY_STATUS_PATH, { headers: peer }), local)).status).toBe(200);
  expect((await handleRequest(req(BOARD_HISTORY_STATUS_PATH, { headers: consumer }), local)).status).toBe(401);
  expect((await handleRequest(req(BOARD_HISTORY_STATUS_PATH), local)).status).toBe(401);
  expect((await handleRequest(req(BOARD_HISTORY_STATUS_PATH, { headers: peer }), { clientAddress: '10.0.0.5' })).status).toBe(403);
  const preflight = await handleRequest(req(BOARD_HISTORY_STATUS_PATH, { method: 'OPTIONS' }), local);
  expect(preflight.status).toBe(405);
  expect(preflight.headers.get('access-control-allow-methods')).toBeNull();
  // Consumer API: peer token still refused, consumer token still accepted.
  expect((await handleRequest(req('/api/board-history/status', { headers: peer }), local)).status).toBe(401);
  expect((await handleRequest(req('/api/board-history/status', { headers: consumer }), local)).status).toBe(200);
}));
