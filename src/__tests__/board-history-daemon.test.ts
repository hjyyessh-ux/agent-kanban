/**
 * Acceptance test against real daemon processes on isolated files.
 *
 * Every daemon runs with a throwaway HOME, KANBAN_DATA_DIR and loopback port;
 * no real home, board data or token is read or written. Fixture Card/Work are
 * synthetic. Flow: fixture → install → state + same-state updates → scope
 * checks → page → restart before ACK → ACK (+ failure/retry) → restart after
 * ACK → only the second change → old-writer edit while stopped → restart →
 * change delivered with a declared coverage gap.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KanbanStore } from '../core/store';

const REPO = resolve(import.meta.dir, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'kanban-bh-accept-'));
const HOME = join(ROOT, 'home');
const DATA = join(ROOT, 'data');
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
const SECRET = 'SYNTHETIC-ACCEPT-SECRET';
const TOKEN = `dot_accept_${crypto.randomUUID().replaceAll('-', '')}`;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, HOME, KANBAN_DATA_DIR: DATA, KANBAN_PORT: String(PORT) };

async function startDaemon() {
  const proc = Bun.spawn(['bun', 'run', 'src/daemon/index.ts'], { cwd: REPO, env: ENV, stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/runtimes`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  const peer = (await (await fetch(`${BASE}/api/auth/token`)).json() as { token: string }).token;
  return { proc, peer };
}
async function stopDaemon(proc: Bun.Subprocess) {
  proc.kill('SIGTERM');
  await proc.exited;
}

async function runInstall(token: string) {
  const proc = Bun.spawn(['bun', 'run', 'src/daemon/board-history-install.ts', 'dot'], {
    cwd: REPO, env: ENV, stdin: new Blob([token]), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { ...bearer(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}
type Page = { deliveryId: string | null; throughSequence: number; events: { kind: string; operation: string; state: string; entityId: string }[];
  coverage: { preCaptureGap: unknown; gaps: { reason: string; kind: string }[]; pendingSince: string | null } };
const events = async (query = '') => {
  const r = await api('GET', `/api/board-history/events${query}`, TOKEN);
  expect(r.status).toBe(200);
  expect(r.text).not.toContain(SECRET);
  return r.body as Page;
};
const ops = (page: Page) => page.events.map(e => `${e.kind}:${e.operation}:${e.state}`);
const ack = (deliveryId: string) => api('POST', '/api/board-history/ack', TOKEN, { deliveryId });

test('two kinds, same-state updates, ACK across restarts, failures and an old writer', async () => {
  let { proc, peer } = await startDaemon();
  try {
    const card = await api('POST', '/api/cards', peer, { title: SECRET, description: SECRET });
    expect(card.status).toBeLessThan(300);
    const work = await api('POST', '/api/works', peer, { title: SECRET });
    expect(work.status).toBeLessThan(300);
    const cardId = card.body.id as string;
    const workId = work.body.id as string;

    expect((await api('GET', '/api/board-history/events', TOKEN)).status).toBe(404); // not installed
    const installed = await runInstall(TOKEN);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain('"subscriptionId": "dot"');
    expect(installed.out + installed.err).not.toContain(TOKEN);
    const again = await runInstall(TOKEN);
    expect(again.code).toBe(1);
    expect(again.err.trim()).toBe('board_history_already_installed');

    const empty = await events();
    expect(empty.events).toEqual([]); // fixtures created before install are not replayed
    expect(empty.coverage.preCaptureGap).not.toBeNull();

    // First change set: a state change and same-state updates on both kinds.
    await Bun.sleep(5);
    expect((await api('PATCH', `/api/cards/${cardId}`, peer, { status: 'complete' })).status).toBe(200);
    await Bun.sleep(5);
    expect((await api('PATCH', `/api/cards/${cardId}`, peer, { title: `${SECRET}-renamed` })).status).toBe(200);
    await Bun.sleep(5);
    expect((await api('PATCH', `/api/works/${workId}`, peer, { title: `${SECRET}-renamed` })).status).toBe(200);

    // Consumer-only access and fixed scope.
    expect((await api('GET', '/api/board-history/events', peer)).status).toBe(401);
    expect((await fetch(`${BASE}/api/board-history/events`)).status).toBe(401);
    expect((await api('POST', '/api/cards', TOKEN, { title: 't', description: 'd' })).status).toBe(401);
    expect((await api('GET', '/api/board-history/events?projectId=other', TOKEN)).body).toEqual({ error: 'unsupported_parameter' });
    expect((await api('GET', '/api/board-history/events?since=2020-01-01', TOKEN)).status).toBe(400);
    expect((await api('GET', '/api/board-history/events?limit=0', TOKEN)).status).toBe(400);
    expect((await api('GET', '/api/board-history/events?limit=101', TOKEN)).status).toBe(400);

    const first = await events('?limit=2');
    expect(ops(first)).toEqual(['card:update:complete', 'card:update:complete']);

    // Restart #1 before ACK: the same delivery is served again.
    await stopDaemon(proc);
    ({ proc, peer } = await startDaemon());
    const replay = await events('?limit=2');
    expect(replay.deliveryId).toBe(first.deliveryId);
    expect(replay.events).toEqual(first.events);

    // ACK failures and retries.
    expect((await ack('bogus-delivery')).status).toBe(409);
    expect((await api('POST', '/api/board-history/ack', TOKEN, { deliveryId: first.deliveryId, extra: 1 })).status).toBe(400);
    const committed = await ack(first.deliveryId!);
    expect(committed.body).toMatchObject({ subscriptionId: 'dot', committedSequence: first.throughSequence });
    expect((await ack(first.deliveryId!)).body).toEqual(committed.body);

    const rest = await events();
    expect(ops(rest)).toEqual(['work:update:active']);
    expect((await ack(rest.deliveryId!)).status).toBe(200);
    expect(await events()).toMatchObject({ deliveryId: null, events: [] });

    // Restart #2 after ACK; only the second change arrives.
    await stopDaemon(proc);
    ({ proc, peer } = await startDaemon());
    expect((await events()).events).toEqual([]);
    expect((await api('PATCH', `/api/cards/${cardId}`, peer, { status: 'done' })).status).toBe(200);
    const second = await events();
    expect(ops(second)).toEqual(['card:update:done']);
    expect(second.coverage.gaps).toEqual([]);
    await ack(second.deliveryId!);

    // Old writer: edits active.json without the observer while the daemon is down.
    await stopDaemon(proc);
    await new KanbanStore(DATA).updateCard(cardId, { status: 'todo' });
    ({ proc, peer } = await startDaemon());
    const fenced = await events();
    expect(ops(fenced)).toEqual(['card:update:todo']);
    expect(fenced.coverage.gaps).toMatchObject([{ kind: 'card', reason: 'unobserved_writer' }]);
    await ack(fenced.deliveryId!);

    // The board itself is unchanged by the sidecar.
    const board = await api('GET', `/api/cards/${cardId}`, peer);
    expect(board.body).toMatchObject({ id: cardId, status: 'todo', title: `${SECRET}-renamed` });
  } finally {
    await stopDaemon(proc);
  }
}, 120_000);
