import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { withTempDir } from './setup';
import { SqliteBoardStorage, SQLITE_STORAGE_MARKER, sqliteBoardMarkerFor } from '../core/sqlite-board-storage';
import { CARD_SEMANTIC_SETTINGS_PATH as settingsPath, CARD_SEMANTIC_SEARCH_PATH as searchPath, splitCardSearch } from '../core/card-semantic';
import { CARD_EMBEDDING_DIMENSIONS } from '../core/card-semantic-model';
import { cardEmbeddingInput, CardSemanticIndex, type IndexPolicy } from '../core/card-semantic-index';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { WorkStore } from '../core/work-store';
import { CardSemanticSearch, parseSemanticConfig } from '../plugin/card-semantic-search';
import { boundedSearchProjection, projectSearchCard } from '../core/card-semantic-projection';
import type { CardSemanticResult, CardSemanticStatus } from '../core/card-semantic';
import { writeFileSync } from 'node:fs';

const projectDir = '/synthetic/approved';
const policy: IndexPolicy = { directories: new Set([projectDir]), secrets: ['SENSITIVE_FIXTURE'], version: 'fixture' };

test('OFF creates no index and SQLite tracks edits, moves, protection and old tickets in the existing write', () => withTempDir(async dir => {
  const storage = new SqliteBoardStorage(join(dir, 'board.sqlite'));
  const store = new KanbanStore(dir, storage);
  const index = new CardSemanticIndex(storage);
  const first = await store.createCard({ title: 'A', description: '', projectDir });
  expect(index.hasSchema()).toBe(false);
  await index.init();
  index.observe(policy, () => { throw Error('Unexpected index failure'); });
  while (!await index.scan(policy)) {}
  const [old] = index.jobs(policy, false);
  expect(old.card_id).toBe(first.id);
  await store.updateCard(first.id, { title: 'B' });
  await store.updateCard(first.id, { title: 'A' });
  const [current] = index.jobs(policy, false);
  expect(current.token).not.toBe(old.token);
  const vector = new Float32Array(CARD_EMBEDDING_DIMENSIONS);
  vector[0] = 1;
  await index.finish(policy, [old], [vector]);
  expect(index.counts(policy).ready).toBe(0);
  await index.finish(policy, [current], [vector]);
  expect(index.counts(policy).ready).toBe(1);
  await expect(storage.write(async () => {
    await store.updateCard(first.id, { title: '롤백할 변경' });
    throw Error('rollback');
  })).rejects.toThrow('rollback');
  expect(index.counts(policy).ready).toBe(1);
  await store.updateCard(first.id, { status: 'done' });
  await store.archiveCards([first.id]);
  const [archived] = index.candidates(policy, new Map((await store.getCards({ includeArchived: true })).map(card => [card.id, card])));
  expect(archived.source_key).toStartWith('archive:');
  expect(archived.token).toBe(current.token);
  await store.unarchiveCards([first.id]);
  await store.updateCard(first.id, { description: 'SENSITIVE_FIXTURE' });
  expect(index.counts(policy).ready).toBe(0);
  expect(index.counts(policy).pending).toBe(0);
  await store.updateCard(first.id, { description: '' });
  expect(index.counts(policy).pending).toBe(1);
  await store.deleteCard(first.id);
  expect(index.counts(policy).pending).toBe(0);
  await store.restoreCard(first.id);
  expect(index.counts(policy).pending).toBe(1);
  const [restored] = index.jobs(policy, false);
  await index.finish(policy, [restored], [vector]);
  await store.updateCard(first.id, { projectDir: projectDir + ' ' });
  expect(index.counts(policy).ready).toBe(0);
  expect(index.counts(policy).pending).toBe(0);
  const second = await store.createCard({ title: 'Unapproved', description: '', projectDir: projectDir + ' ' });
  expect(index.jobs(policy, false).some(job => job.card_id === second.id)).toBe(false);
}));

test('restoring a not-yet-indexed archive card marks it even after the active scan completed', () => withTempDir(async dir => {
  const storage = new SqliteBoardStorage(join(dir, 'board.sqlite'));
  const store = new KanbanStore(dir, storage);
  const index = new CardSemanticIndex(storage);
  const card = await store.createCard({ title: 'Restore', description: '', projectDir });
  await store.updateCard(card.id, { status: 'done' });
  await store.archiveCards([card.id]);
  await index.init();
  // Active document scan and prune complete before the first archive scan.
  await index.scan(policy);
  await index.scan(policy);
  expect(index.counts(policy).pending).toBe(0);
  index.observe(policy, () => { throw Error('Unexpected index failure'); });
  await store.unarchiveCards([card.id]);
  expect(index.jobs(policy, false).some(job => job.card_id === card.id && job.source_key === 'cards')).toBe(true);
}));

test('PR and ID tokens route without free text; mixed queries retain their residual', () => {
  expect(splitCardSearch('PR #42 재시도 오류')).toEqual({ keys: new Set(['#42']), text: '재시도 오류' });
  expect(splitCardSearch('42').text).toBe('');
  expect(splitCardSearch('https://github.com/org/repo/pull/42').text).toBe('');
  expect(splitCardSearch('https://github.com/org/repo/pull/42/').text).toBe('');
  expect(splitCardSearch('노트 정리 작업').keys.size).toBe(0);
  expect(splitCardSearch('authentication-errors').text).toBe('authentication-errors');
  expect(splitCardSearch('https://github.com/org/repo/pull/42oops').keys.size).toBe(0);
  const id = 'a12B-34567890_testXYZ';
  expect(splitCardSearch(id, new Set([id])).text).toBe('');
});

test('search suppresses a Work hit after the linked session changes during final snapshot selection', () => withTempDir(async dir => {
  const database = join(dir, 'board.sqlite');
  const storage = new SqliteBoardStorage(database);
  const store = new KanbanStore(dir, storage);
  const workStore = new WorkStore(dir, storage);
  const writer = new WorkStore(dir, new SqliteBoardStorage(database));
  const sessionId = 'race-work-session';
  const card = await store.createCard({ title: 'PR #42', description: 'fixture', projectDir });
  await store.updateCard(card.id, { sessionId });
  const work = await workStore.createWork({ title: 'Race Work', projectDir });
  await workStore.addSession(work.id, { sessionId });
  const vector = new Float32Array(CARD_EMBEDDING_DIMENSIONS); vector[0] = 1;
  const fakeWorker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(message: { id: number; type: string; texts?: unknown[] }) {
      const data = { id: message.id, ok: true, ranked: [0], vectors: (message.texts ?? []).map(() => vector) };
      queueMicrotask(() => this.onmessage?.({ data }));
    },
  };
  const service = new CardSemanticSearch(storage, new SettingsStore(dir), dir, () => fakeWorker as unknown as Worker);
  service.start();
  try {
    await service.configure({ enabled: true, directories: [projectDir] });
    for (let i = 0; i < 60 && (await service.status()).state !== 'ready'; i++) await Bun.sleep(50);
    expect((await service.status()).state).toBe('ready');
    let selections = 0;
    const select = async () => {
      const linked = (await workStore.getWork(work.id))!.sessionLinks.some(l => l.sessionId === sessionId);
      const cards = linked ? await store.getCards() : [];
      if (++selections === 2) await writer.removeSession(work.id, sessionId);
      return cards;
    };
    const result = await service.search('PR #42 explanation', select, new AbortController().signal, 'work');
    expect(selections).toBe(2);
    expect(result).toEqual({ status: 'timeout', exact: [], semantic: [] });
    await workStore.addSession(work.id, { sessionId });
    await storage.writeCardIndex(db => db.run('DELETE FROM card_embeddings'));
    const noVector = await service.search('PR #42 explanation', async () => {
      const cards = await store.getCards();
      await writer.removeSession(work.id, sessionId);
      return cards;
    }, new AbortController().signal, 'work');
    expect(noVector).toEqual({ status: 'timeout', exact: [], semantic: [] });
  } finally { service.stop(); }
}), 6_000);

test('oversized archive skips semantic selection before parsing while keyword lookup still works', () => withTempDir(async dir => {
  const storage = new SqliteBoardStorage(join(dir, 'board.sqlite'));
  const store = new KanbanStore(dir, storage);
  const card = await store.createCard({ title: 'Keyword fixture', description: 'ok', projectDir });
  await storage.write(async () => storage.writeDocument('archive:2026-11', {
    cards: [{ ...card, id: 'archived-fixture', title: 'Large archived card', description: 'x'.repeat(8 * 1024 * 1024) }],
  }));
  const worker = { postMessage() {}, terminate() {} } as unknown as Worker;
  const { promise: launched, resolve: markLaunched } = Promise.withResolvers<void>();
  const service = new CardSemanticSearch(storage, new SettingsStore(dir), dir, () => { markLaunched(); return worker; });
  service.start();
  try {
    await service.configure({ enabled: true, directories: [projectDir] });
    await Promise.race([launched, Bun.sleep(2_000).then(() => { throw Error('Fixture Worker did not start'); })]);
    let selections = 0;
    const result = await service.search('PR #42', async () => { selections++; return store.loadArchives(); }, new AbortController().signal, 'archive');
    expect(result).toEqual({ status: 'timeout', exact: [], semantic: [] });
    expect(selections).toBe(0);
    expect((await store.listWikiArchiveCards({ q: 'Large archived card' })).cards.map(c => c.id)).toEqual(['archived-fixture']);
  } finally { service.stop(); }
}));

test('scope projection stops before projecting cards beyond its count or byte budget', () => withTempDir(async dir => {
  const card = await new KanbanStore(dir).createCard({ title: 'Fixture', description: 'No personal data', projectDir });
  let visited = 0;
  function* source() {
    for (let i = 0; i < 20; i++) { visited++; yield { ...card, id: 'fixture-' + i }; }
  }
  expect(boundedSearchProjection(source(), policy, 3, 1024 * 1024)).toBeNull();
  expect(visited).toBe(4);
  visited = 0;
  expect(boundedSearchProjection(source(), policy, 100, 1)).toBeNull();
  expect(visited).toBe(1);
}));

const modelDir = process.env.KANBAN_SEMANTIC_TEST_MODEL_DIR;
test.skipIf(!modelDir)('actual application: local model, initial/restarted indexing, edited vectors and scoped search', () => withTempDir(async dir => {
  const database = join(dir, 'board.sqlite');
  const storage = new SqliteBoardStorage(database);
  writeFileSync(join(dir, SQLITE_STORAGE_MARKER), sqliteBoardMarkerFor(database), { mode: 0o600 });
  const store = new KanbanStore(dir, storage);
  const card = await store.createCard({ title: 'Concurrency control for collaborative editing',
    description: 'Prevent simultaneous updates from overwriting another person’s changes.', projectDir });
  const other = await store.createCard({ title: '동시 수정 충돌을 막기', description: '', projectDir: '/synthetic/excluded' });
  const calendar = await store.createCard({ title: 'Calendar scheduling across time zones', description: '', projectDir });
  const archive = await store.createCard({ title: 'Archived scheduling', description: '', projectDir });
  const workStore = new WorkStore(dir, storage);
  const work = await workStore.createWork({ title: 'One selected session', projectDir });
  await workStore.addSession(work.id, { sessionId: 'fixture-selected-session' });
  await store.updateCard(card.id, { sessionId: 'fixture-selected-session' });
  await store.updateCard(archive.id, { status: 'done', result: 'Internal result only PR #77' });
  await store.archiveCards([archive.id]);
  // Optional stress fixture uses the real Mac document sizes without private data.
  if (process.env.KANBAN_SEMANTIC_TEST_LARGE) {
    const padding = 'x '.repeat(512 * 1024);
    await storage.write(async () => {
      const active = storage.readDocument<{ cards: typeof card[] }>('cards')!;
      storage.writeDocument('cards', { ...active, cards: active.cards.concat(
        Array.from({length:9}, (_, i) => ({ ...other, id: 'active-padding-' + i, result: padding }))) });
      for (let month = 1; month <= 5; month++) {
        storage.writeDocument(`archive:2026-0${month}`, { cards: Array.from({length:24}, (_, i) => ({
          ...other, id: `archive-pad-${month}-${i}`, status: 'done', result: padding,
        })) });
      }
    });
  }
  const info = new CardSemanticIndex(storage);
  expect(info.hasSchema()).toBe(false);

  const daemon = process.env.KANBAN_SEMANTIC_TEST_DAEMON;
  const serve = async (action: (base: string, api: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>,
    modelPath = modelDir!) => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn([process.execPath, daemon ?? join(import.meta.dir, 'fixtures/sqlite-board-app.ts')], {
      env: { HOME: dir, PATH: process.env.PATH, KANBAN_DATA_DIR: dir, KANBAN_PORT: String(port),
        KANBAN_SEARCH_MODEL_DIR: modelPath }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
    });
    const stderr = new Response(proc.stderr).text();
    try {
      const base = `http://127.0.0.1:${port}`;
      let token = '';
      for (let i = 0; i < 120 && proc.exitCode === null; i++) {
        const response = await fetch(base + '/api/auth/token').catch(() => undefined);
        if (response?.ok) {
          token = (await response.json() as {token: string}).token;
          if (token) break;
        }
        await Bun.sleep(30);
      }
      expect(token).not.toBe('');
      await action(base, (path, method = 'GET', body) => fetch(base + path, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    } finally {
      if (daemon) proc.kill('SIGTERM');
      proc.stdin.end();
      const exit = await proc.exited;
      if (exit !== 0) throw Error(await stderr);
    }
  };

  const row = (id = card.id) => storage.readCardIndex(db => db.query<{input_hash: string; token: string; state: string},[string]>(
    'SELECT input_hash,token,state FROM card_embeddings WHERE card_id=?').get(id));
  const wait = async (check: () => boolean | Promise<boolean>, label = 'Index readiness') => {
    const end = performance.now() + (process.env.KANBAN_SEMANTIC_TEST_LARGE ? 40_000 : 10_000);
    for (;;) {
      try {
        if (await check()) return;
      } catch (error) {
        // The test opens a second SQLite connection against the isolated
        // daemon. A concurrent WAL close/checkpoint can briefly block it.
        if ((error as {code?: string}).code !== 'SQLITE_BUSY') throw error;
      }
      if (performance.now() >= end) throw Error(label + ' timed out');
      await Bun.sleep(50);
    }
  };
  let knownHash = '';
  let lastToken = '';
  await serve(async (base, api) => {
    expect((await fetch(base + settingsPath)).status).toBe(401);
    const status = async () => await (await api(settingsPath)).json() as CardSemanticStatus;
    expect((await status()).state).toBe('off');
    expect((await api(settingsPath, 'PUT', { enabled: true, directories: [projectDir] })).status).toBe(200);
    const protectedKey = 'card_semantic_search';
    const policyEntry = (await new SettingsStore(dir).getEntries()).find(entry => entry.key === protectedKey)!;
    expect((await api('/api/settings/by-key/' + protectedKey, 'PUT', { value: 'false' })).status).toBe(403);
    expect((await api('/api/settings/' + policyEntry.id)).status).toBe(404);
    expect((await api('/api/settings/' + policyEntry.id, 'PATCH', { value: 'false' })).status).toBe(404);
    expect((await api('/api/settings/' + policyEntry.id, 'DELETE')).status).toBe(404);
    await wait(async () => (await status()).state === 'ready');
    let result: CardSemanticResult = { status: 'off', exact: [], semantic: [] };
    await wait(async () => {
      result = await (await api(searchPath, 'POST', { query: '동시에 편집해도 바뀐 내용을 잃지 않기', scope: { kind: 'board' } })).json();
      return result.status === 'ready';
    });
    expect(result.semantic[0]?.id).toBe(card.id);
    expect(result.semantic.some(hit => hit.id === other.id)).toBe(false);
    expect(result.semantic.some(hit => hit.id === calendar.id)).toBe(true);
    expect(result.semantic.some(hit => hit.id === archive.id)).toBe(false);
    let byWork: CardSemanticResult | undefined;
    await wait(async () => {
      byWork = await (await api(searchPath, 'POST', {
        query: '동시에 편집해도 바뀐 내용을 잃지 않기', scope: { kind: 'work', id: work.id },
      })).json() as CardSemanticResult;
      return byWork.status === 'ready';
    });
    expect(byWork!.semantic.map(hit => hit.id)).toEqual([card.id]);
    if (process.env.KANBAN_SEMANTIC_TEST_LARGE) console.log('large documents: active, work and archive scope exercised');
    const wiki = await (await api(searchPath, 'POST', {
      query: 'PR #77', scope: { kind: 'archive', status: 'all' },
    })).json() as CardSemanticResult;
    expect(wiki.status).toBe('ready');
    expect(wiki.exact).toEqual([]);
    const archiveMeaning = await (await api(searchPath, 'POST', {
      query: 'Calendar scheduling', scope: { kind: 'archive', status: 'all' },
    })).json() as CardSemanticResult;
    expect(archiveMeaning.status).toBe('ready');
    expect(archiveMeaning.semantic.map(hit => hit.id)).toEqual([archive.id]);
    knownHash = row()!.input_hash;
    const edit = await api('/api/cards/' + card.id, 'PATCH', { title: 'Editing with optimistic locking' });
    expect(edit.status).toBe(200);
    await wait(() => row()?.state === 'ready' && row()?.input_hash !== knownHash, 'Edited card reindex');
    lastToken = row()!.token;
  });
  await serve(async (_base, api) => {
    await wait(async () => (await (await api(settingsPath)).json() as CardSemanticStatus).state === 'ready', 'Restarted index');
    expect(row()?.token).toBe(lastToken);
    expect((await api('/api/cards/' + card.id, 'DELETE')).status).toBe(204);
    await wait(() => row() === null);
    const afterDelete = await api(searchPath, 'POST', { query: '동시에 편집해도 바뀐 내용을 잃지 않기', scope: { kind: 'board' } });
    expect(((await afterDelete.json()) as CardSemanticResult).semantic.map(hit => hit.id)).not.toContain(card.id);
    const previousToken = row(calendar.id)!.token;
    await storage.writeCardIndex(db => db.exec('ALTER TABLE card_embedding_progress RENAME TO fixture_progress'));
    expect((await api(settingsPath, 'PUT', { enabled: false, directories: [projectDir] })).status).toBe(503);
    const failedStatus = await (await api(settingsPath)).json() as CardSemanticStatus;
    expect([failedStatus.enabled, failedStatus.state]).toEqual([false, 'failed']);
    expect(row(calendar.id)?.token).toBe(previousToken);
    await storage.writeCardIndex(db => db.exec('ALTER TABLE fixture_progress RENAME TO card_embedding_progress'));
    expect((await api(settingsPath, 'PUT', { enabled: true, directories: [projectDir] })).status).toBe(200);
    await wait(() => row(calendar.id)?.state === 'ready' && row(calendar.id)?.token !== previousToken, 'Reactivated index');
    expect((await api(settingsPath, 'PUT', { enabled: false, directories: [projectDir] })).status).toBe(200);
    expect(row()).toBeNull();
    expect(storage.readCardIndex(db => db.query('SELECT count(*) AS count FROM card_embeddings').get())).toEqual({ count: 0 });
  });
  await serve(async (_base, api) => {
    const status = async () => await (await api(settingsPath)).json() as CardSemanticStatus;
    expect((await api(settingsPath, 'PUT', { enabled: true, directories: [projectDir] })).status).toBe(200);
    await wait(async () => (await status()).state === 'failed');
    expect((await api('/api/cards')).status).toBe(200);
    const result = await (await api(searchPath, 'POST', { query: 'Calendar', scope: { kind: 'board' } })).json() as CardSemanticResult;
    expect(result.semantic).toEqual([]);
  }, join(dir, 'nonexistent-model'));
  let newCardId: string | undefined;
  await serve(async (_base, api) => {
    expect((await api(settingsPath, 'PUT', { enabled: true, scope: 'all', directories: [] })).status).toBe(200);
    await wait(async () => (await (await api(settingsPath)).json() as CardSemanticStatus).state === 'ready');
    expect(row(other.id)?.state).toBe('ready');
    const resp = await api('/api/cards', 'POST', { title: 'Whale migration and ocean conservation', description: 'Marine wildlife' });
    expect(resp.ok).toBe(true);
    const added = await resp.json() as { id: string; projectDir?: string };
    expect(added.projectDir).toBeFalsy();
    newCardId = added.id;
    await wait(() => row(added.id)?.state === 'ready', 'Pathless incremental index');
    const result = await (await api(searchPath, 'POST', { query: '고래가 바다를 이동하는 경로와 보호', scope: { kind: 'board' } })).json() as CardSemanticResult;
    expect(result.status).toBe('ready');
    expect(result.semantic.map(hit => hit.id)).toContain(added.id);
  });
  if (process.env.KANBAN_SEMANTIC_TEST_WHOLE_ARCHIVE) {
    // Reuse one actual local-model vector and synthetic distractors to
    // stress ranking deterministically without running 11,514 model calls.
    const size = 11_514;
    const source = 'archive:2025-12';
    const hitId = 'zz-whale-archive-hit';
    const addedCard = (await store.getCard(newCardId!))!;
    const cards = [
      ...Array.from({length: size - 1}, (_, i) => ({
        ...other, id: 'archive-distractor-' + i.toString().padStart(5, '0'), status: 'done',
      })),
      { ...addedCard, id: hitId, status: 'done' },
    ];
    await storage.write(async () => {
      storage.writeDocument(source, { cards, month: '2025-12', archivedAt: new Date().toISOString() });
    });
    await storage.writeCardIndex(db => {
      // Large-document padding still exercises JSON projection, but it is
      // not part of this controlled rank dataset.
      db.run("DELETE FROM card_embeddings WHERE card_id GLOB 'archive-pad-*'");
      const row = db.query<{ vector: Uint8Array }, [string]>(
        "SELECT vector FROM card_embeddings WHERE card_id=? AND state='ready'").get(newCardId!);
      expect(row?.vector.byteLength).toBe(CARD_EMBEDDING_DIMENSIONS * 4);
      const targetVector = new Float32Array(row!.vector.buffer, row!.vector.byteOffset, CARD_EMBEDDING_DIMENSIONS);
      const distractorVector = targetVector.map(value => -value);
      const copy = db.query(`INSERT INTO card_embeddings
        SELECT ?,?,model_version,dimensions,input_hash,?,state,?,priority,attempts,retry_at
        FROM card_embeddings WHERE card_id=?`);
      for (const {id} of cards) copy.run(id, source, id, id === hitId ? targetVector : distractorVector,
        id === hitId ? newCardId! : other.id);
      expect(db.query('SELECT count(*) AS count FROM card_embeddings WHERE source_key=?').get(source)).toEqual({ count: size });
      db.run(`INSERT INTO card_embedding_progress
        SELECT key,(SELECT model_version FROM card_embeddings WHERE card_id=?),revision,'complete',''
        FROM board_documents WHERE key=?`, [hitId, source]);
    });
    await serve(async (_base, api) => {
      await wait(async () => (await (await api(settingsPath)).json() as CardSemanticStatus).state === 'ready');
      const samples: number[] = [];
      for (let i = 0; i < 6; i++) {
        const start = performance.now();
        const result = await (await api(searchPath, 'POST', {
          query: '고래가 바다를 이동하는 경로와 보호', scope: { kind:'archive', status:'all' },
        })).json() as CardSemanticResult;
        samples.push(Math.round(performance.now() - start));
        if (result.status !== 'ready') console.log('Whole-archive failure timings in ms:', samples);
        expect(result.status).toBe('ready');
        expect(result.exact).toEqual([]);
        expect(result.semantic.map(hit => hit.id)).toContain(hitId);
      }
      console.log('Whole-archive actual-model timings in ms (first cold, then warm):', samples);
    });
  }
}), 120_000);

test('whole-board opt-in includes pathless and future projects, not deleted or sensitive cards', () => {
  const all: IndexPolicy = { ...policy, scope: 'all', directories: new Set() };
  const card = { id: 'fixture', title: 'Title', description: 'Plain description' };
  expect(parseSemanticConfig({ enabled: true, scope: 'all', directories: [] })).toEqual({
    enabled: true, scope: 'all', directories: [],
  });
  expect(parseSemanticConfig({ enabled: true, directories: [] })).toBeNull();
  expect(parseSemanticConfig({ enabled: true, scope: 'all', directories: [projectDir] })).toBeNull();
  expect(parseSemanticConfig({ enabled: true, directories: [projectDir] })).toEqual({
    enabled: true, directories: [projectDir],
  });
  expect(cardEmbeddingInput(card, policy)).toBeNull();
  expect(cardEmbeddingInput(card, all)).toBe('Title\nPlain description');
  expect(cardEmbeddingInput({ ...card, projectDir: '/future/synthetic' }, all)).not.toBeNull();
  expect(cardEmbeddingInput({ ...card, deletedAt: '2026-11-26T00:00:00Z' }, all)).toBeNull();
  expect(cardEmbeddingInput({ ...card, description: 'SENSITIVE_FIXTURE' }, all)).toBeNull();
  expect(cardEmbeddingInput({ ...card, description: 'password=example' }, all)).toBeNull();
});

test('whole-board projected archive query can return the candidate after position 4096', () => withTempDir(async dir => {
  const storage = new SqliteBoardStorage(join(dir, 'board.sqlite'));
  const store = new KanbanStore(dir, storage);
  const target = await store.createCard({ title: 'Archived travel plans', description: 'local train timetable' });
  const vector = new Float32Array(CARD_EMBEDDING_DIMENSIONS); vector[0] = 1;
  const fakeWorker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(message: { id: number; type: string; texts?: unknown[]; vectors?: Float32Array }) {
      const n = (message.vectors?.length ?? 0) / CARD_EMBEDDING_DIMENSIONS;
      const data = { id: message.id, ok: true, ranked: n ? [n - 1] : [], vectors: (message.texts ?? []).map(() => vector) };
      queueMicrotask(() => this.onmessage?.({ data }));
    },
  };
  const service = new CardSemanticSearch(storage, new SettingsStore(dir), dir, () => fakeWorker as unknown as Worker);
  service.start();
  try {
    await service.configure({ enabled: true, scope: 'all', directories: [] });
    for (let i = 0; i < 60 && (await service.status()).state !== 'ready'; i++) await Bun.sleep(50);
    expect((await service.status()).state).toBe('ready');
    const all: IndexPolicy = { ...policy, scope: 'all', directories: new Set() };
    const ids = Array.from({length:4096}, (_, i) => 'fixture-' + i.toString().padStart(5, '0'));
    await storage.writeCardIndex(db => {
      db.run("UPDATE card_embeddings SET card_id='zz-expected' WHERE card_id=?", [target.id]);
      const insert = db.query("INSERT INTO card_embeddings SELECT ?,source_key,model_version,dimensions,input_hash,token,state,vector,priority,attempts,retry_at FROM card_embeddings WHERE card_id='zz-expected'");
      for (const id of ids) insert.run(id);
    });
    const projected = [...ids,'zz-expected'].map(id => projectSearchCard({ ...target, id }, all));
    let selected = false;
    const result = await service.search('기차 여행 일정', async () => {
      if (!selected) await Bun.sleep(350);
      selected = true;
      return projected;
    },
      new AbortController().signal, 'archive', true);
    expect(result.status).toBe('ready');
    expect(result.exact).toEqual([]);
    expect(result.semantic.map(hit => hit.id)).toEqual(['zz-expected']);
  } finally { service.stop(); }
}), 6_000);
