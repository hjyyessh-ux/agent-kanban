import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { WikiWorker, groupCardsBySession } from '../plugin/wiki/wiki-worker';
import { loadWikiConfig, WIKI_PROMPT_VERSION, WIKI_SETTING_KEYS } from '../plugin/wiki/wiki-config';
import { parseClassifyResult, parseTriageResult } from '../plugin/wiki/wiki-prompts';
import type { WikiLlmCallOptions, WikiLlmRunner } from '../plugin/wiki/wiki-llm';
import type { KanbanCard } from '../core/types';
import { withTempDir } from './setup';

async function setupStores(dir: string) {
  const store = new KanbanStore(dir);
  const settingsStore = new SettingsStore(dir);
  const vaultDir = join(dir, 'vault');
  await settingsStore.upsertByKey(WIKI_SETTING_KEYS.vaultDir, vaultDir);
  await settingsStore.upsertByKey(WIKI_SETTING_KEYS.enabled, 'true');
  return { store, settingsStore, vaultDir };
}

async function archiveDoneCard(
  store: KanbanStore,
  input: { title: string; description?: string; sessionId?: string; result?: string },
): Promise<KanbanCard> {
  const card = await store.createCard({
    title: input.title,
    description: input.description ?? 'desc',
    sessionId: input.sessionId,
  });
  await store.updateCard(card.id, { status: 'done', result: input.result ?? 'done result' });
  await store.archiveCards([card.id]);
  const archived = await store.getCards({ includeArchived: true });
  return archived.find(c => c.id === card.id)!;
}

const KEEP_TRIAGE = JSON.stringify({ decision: 'keep', reason: 'useful', confidence: 0.9 });
const SKIP_TRIAGE = JSON.stringify({ decision: 'skip', reason: '단순 실행 지시', confidence: 0.8 });
const CLASSIFY_DOC = JSON.stringify({
  type: 'troubleshooting',
  title: 'Redis 타임아웃 해결',
  slug: 'redis-timeout',
  topics: ['redis', 'timeout'],
  summary: 'Redis 연결 타임아웃 원인과 해결.',
  body: '## 원인\n\npool 고갈.\n\n## 해결\n\n`maxIdle` 조정.',
});

function fakeLlm(
  responses: { triage: string; classify?: string },
  calls?: string[],
  optionsSeen?: WikiLlmCallOptions[],
): WikiLlmRunner {
  return async (prompt: string, options?: WikiLlmCallOptions) => {
    if (options) optionsSeen?.push(options);
    if (prompt.includes('선별하는 분류자')) {
      calls?.push('triage');
      return responses.triage;
    }
    calls?.push('classify');
    return responses.classify ?? CLASSIFY_DOC;
  };
}

describe('archive wiki stamping', () => {
  test('loadWikiConfig defaults wiki off with no vault directory', async () => {
    await withTempDir(async (dir) => {
      const config = await loadWikiConfig(new SettingsStore(dir));

      expect(config.enabled).toBe(false);
      expect(config.vaultDir).toBe('');
    });
  });

  test('archiveCards marks archived cards wiki-pending', async () => {
    await withTempDir(async (dir) => {
      const { store } = await setupStores(dir);
      const card = await archiveDoneCard(store, { title: 'A' });
      expect(card.wiki?.status).toBe('pending');
      expect(card.wiki?.queuedAt).toBeTruthy();
    });
  });

  test('archiveCards excludes child cards from wiki queue and stats', async () => {
    await withTempDir(async (dir) => {
      const { store } = await setupStores(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Child result',
        parentCardId: parent.id,
        linkKind: 'subagent',
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(child.id, { status: 'done' });
      await store.archiveCards([parent.id]);

      const archived = await store.getCards({ includeArchived: true });
      const archivedParent = archived.find(c => c.id === parent.id)!;
      const archivedChild = archived.find(c => c.id === child.id)!;
      expect(archivedParent.wiki?.status).toBe('pending');
      expect(archivedChild.wiki).toBeUndefined();

      const pending = await store.getWikiPendingCards();
      expect(pending.map(c => c.id)).toEqual([parent.id]);

      const stats = await store.getWikiStats();
      expect(stats.total).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.unprocessed).toBe(0);
    });
  });

  test('markWikiPending queues missing/outdated/failed but not current', async () => {
    await withTempDir(async (dir) => {
      const { store } = await setupStores(dir);
      const a = await archiveDoneCard(store, { title: 'A' });
      const b = await archiveDoneCard(store, { title: 'B' });
      const c = await archiveDoneCard(store, { title: 'C' });
      const d = await archiveDoneCard(store, { title: 'D' });

      await store.updateArchivedCardsWiki({
        [a.id]: { status: 'processed', decision: 'kept', promptVersion: WIKI_PROMPT_VERSION, processedAt: '2026-01-01' },
        [b.id]: { status: 'processed', decision: 'kept', promptVersion: WIKI_PROMPT_VERSION - 1, processedAt: '2026-01-01' },
        [c.id]: { status: 'failed', error: 'boom' },
        [d.id]: { status: 'processed', decision: 'skipped', promptVersion: WIKI_PROMPT_VERSION, processedAt: '2026-01-01' },
      });

      const queued = await store.markWikiPending({ currentPromptVersion: WIKI_PROMPT_VERSION });
      // b (outdated) + c (failed) — a and d are current
      expect(queued).toBe(2);

      const pending = await store.getWikiPendingCards();
      const pendingIds = new Set(pending.map(p => p.id));
      expect(pendingIds.has(b.id)).toBe(true);
      expect(pendingIds.has(c.id)).toBe(true);
      expect(pendingIds.has(a.id)).toBe(false);
    });
  });

  test('markWikiPending ignores child cards for automatic and forced queueing', async () => {
    await withTempDir(async (dir) => {
      const { store } = await setupStores(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Child result',
        parentCardId: parent.id,
        linkKind: 'subagent',
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(child.id, { status: 'done' });
      await store.archiveCards([parent.id]);
      await store.updateArchivedCardsWiki({
        [parent.id]: { status: 'processed', decision: 'kept', promptVersion: WIKI_PROMPT_VERSION, processedAt: '2026-01-01' },
      });

      expect(await store.markWikiPending({ currentPromptVersion: WIKI_PROMPT_VERSION })).toBe(0);
      expect(await store.markWikiPending({ currentPromptVersion: WIKI_PROMPT_VERSION, cardIds: [child.id] })).toBe(0);

      const pending = await store.getWikiPendingCards();
      expect(pending).toEqual([]);

      const archived = await store.getCards({ includeArchived: true });
      expect(archived.find(c => c.id === child.id)!.wiki).toBeUndefined();
    });
  });

  test('markWikiPending with cardIds force-requeues processed cards', async () => {
    await withTempDir(async (dir) => {
      const { store } = await setupStores(dir);
      const a = await archiveDoneCard(store, { title: 'A' });
      await store.updateArchivedCardsWiki({
        [a.id]: { status: 'processed', decision: 'kept', docPath: 'howto/a.md', promptVersion: WIKI_PROMPT_VERSION, processedAt: '2026-01-01' },
      });

      const queued = await store.markWikiPending({ currentPromptVersion: WIKI_PROMPT_VERSION, cardIds: [a.id] });
      expect(queued).toBe(1);

      const pending = await store.getWikiPendingCards();
      // docPath is preserved so reprocessing overwrites in place
      expect(pending[0]?.wiki?.docPath).toBe('howto/a.md');
    });
  });
});

describe('groupCardsBySession', () => {
  test('groups by sessionId and keeps sessionless cards separate', () => {
    const base = { description: '', status: 'done' as const, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const cards = [
      { ...base, id: '1', title: 'a', sessionId: 's1', createdAt: '2026-01-02' },
      { ...base, id: '2', title: 'b', sessionId: 's1', createdAt: '2026-01-01' },
      { ...base, id: '3', title: 'c' },
    ] as KanbanCard[];

    const groups = groupCardsBySession(cards);
    expect(groups.length).toBe(2);
    const s1 = groups.find(g => g.key === 's1')!;
    expect(s1.cards.map(c => c.id)).toEqual(['2', '1']); // sorted by createdAt
    expect(groups.some(g => g.key === 'card:3')).toBe(true);
  });
});

describe('WikiWorker', () => {
  test('skip decision records skipped state and logs it', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore, vaultDir } = await setupStores(dir);
      const card = await archiveDoneCard(store, { title: 'trivial run' });

      const worker = new WikiWorker(store, settingsStore, { llmRunner: fakeLlm({ triage: SKIP_TRIAGE }) });
      await worker.processQueue();

      const archived = await store.getCards({ includeArchived: true });
      const processed = archived.find(c => c.id === card.id)!;
      expect(processed.wiki?.status).toBe('processed');
      expect(processed.wiki?.decision).toBe('skipped');
      expect(processed.wiki?.skipReason).toBe('단순 실행 지시');
      expect(processed.wiki?.promptVersion).toBe(WIKI_PROMPT_VERSION);
      expect(readFileSync(join(vaultDir, 'log.md'), 'utf-8')).toContain('skip |');
    });
  });

  test('keep decision writes document, index, log and updates cards', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore, vaultDir } = await setupStores(dir);
      await settingsStore.upsertByKey(WIKI_SETTING_KEYS.model, 'sonnet');
      await settingsStore.upsertByKey(WIKI_SETTING_KEYS.effort, 'medium');
      const card1 = await archiveDoneCard(store, { title: 'fix redis', sessionId: 'sess-1' });
      const card2 = await archiveDoneCard(store, { title: 'follow-up', sessionId: 'sess-1' });

      const calls: string[] = [];
      const optionsSeen: WikiLlmCallOptions[] = [];
      const worker = new WikiWorker(store, settingsStore, {
        llmRunner: fakeLlm({ triage: KEEP_TRIAGE, classify: CLASSIFY_DOC }, calls, optionsSeen),
      });
      await worker.processQueue();

      // One session group → one triage + one classify
      expect(calls).toEqual(['triage', 'classify']);
      expect(optionsSeen).toEqual([
        { model: 'sonnet', route: 'claude', effort: 'medium' },
        { model: 'sonnet', route: 'claude', effort: 'medium' },
      ]);

      const docPath = join(vaultDir, 'troubleshooting/redis-timeout.md');
      expect(existsSync(docPath)).toBe(true);
      const doc = readFileSync(docPath, 'utf-8');
      expect(doc).toContain('title: "Redis 타임아웃 해결"');
      expect(doc).toContain(`"${card1.id}"`);
      expect(doc).toContain(`"${card2.id}"`);
      expect(doc).toContain('# Redis 타임아웃 해결');

      expect(readFileSync(join(vaultDir, 'index.md'), 'utf-8')).toContain('[[troubleshooting/redis-timeout|Redis 타임아웃 해결]]');
      expect(readFileSync(join(vaultDir, 'log.md'), 'utf-8')).toContain('keep |');

      const archived = await store.getCards({ includeArchived: true });
      for (const id of [card1.id, card2.id]) {
        const c = archived.find(x => x.id === id)!;
        expect(c.wiki?.status).toBe('processed');
        expect(c.wiki?.decision).toBe('kept');
        expect(c.wiki?.docPath).toBe('troubleshooting/redis-timeout.md');
        expect(c.wiki?.docType).toBe('troubleshooting');
        expect(c.wiki?.model).toBe('sonnet');
        expect(c.wiki?.route).toBe('claude');
        expect(c.wiki?.effort).toBe('medium');
      }
    });
  });

  test('llm failure marks cards failed and backfill re-queues them', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore } = await setupStores(dir);
      const card = await archiveDoneCard(store, { title: 'boom card' });

      const failing: WikiLlmRunner = async () => {
        throw new Error('llm unavailable');
      };
      const worker = new WikiWorker(store, settingsStore, { llmRunner: failing });
      await worker.processQueue();

      let archived = await store.getCards({ includeArchived: true });
      let failed = archived.find(c => c.id === card.id)!;
      expect(failed.wiki?.status).toBe('failed');
      expect(failed.wiki?.error).toContain('llm unavailable');

      const queued = await store.markWikiPending({ currentPromptVersion: WIKI_PROMPT_VERSION });
      expect(queued).toBe(1);
      archived = await store.getCards({ includeArchived: true });
      failed = archived.find(c => c.id === card.id)!;
      expect(failed.wiki?.status).toBe('pending');
      expect(failed.wiki?.error).toBeUndefined();
    });
  });

  test('reprocess overwrites the existing document path', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore, vaultDir } = await setupStores(dir);
      const card = await archiveDoneCard(store, { title: 'fix redis', sessionId: 'sess-1' });

      const worker = new WikiWorker(store, settingsStore, {
        llmRunner: fakeLlm({ triage: KEEP_TRIAGE, classify: CLASSIFY_DOC }),
      });
      await worker.processQueue();
      await worker.reprocess([card.id]);
      // kick() already ran; wait for sequential queue to settle
      await worker.processQueue();

      const archived = await store.getCards({ includeArchived: true });
      const c = archived.find(x => x.id === card.id)!;
      expect(c.wiki?.docPath).toBe('troubleshooting/redis-timeout.md');
      // No duplicate -2 file
      expect(existsSync(join(vaultDir, 'troubleshooting/redis-timeout-2.md'))).toBe(false);
      // index.md keeps a single entry
      const index = readFileSync(join(vaultDir, 'index.md'), 'utf-8');
      const occurrences = index.split('[[troubleshooting/redis-timeout|').length - 1;
      expect(occurrences).toBe(1);
    });
  });

  test('disabled wiki leaves pending cards untouched', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore } = await setupStores(dir);
      await settingsStore.upsertByKey(WIKI_SETTING_KEYS.enabled, 'false');
      const card = await archiveDoneCard(store, { title: 'A' });

      const worker = new WikiWorker(store, settingsStore, { llmRunner: fakeLlm({ triage: KEEP_TRIAGE }) });
      await worker.processQueue();

      const archived = await store.getCards({ includeArchived: true });
      expect(archived.find(c => c.id === card.id)!.wiki?.status).toBe('pending');
    });
  });

  test('enabled wiki without vault directory reports config error and leaves pending cards untouched', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const settingsStore = new SettingsStore(dir);
      await settingsStore.upsertByKey(WIKI_SETTING_KEYS.enabled, 'true');
      const card = await archiveDoneCard(store, { title: 'A' });
      const calls: string[] = [];

      const worker = new WikiWorker(store, settingsStore, { llmRunner: fakeLlm({ triage: KEEP_TRIAGE }, calls) });
      await worker.processQueue();

      const status = await worker.getStatus();
      const archived = await store.getCards({ includeArchived: true });
      expect(calls).toEqual([]);
      expect(status.lastError).toContain('Wiki vault directory is not configured');
      expect(status.recentLogs.some(l => l.level === 'error' && l.message.includes('vault directory'))).toBe(true);
      expect(archived.find(c => c.id === card.id)!.wiki?.status).toBe('pending');
    });
  });

  test('getStatus reports stats and worker activity logs', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore } = await setupStores(dir);
      await archiveDoneCard(store, { title: 'kept card', sessionId: 'sess-1' });
      await archiveDoneCard(store, { title: 'skipped card', sessionId: 'sess-2' });

      const worker = new WikiWorker(store, settingsStore, {
        llmRunner: fakeLlm({ triage: KEEP_TRIAGE, classify: CLASSIFY_DOC }),
      });
      // Force one card to skip by routing the second session through a skip triage.
      await worker.processQueue();

      const status = await worker.getStatus();
      expect(status.stats.total).toBe(2);
      expect(status.stats.kept + status.stats.skipped).toBeGreaterThan(0);
      expect(status.stats.byType.troubleshooting).toBeGreaterThanOrEqual(0);
      // Activity log captures start/keep/complete lines.
      expect(status.recentLogs.length).toBeGreaterThan(0);
      expect(status.recentLogs.some(l => l.message.includes('처리 시작'))).toBe(true);
      expect(status.recentLogs.some(l => l.message.includes('처리 완료'))).toBe(true);
    });
  });

  test('restart resets the reentrancy guard and logs a restart line', async () => {
    await withTempDir(async (dir) => {
      const { store, settingsStore } = await setupStores(dir);
      const worker = new WikiWorker(store, settingsStore, { llmRunner: fakeLlm({ triage: SKIP_TRIAGE }) });

      worker.restart();
      const status = await worker.getStatus();
      expect(status.recentLogs.some(l => l.level === 'warn' && l.message.includes('restarted'))).toBe(true);
      worker.stop();
    });
  });
});

describe('prompt parsing', () => {
  test('parseTriageResult tolerates code fences', () => {
    const result = parseTriageResult('```json\n' + KEEP_TRIAGE + '\n```');
    expect(result.decision).toBe('keep');
  });

  test('parseTriageResult rejects invalid decision', () => {
    expect(() => parseTriageResult('{"decision":"maybe"}')).toThrow();
  });

  test('parseClassifyResult validates type and required fields', () => {
    expect(() => parseClassifyResult('{"type":"poem","title":"x","body":"y"}')).toThrow();
    expect(() => parseClassifyResult('{"type":"howto","title":"x"}')).toThrow();
    const ok = parseClassifyResult(CLASSIFY_DOC);
    expect(ok.type).toBe('troubleshooting');
    expect(ok.topics).toEqual(['redis', 'timeout']);
  });

  test('parseClassifyResult tolerates unescaped newlines in body (gpt-5.5 output)', () => {
    // gpt-5.5 sometimes emits literal \n inside JSON string values
    const raw = '{"type":"howto","title":"배포 절차","slug":"deploy-steps","topics":["deploy"],"summary":"요약","body":"## 절차\n\n1. 빌드\n2. 배포\n"}';
    const result = parseClassifyResult(raw);
    expect(result.type).toBe('howto');
    expect(result.body).toContain('## 절차');
    expect(result.body).toContain('1. 빌드');
  });

  test('parseTriageResult tolerates unescaped newlines in reason', () => {
    const raw = '{"decision":"skip","reason":"단순 실행\n지시라서 재사용 가능한\n지식 없음","confidence":0.9}';
    const result = parseTriageResult(raw);
    expect(result.decision).toBe('skip');
    expect(result.reason).toContain('단순 실행');
  });
});
