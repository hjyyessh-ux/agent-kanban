/**
 * Synthetic acceptance check, NOT an installer or a release approval.
 * Run: bun scripts/history-sync-smoke.ts /absolute/path/to/history-candidate
 * Requires that candidate's installed dependencies and built web/dist.
 */
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const candidate = resolve(process.argv[2] ?? '.');
for (const path of ['src/core/sync-store.ts', 'web/dist/index.html', 'node_modules/@playwright/test/index.mjs']) {
  if (!existsSync(join(candidate, path))) throw new Error('Candidate prerequisite missing: ' + path);
}
// Isolate before importing stores: do not inherit user storage or native histories.
const evidence = mkdtempSync(join(tmpdir(), 'history-sync-smoke-'));
for (const [name, folder] of Object.entries({
  HOME: 'home', KANBAN_DATA_DIR: 'data', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude',
})) {
  const path = join(evidence, folder); mkdirSync(path, { recursive: true }); process.env[name] = path;
}
process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE = join(evidence, 'runtime.log');
const load = (path: string) => import(pathToFileURL(join(candidate, path)).href);
const { KanbanStore } = await load('src/core/store.ts');
const { SettingsStore } = await load('src/core/settings-store.ts');
const { createServer } = await load('src/server/index.ts');
const { chromium } = await load('node_modules/@playwright/test/index.mjs');
const store = new KanbanStore(process.env.KANBAN_DATA_DIR);
const settings = new SettingsStore(process.env.KANBAN_DATA_DIR);
const admin = crypto.randomUUID();
// No dispatch, scheduler, wiki, source registration or native session discovery.
const server = createServer(store, 0, join(candidate, 'web/dist'),
  undefined, undefined, undefined, settings, '127.0.0.1',
  undefined, undefined, undefined, undefined, async () => [], async () => [], () => admin);
const origin = 'http://127.0.0.1:' + server.port;
async function api(path: string, data?: unknown, token = admin, method?: string) {
  const response = await fetch(origin + path, {
    method: method ?? (data ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert(response.ok, path + ' HTTP ' + response.status);
  return response.json();
}
let browser: any;
try {
  assert.equal((await api('/api/sync/status')).enabled, false);
  await api('/api/sync/initialize', {});
  const scope = { all_projects: true, project_dirs: [] };
  const registration = await api('/api/sync/consumers', {
    consumer_id: 'fixture', scope, idempotency_key: 'register',
  });
  const token = registration.token;
  await api('/api/sync/subscriptions', {
    subscription_id: 'normal', scope, start_mode: 'replay', schema_version: 1, idempotency_key: 'subscribe',
  }, token);
  const card = await api('/api/cards', { title: 'Synthetic history fixture', description: 'ordinary one' });
  await api('/api/cards/' + card.id, { description: 'ordinary two' }, admin, 'PATCH');
  const changes = '/api/sync/subscriptions/normal/changes?limit=10';
  const page = await api(changes, undefined, token);
  assert.equal(page.events.length, 2);
  assert.equal((await api('/api/sync/subscriptions/normal/checkpoint', undefined, token)).committed_seq, 0);
  const ack = await api('/api/sync/subscriptions/normal/ack', {
    delivery_id: page.delivery_id, processed_through_seq: page.processed_through_seq,
    expected_checkpoint_version: 0, idempotency_key: 'ack', run_id: 'synthetic',
  }, token);
  assert.equal(ack.committed_seq, 2);
  assert.equal((await api(changes, undefined, token)).events.length, 0);
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const web = await browser.newPage();
  // Block third-party fonts/network. Requests to the actual local API are not mocked.
  await web.route('**/*', (route: any) => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await web.goto(origin);
  await web.getByRole('tab', { name: 'Settings', exact: true }).click();
  const panel = web.locator('.settings-sync-panel');
  await panel.getByText('fixture / normal', { exact: true }).waitFor();
  const text = await panel.innerText();
  assert(text.includes('수집 확정 위치'));
  assert(text.includes('2 / 2'));
  assert(text.includes('0 / 2')); // collected does NOT mean evaluated.
  assert(text.includes('검토 대기'));
  await web.screenshot({ path: join(evidence, 'settings.png') });
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({
    passed: true, candidate, eventCount: 2, committedSeq: 2, repeatedEvents: 0,
    ui: text, limitations: ['No real native sources', 'No deployment', 'No security-review approval'],
  }, null, 2));
  console.log('PASS synthetic actual HTTP + built Settings; evidence: ' + evidence);
} finally {
  await browser?.close();
  server.stop();
  store.getSyncJournal().close();
}
