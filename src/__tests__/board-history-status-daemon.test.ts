/**
 * Real localhost permission test for `GET /api/board-history-status`.
 *
 * Spawns the real daemon on a throwaway HOME, KANBAN_DATA_DIR and a free
 * loopback port (never 24680), installs a synthetic consumer token, and checks
 * the gates over real HTTP. No real home, board data, subscription or token is
 * read or written.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'kanban-bh-status-'));
const HOME = join(ROOT, 'home');
const DATA = join(ROOT, 'data');
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
const TOKEN = `dot_status_${crypto.randomUUID().replaceAll('-', '')}`;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
const PORT = freePort();
if (PORT === 24680) throw new Error('refusing to use the real app port');
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, HOME, KANBAN_DATA_DIR: DATA, KANBAN_PORT: String(PORT) };
const PATH = '/api/board-history-status';

async function startDaemon() {
  const proc = Bun.spawn(['bun', 'run', 'src/daemon/index.ts'], { cwd: REPO, env: ENV, stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/runtimes`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  const peer = (await (await fetch(`${BASE}/api/auth/token`)).json() as { token: string }).token;
  return { proc, peer };
}

async function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  const text = await res.text();
  const cors = [...res.headers.keys()].filter(key => key.startsWith('access-control-'));
  return { status: res.status, text, cors };
}

test('owner-only status over real loopback HTTP: peer token yes, consumer/none/cross-origin/rebind no', async () => {
  const { proc, peer } = await startDaemon();
  try {
    expect(peer.length).toBeGreaterThan(0);
    const admin = { authorization: `Bearer ${peer}` };

    // Before install: readable, and OFF is reported as not registered.
    const off = await get(PATH, admin);
    expect(off.status).toBe(200);
    expect(JSON.parse(off.text)).toMatchObject({ state: 'not_registered' });

    const install = Bun.spawn(['bun', 'run', 'src/daemon/board-history-install.ts', 'dot'], {
      cwd: REPO, env: ENV, stdin: new Blob([TOKEN]), stdout: 'ignore', stderr: 'ignore' });
    expect(await install.exited).toBe(0);

    const on = await get(PATH, admin);
    expect(on.status).toBe(200);
    expect(JSON.parse(on.text)).toMatchObject({ state: 'registered', registration: { consumer: { readAndAckTimesCollected: false } } });
    for (const forbidden of [TOKEN, peer, 'subscriptionId', '"dot"']) expect(on.text).not.toContain(forbidden);
    expect(on.cors).toEqual([]);

    const refused: [string, Awaited<ReturnType<typeof get>>, number][] = [
      ['no credential', await get(PATH), 401],
      ['consumer token', await get(PATH, { authorization: `Bearer ${TOKEN}` }), 401],
      ['wrong token', await get(PATH, { authorization: 'Bearer not-the-token' }), 401],
      ['cross origin', await get(PATH, { ...admin, origin: 'http://attacker.example' }), 403],
      ['rebound host', await get(PATH, { ...admin, host: `attacker.example:${PORT}` }), 403],
      ['cross-site fetch metadata', await get(PATH, { ...admin, 'sec-fetch-site': 'cross-site' }), 403],
      ['preflight', await get(PATH, { 'access-control-request-method': 'GET' }, 'OPTIONS'), 405],
      ['write method', await get(PATH, admin, 'POST'), 405],
      ['extra parameter', await get(`${PATH}?subscription=dot`, admin), 400],
    ];
    for (const [name, res, status] of refused) {
      expect({ name, status: res.status }).toEqual({ name, status });
      expect({ name, cors: res.cors }).toEqual({ name, cors: [] });
      expect(res.text).not.toContain('registration');
    }

    // Consumer API keeps its own gate: peer token refused, consumer token accepted.
    expect((await get('/api/board-history/status', admin)).status).toBe(401);
    expect((await get('/api/board-history/status', { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  } finally {
    proc.kill('SIGTERM');
    await proc.exited;
  }
}, 60_000);
