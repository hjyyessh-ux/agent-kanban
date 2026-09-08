import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { createRouteHandler } from '../server/routes';
import { __resetKanbanDataDirCache } from '../core/data-dir';
import { createServer } from '../server/index';
import type { TimelineSnapshot } from '../core/types';

async function withTimelineServer(
  callback: (baseUrl: string, store: KanbanStore) => Promise<void>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kanban-timeline-'));
  const previousDataDir = process.env.KANBAN_DATA_DIR;
  process.env.KANBAN_DATA_DIR = dataDir;
  __resetKanbanDataDirCache();

  const store = new KanbanStore(dataDir);
  const { stop, port } = createServer(store, 0);
  try {
    await callback(`http://localhost:${port}`, store);
  } finally {
    stop();
    if (previousDataDir === undefined) delete process.env.KANBAN_DATA_DIR;
    else process.env.KANBAN_DATA_DIR = previousDataDir;
    __resetKanbanDataDirCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const WINDOW = 'from=2026-09-01T00:00:00.000Z&to=2026-09-07T23:59:59.999Z';

async function seedExecutedCard(
  store: KanbanStore,
  input: {
    title: string;
    sessionId: string;
    startedAt?: string;
    completedAt?: string;
    projectDir?: string;
  },
): Promise<string> {
  const card = await store.createCard({ title: input.title, description: '' });
  await store.updateCard(card.id, {
    sessionId: input.sessionId,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    projectDir: input.projectDir,
  });
  return card.id;
}

describe('GET /api/timeline', () => {
  test('rejects a window it cannot parse', async () => {
    await withTimelineServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/timeline`)).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/timeline?from=nope&to=nope`)).status).toBe(400);
      const reversed = await fetch(
        `${baseUrl}/api/timeline?from=2026-09-07T00:00:00.000Z&to=2026-09-01T00:00:00.000Z`,
      );
      expect(reversed.status).toBe(400);
      expect((await reversed.json() as { error: string }).error).toContain('precede');
    });
  });

  /**
   * The window bounds how much archive this route parses, and it is an
   * unauthenticated GET: `from=1970&to=2030` used to read every archive month
   * on the disk in one request.
   */
  test('refuses a window long enough to read the whole archive', async () => {
    await withTimelineServer(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/timeline?from=1970-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
      );
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('must not exceed');
      // A month view (35 columns) is nowhere near the cap.
      const monthly = await fetch(
        `${baseUrl}/api/timeline?from=2026-08-31T00:00:00.000Z&to=2026-10-04T23:59:59.999Z`,
      );
      expect(monthly.status).toBe(200);
    });
  });

  /**
   * A session with cards on both sides of the window boundary: the ones that
   * finished before `from` are outside what was asked for, so the response omits
   * them — but the session's real start is earlier than the `startedAt` it
   * carries, and the grid has to be told or it draws a closed left edge.
   */
  test('flags a session whose earlier cards fall outside the window', async () => {
    await withTimelineServer(async (baseUrl, store) => {
      await seedExecutedCard(store, {
        title: 'earlier run',
        sessionId: 'ses-spanning',
        startedAt: '2026-08-25T01:00:00.000Z',
        completedAt: '2026-08-25T02:00:00.000Z',
      });
      await seedExecutedCard(store, {
        title: 'run inside the window',
        sessionId: 'ses-spanning',
        startedAt: '2026-09-02T01:00:00.000Z',
        completedAt: '2026-09-02T02:00:00.000Z',
      });
      await seedExecutedCard(store, {
        title: 'wholly inside',
        sessionId: 'ses-inside',
        startedAt: '2026-09-03T01:00:00.000Z',
        completedAt: '2026-09-03T02:00:00.000Z',
      });

      const body = await (await fetch(`${baseUrl}/api/timeline?${WINDOW}`)).json() as TimelineSnapshot;
      const bySession = new Map(body.sessions.map((s) => [s.sessionId, s]));
      const spanning = bySession.get('ses-spanning');
      expect(spanning?.cards.map((c) => c.title)).toEqual(['run inside the window']);
      expect(spanning?.startedAt).toBe('2026-09-02T01:00:00.000Z');
      expect(spanning?.truncatedBefore).toBe(true);
      expect(bySession.get('ses-inside')?.truncatedBefore).toBeUndefined();
    });
  });

  test('returns executed sessions and leaves planned cards off the grid', async () => {
    await withTimelineServer(async (baseUrl, store) => {
      await seedExecutedCard(store, {
        title: 'ran',
        sessionId: 'ses-ran',
        startedAt: '2026-09-02T01:00:00.000Z',
        completedAt: '2026-09-02T01:03:00.000Z',
        projectDir: '/w/agent-kanban',
      });
      await store.createCard({ title: 'never ran', description: '' });

      const res = await fetch(`${baseUrl}/api/timeline?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = await res.json() as TimelineSnapshot;
      expect(body.from).toBe('2026-09-01T00:00:00.000Z');
      expect(body.includesSubagents).toBe(false);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]!.sessionId).toBe('ses-ran');
      expect(body.sessions[0]!.projectDir).toBe('/w/agent-kanban');
      expect(body.sessions[0]!.cards).toHaveLength(1);
      expect(body.sessions[0]!.cards[0]!.title).toBe('ran');
    });
  });

  test('keeps a session after its cards are archived off the board', async () => {
    await withTimelineServer(async (baseUrl, store) => {
      const card = await store.createCard({ title: 'archived run', description: '' });
      // archiveCards only sweeps `done` cards, so reach that status first and
      // stamp the execution window afterwards — the transition rewrites it.
      await store.updateCard(card.id, { status: 'done' });
      await store.updateCard(card.id, {
        sessionId: 'ses-archived',
        startedAt: '2026-09-03T01:00:00.000Z',
        completedAt: '2026-09-03T01:03:00.000Z',
      });
      const cardId = card.id;
      const { archivedCount, archiveMonth } = await store.archiveCards([cardId]);
      expect(archivedCount).toBe(1);
      expect(await store.getCards({})).toHaveLength(0);

      const body = await (await fetch(`${baseUrl}/api/timeline?${WINDOW}`)).json() as TimelineSnapshot;
      expect(body.sessions.map((s) => s.sessionId)).toEqual(['ses-archived']);
      expect(body.scannedMonths).toContain(archiveMonth);
    });
  });

  test('hides subagent cards unless subagents=1', async () => {
    await withTimelineServer(async (baseUrl, store) => {
      const parent = await store.createCard({ title: 'parent', description: '' });
      await store.updateCard(parent.id, {
        sessionId: 'ses-parent',
        startedAt: '2026-09-04T01:00:00.000Z',
        completedAt: '2026-09-04T01:05:00.000Z',
      });
      const sub = await store.createCard({ title: 'subagent', description: '', parentCardId: parent.id });
      await store.updateCard(sub.id, {
        sessionId: 'ses-sub',
        startedAt: '2026-09-04T01:01:00.000Z',
        completedAt: '2026-09-04T01:02:00.000Z',
      });

      const hidden = await (await fetch(`${baseUrl}/api/timeline?${WINDOW}`)).json() as TimelineSnapshot;
      expect(hidden.sessions.map((s) => s.sessionId)).toEqual(['ses-parent']);

      const shown = await (
        await fetch(`${baseUrl}/api/timeline?${WINDOW}&subagents=1`)
      ).json() as TimelineSnapshot;
      expect(shown.includesSubagents).toBe(true);
      expect(shown.sessions.map((s) => s.sessionId).sort()).toEqual(['ses-parent', 'ses-sub']);
    });
  });
});

describe('GET /api/timeline — discarded sessions', () => {
  test('flags an ignored session so its row cannot offer 배정', async () => {
    await withTimelineServer(async (_baseUrl, store) => {
      await seedExecutedCard(store, {
        title: 'kept',
        sessionId: 'ses-kept',
        startedAt: '2026-09-02T01:00:00.000Z',
        completedAt: '2026-09-02T02:00:00.000Z',
      });
      await seedExecutedCard(store, {
        title: 'discarded',
        sessionId: 'ses-discarded',
        startedAt: '2026-09-03T01:00:00.000Z',
        completedAt: '2026-09-03T02:00:00.000Z',
      });

      // The Work store is what knows a session was discarded, so the flag only
      // exists on a server that has one wired — the daemon always does.
      const workStore = new WorkStore(process.env.KANBAN_DATA_DIR!);
      await workStore.ignoreSession('ses-discarded');
      const { handleRequest } = createRouteHandler(
        store, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        workStore,
      );

      const res = await handleRequest(new Request(`http://localhost/api/timeline?${WINDOW}`));
      expect(res.status).toBe(200);
      const snapshot = await res.json() as TimelineSnapshot;
      const bySession = new Map(snapshot.sessions.map((s) => [s.sessionId, s]));
      // A discarded session still ran, so it keeps its row.
      expect(bySession.get('ses-discarded')?.ignored).toBe(true);
      expect(bySession.get('ses-kept')?.ignored).toBeUndefined();
    });
  });
});
