import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { createServer } from '../server/index';
import { createKanbanArchiveTool } from '../plugin/tools/kanban_archive';
import { createTestCard, withTempDir } from './setup';
import type { KanbanArchive, KanbanCard, WikiArchiveCardsResponse } from '../core/types';
import type { PluginInput } from '@opencode-ai/plugin';
import type { ToolContext } from '@opencode-ai/plugin';

// Mock PluginInput — only used for factory wiring, not exercised in tests
const mockInput = {
  client: {},
  project: {},
  directory: '/tmp/test-project',
  worktree: '/tmp/test-project',
  serverUrl: new URL('http://localhost:4000'),
  $: {},
} as unknown as PluginInput;

// Mock ToolContext matching the real shape
function mockCtx(sessionId = 'test-session'): ToolContext {
  return {
    sessionID: sessionId,
    messageID: 'test-message',
    agent: 'claude-3',
    directory: '/tmp/test-project',
    worktree: '/tmp/test-project',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as ToolContext;
}

async function withTestServer(callback: (baseUrl: string, store: KanbanStore) => Promise<void>) {
  await withTempDir(async (dir) => {
    const store = new KanbanStore(dir);
    const port = 24700 + Math.floor(Math.random() * 100);
    const { stop, port: actualPort } = createServer(store, port);
    const baseUrl = `http://localhost:${actualPort}`;
    try {
      await callback(baseUrl, store);
    } finally {
      stop();
    }
  });
}

async function writeArchiveMonth(dir: string, month: string, cards: KanbanCard[]): Promise<void> {
  const archiveDir = join(dir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const archive: KanbanArchive = {
    month,
    cards,
    archivedAt: `${month}-28T00:00:00.000Z`,
  };
  await Bun.write(join(archiveDir, `${month}.json`), JSON.stringify(archive, null, 2));
}

describe('kanban_archive tool', () => {
  test('archives all done cards when no cardIds provided', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Done', description: 'D' });
      await store.updateCard(card.id, { status: 'done' });

      const tool = createKanbanArchiveTool(store, mockInput);
      const result = await tool.execute({}, mockCtx());

      expect(typeof result).toBe('string');
      expect(result).toContain('Archived 1 card');
    });
  });

  test('archives specific cards when cardIds provided', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card1 = await store.createCard({ title: 'Done 1', description: 'D' });
      const card2 = await store.createCard({ title: 'Done 2', description: 'D' });
      await store.updateCard(card1.id, { status: 'done' });
      await store.updateCard(card2.id, { status: 'done' });

      const tool = createKanbanArchiveTool(store, mockInput);
      const result = await tool.execute({ cardIds: [card1.id] }, mockCtx());

      expect(typeof result).toBe('string');
      expect(result).toContain('Archived 1 card');

      // card2 should still be active
      const remaining = await store.getCards();
      expect(remaining.some((c) => c.id === card2.id)).toBe(true);
    });
  });

  test('returns message when no done cards exist', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Todo', description: 'D' });

      const tool = createKanbanArchiveTool(store, mockInput);
      const result = await tool.execute({}, mockCtx());

      expect(typeof result).toBe('string');
      expect(result).toContain('No done cards');
    });
  });
});

describe('Archive API routes', () => {
  test('POST /api/archive archives all done cards', async () => {
    await withTestServer(async (url, store) => {
      const card = await store.createCard({ title: 'Done', description: 'D' });
      await store.updateCard(card.id, { status: 'done' });

      const res = await fetch(`${url}/api/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { archivedCount: number; archiveMonth: string };
      expect(body.archivedCount).toBe(1);
      expect(body.archiveMonth).toBeTruthy();
    });
  });

  test('POST /api/archive with cardIds archives specific cards', async () => {
    await withTestServer(async (url, store) => {
      const card1 = await store.createCard({ title: 'Done 1', description: 'D' });
      const card2 = await store.createCard({ title: 'Done 2', description: 'D' });
      await store.updateCard(card1.id, { status: 'done' });
      await store.updateCard(card2.id, { status: 'done' });

      const res = await fetch(`${url}/api/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: [card1.id] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { archivedCount: number };
      expect(body.archivedCount).toBe(1);
    });
  });

  test('POST /api/archive with parent cardIds archives direct done children only', async () => {
    await withTestServer(async (url, store) => {
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const directChild = await store.createCard({
        title: 'Explore#1',
        description: 'Child',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      const unrelatedChild = await store.createCard({
        title: 'Explore#2',
        description: 'Other child',
        parentCardId: 'other-parent',
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(directChild.id, { status: 'done' });
      await store.updateCard(unrelatedChild.id, { status: 'done' });

      const res = await fetch(`${url}/api/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: [parent.id] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { archivedCount: number };
      expect(body.archivedCount).toBe(2);

      const remaining = await store.getCards();
      expect(remaining.map((card) => card.id)).toEqual([unrelatedChild.id]);
    });
  });

  test('POST /api/archive with parent cardIds skips favorite direct children', async () => {
    await withTestServer(async (url, store) => {
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const favoriteChild = await store.createCard({
        title: 'Explore#1',
        description: 'Favorite child',
        parentCardId: parent.id,
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(favoriteChild.id, { status: 'done', favorite: true });

      const res = await fetch(`${url}/api/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: [parent.id] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { archivedCount: number };
      expect(body.archivedCount).toBe(1);

      const remaining = await store.getCards();
      expect(remaining.map((card) => card.id)).toEqual([favoriteChild.id]);
    });
  });

  test('GET /api/cards?include_archived=true returns all cards including archived', async () => {
    await withTestServer(async (url, store) => {
      await store.createCard({ title: 'Active', description: 'D' });
      const done = await store.createCard({ title: 'Archived', description: 'D' });
      await store.updateCard(done.id, { status: 'done' });
      await store.archiveCards();

      // Without include_archived — only active card
      const res1 = await fetch(`${url}/api/cards`);
      expect(res1.status).toBe(200);
      const cards1 = await res1.json() as unknown[];
      expect(cards1).toHaveLength(1);

      // With include_archived — both cards
      const res2 = await fetch(`${url}/api/cards?include_archived=true`);
      expect(res2.status).toBe(200);
      const cards2 = await res2.json() as unknown[];
      expect(cards2).toHaveLength(2);
    });
  });

  test('GET /api/wiki/archive/cards paginates cards by updatedAt desc and skips deleted cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await writeArchiveMonth(dir, '2026-06', [
        createTestCard({ id: 'newest', title: 'Newest', status: 'done', updatedAt: '2026-06-20T12:00:00.000Z' }),
        createTestCard({
          id: 'child',
          title: 'Explore#1',
          status: 'done',
          parentCardId: 'newest',
          updatedAt: '2026-06-19T18:00:00.000Z',
        }),
        createTestCard({ id: 'deleted', title: 'Deleted', status: 'done', updatedAt: '2026-06-19T12:00:00.000Z', deletedAt: '2026-06-20T12:00:00.000Z' }),
        createTestCard({ id: 'middle', title: 'Middle', status: 'done', updatedAt: '2026-06-18T12:00:00.000Z' }),
      ]);
      await writeArchiveMonth(dir, '2026-05', [
        createTestCard({ id: 'older', title: 'Older', status: 'done', updatedAt: '2026-05-20T12:00:00.000Z' }),
        createTestCard({ id: 'oldest', title: 'Oldest', status: 'done', updatedAt: '2026-05-10T12:00:00.000Z' }),
      ]);

      const { stop, port } = createServer(store, 0);
      const baseUrl = `http://localhost:${port}`;
      try {
        const firstRes = await fetch(`${baseUrl}/api/wiki/archive/cards?limit=2`);
        expect(firstRes.status).toBe(200);
        const first = await firstRes.json() as WikiArchiveCardsResponse;
        expect(first.cards.map((card) => card.id)).toEqual(['newest', 'middle']);
        expect(first.nextCursor).toBeTruthy();
        const cursor = first.nextCursor;
        if (!cursor) throw new Error('Expected next cursor');

        const secondRes = await fetch(`${baseUrl}/api/wiki/archive/cards?limit=2&cursor=${encodeURIComponent(cursor)}`);
        expect(secondRes.status).toBe(200);
        const second = await secondRes.json() as WikiArchiveCardsResponse;
        expect(second.cards.map((card) => card.id)).toEqual(['older', 'oldest']);
        expect(second.nextCursor).toBeNull();

        const monthRes = await fetch(`${baseUrl}/api/wiki/archive?month=2026-06`);
        expect(monthRes.status).toBe(200);
        const month = await monthRes.json() as { cards: KanbanCard[] };
        expect(month.cards.map((card) => card.id)).toEqual(['newest', 'middle']);
      } finally {
        stop();
      }
    });
  });

  test('GET /api/wiki/archive/cards filters by wiki status and searches card title/prompt/project', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await writeArchiveMonth(dir, '2026-06', [
        createTestCard({
          id: 'kept',
          title: 'Redis incident',
          description: 'investigate redis timeout',
          projectDir: '/srv/payments-api',
          status: 'done',
          updatedAt: '2026-06-20T12:00:00.000Z',
          wiki: {
            status: 'processed',
            decision: 'kept',
            docTitle: 'Redis timeout guide',
            docPath: 'troubleshooting/redis-timeout.md',
            docType: 'troubleshooting',
            topics: ['redis', 'timeout'],
          },
        }),
        createTestCard({
          id: 'skipped',
          title: 'Tiny command',
          status: 'done',
          updatedAt: '2026-06-19T12:00:00.000Z',
          wiki: { status: 'processed', decision: 'skipped', skipReason: 'too small' },
        }),
        createTestCard({
          id: 'failed',
          title: 'Broken run',
          status: 'done',
          updatedAt: '2026-06-18T12:00:00.000Z',
          wiki: { status: 'failed', error: 'llm unavailable' },
        }),
        createTestCard({
          id: 'pending',
          title: 'Queued run',
          status: 'done',
          updatedAt: '2026-06-17T12:00:00.000Z',
          wiki: { status: 'pending', queuedAt: '2026-06-17T12:00:00.000Z' },
        }),
        createTestCard({
          id: 'child-pending',
          title: 'Explore#1',
          status: 'done',
          parentCardId: 'kept',
          updatedAt: '2026-06-16T18:00:00.000Z',
          wiki: { status: 'pending', queuedAt: '2026-06-16T18:00:00.000Z' },
        }),
        createTestCard({
          id: 'unprocessed',
          title: 'Never queued',
          status: 'done',
          updatedAt: '2026-06-16T12:00:00.000Z',
        }),
      ]);

      const { stop, port } = createServer(store, 0);
      const baseUrl = `http://localhost:${port}`;
      try {
        // Title search.
        const keptRes = await fetch(`${baseUrl}/api/wiki/archive/cards?status=kept&q=incident`);
        expect(keptRes.status).toBe(200);
        const kept = await keptRes.json() as WikiArchiveCardsResponse;
        expect(kept.cards.map((card) => card.id)).toEqual(['kept']);

        // Prompt (description) search.
        const promptRes = await fetch(`${baseUrl}/api/wiki/archive/cards?q=investigate`);
        expect(promptRes.status).toBe(200);
        const prompt = await promptRes.json() as WikiArchiveCardsResponse;
        expect(prompt.cards.map((card) => card.id)).toEqual(['kept']);

        // Project (projectDir) search.
        const projectRes = await fetch(`${baseUrl}/api/wiki/archive/cards?q=payments-api`);
        expect(projectRes.status).toBe(200);
        const project = await projectRes.json() as WikiArchiveCardsResponse;
        expect(project.cards.map((card) => card.id)).toEqual(['kept']);

        // Generated-document fields are NOT searched (docTitle "Redis timeout guide").
        const docRes = await fetch(`${baseUrl}/api/wiki/archive/cards?q=guide`);
        expect(docRes.status).toBe(200);
        const doc = await docRes.json() as WikiArchiveCardsResponse;
        expect(doc.cards).toEqual([]);

        const pendingRes = await fetch(`${baseUrl}/api/wiki/archive/cards?status=pending`);
        expect(pendingRes.status).toBe(200);
        const pending = await pendingRes.json() as WikiArchiveCardsResponse;
        expect(pending.cards.map((card) => card.id)).toEqual(['pending']);

        const unprocessedRes = await fetch(`${baseUrl}/api/wiki/archive/cards?status=unprocessed`);
        expect(unprocessedRes.status).toBe(200);
        const unprocessed = await unprocessedRes.json() as WikiArchiveCardsResponse;
        expect(unprocessed.cards.map((card) => card.id)).toEqual(['unprocessed']);
      } finally {
        stop();
      }
    });
  });
});
