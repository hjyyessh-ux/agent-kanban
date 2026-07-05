import { describe, test, expect } from 'bun:test';
import { createServer } from '../server/index';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';

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

describe('HTTP API Server', () => {
  test('GET /api/cards returns empty array', async () => {
    await withTestServer(async (url) => {
      const res = await fetch(`${url}/api/cards`);
      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(Array.isArray(cards)).toBe(true);
      expect(cards).toHaveLength(0);
    });
  });

  test('POST /api/cards creates card', async () => {
    await withTestServer(async (url) => {
      const res = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test task', description: 'Test desc' }),
      });
      expect(res.status).toBe(201);
      const card = await res.json();
      expect(card.id).toBeTruthy();
      expect(card.title).toBe('Test task');
      expect(card.status).toBe('todo');
    });
  });

  test('GET /api/cards/:id returns card', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Get me', description: 'Desc' }),
      });
      const card = await createRes.json();
      const getRes = await fetch(`${url}/api/cards/${card.id}`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.id).toBe(card.id);
    });
  });

  test('PATCH /api/cards/:id updates card', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Update me', description: 'Desc' }),
      });
      const card = await createRes.json();
      const patchRes = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.status).toBe('in_progress');
    });
  });

  test('PATCH /api/cards/:id persists favorite flag', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Favorite me', description: 'Desc' }),
      });
      const card = await createRes.json();

      const patchRes = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: true }),
      });

      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.favorite).toBe(true);

      const getRes = await fetch(`${url}/api/cards/${card.id}`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.favorite).toBe(true);
    });
  });

  test('POST /api/cards/:id/completion-seen marks complete card without changing updatedAt', async () => {
    await withTestServer(async (url, store) => {
      const card = await store.createCard({ title: 'Read complete', description: 'Desc' });
      const completed = await store.updateCard(card.id, { status: 'complete' });

      const seenRes = await fetch(`${url}/api/cards/${card.id}/completion-seen`, {
        method: 'POST',
      });

      expect(seenRes.status).toBe(200);
      const seen = await seenRes.json();
      expect(seen.completedSeenAt).toBeTruthy();
      expect(seen.completedAt).toBe(completed.completedAt);
      expect(seen.updatedAt).toBe(completed.updatedAt);
    });
  });

  test('PATCH /api/cards/:id allows runtime changes only before dispatch', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Runtime change', description: 'Desc', agentRuntime: 'opencode' }),
      });
      const card = await createRes.json();

      const todoPatch = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentRuntime: 'codex' }),
      });
      expect(todoPatch.status).toBe(200);
      expect((await todoPatch.json()).agentRuntime).toBe('codex');

      const statusPatch = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      expect(statusPatch.status).toBe(200);

      const runtimePatch = await fetch(`${url}/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentRuntime: 'claude' }),
      });
      expect(runtimePatch.status).toBe(400);
      expect(await runtimePatch.json()).toEqual({ error: 'Can only change runtime before dispatch' });
    });
  });

  test('DELETE /api/cards/:id soft-deletes card and restore makes it active again', async () => {
    await withTestServer(async (url) => {
      const createRes = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Delete me', description: 'Desc' }),
      });
      const card = await createRes.json();
      const deleteRes = await fetch(`${url}/api/cards/${card.id}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(204);
      const getRes = await fetch(`${url}/api/cards/${card.id}`);
      expect(getRes.status).toBe(404);

      const listRes = await fetch(`${url}/api/cards`);
      expect(await listRes.json()).toHaveLength(0);

      const deletedRes = await fetch(`${url}/api/cards/deleted`);
      expect(deletedRes.status).toBe(200);
      const deletedCards = await deletedRes.json();
      expect(deletedCards).toHaveLength(1);
      expect(deletedCards[0].id).toBe(card.id);
      expect(deletedCards[0].deletedAt).toBeTruthy();

      const restoreRes = await fetch(`${url}/api/cards/${card.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      const restored = await restoreRes.json();
      expect(restored.id).toBe(card.id);
      expect(restored.deletedAt).toBeUndefined();

      const restoredGetRes = await fetch(`${url}/api/cards/${card.id}`);
      expect(restoredGetRes.status).toBe(200);
    });
  });

  test('GET /api/cards?status=todo filters correctly', async () => {
    await withTestServer(async (url, store) => {
      await store.createCard({ title: 'Todo card', description: 'D' });
      const card2 = await store.createCard({ title: 'Progress card', description: 'D' });
      await store.updateCard(card2.id, { status: 'in_progress' });

      const res = await fetch(`${url}/api/cards?status=todo`);
      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards).toHaveLength(1);
      expect(cards[0].status).toBe('todo');
    });
  });


  test('404 for unknown routes', async () => {
    await withTestServer(async (url) => {
      const res = await fetch(`${url}/unknown/path`);
      expect(res.status).toBe(404);
    });
  });

  test('no wildcard CORS header on responses (same-origin policy)', async () => {
    await withTestServer(async (url) => {
      const res = await fetch(`${url}/api/cards`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  test('cross-origin browser request is rejected', async () => {
    await withTestServer(async (url) => {
      // Same-origin request (no Origin header) succeeds.
      const ok = await fetch(`${url}/api/board`);
      expect(ok.status).toBe(200);

      // A request carrying a foreign Origin (drive-by / CSRF) is blocked.
      const blocked = await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://evil.example.com',
        },
        body: JSON.stringify({ title: 'x', description: 'y' }),
      });
      expect(blocked.status).toBe(403);
    });
  });

  test('GET /api/internal/sessions/native requires bearer token', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const port = 24700 + Math.floor(Math.random() * 100);
      const localPeerSessionsFn = async () => ({
        instanceId: 'instance-a',
        port: 24680,
        cwd: '/Users/user/workspace/agent-kanban',
        sessions: [{ sessionId: 'ses-a', sessionTitle: 'Native Session', updatedAt: '2026-04-03T00:00:00.000Z' }],
      });
      const peerTokenFn = () => 'peer-token-123';

      const { stop, port: actualPort } = createServer(
        store,
        port,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        localPeerSessionsFn,
        peerTokenFn,
      );

      const baseUrl = `http://localhost:${actualPort}`;
      try {
        const unauthorized = await fetch(`${baseUrl}/api/internal/sessions/native`);
        expect(unauthorized.status).toBe(401);

        const authorized = await fetch(`${baseUrl}/api/internal/sessions/native`, {
          headers: { Authorization: 'Bearer peer-token-123' },
        });
        expect(authorized.status).toBe(200);
        const payload = await authorized.json() as {
          instanceId: string;
          sessions: Array<{ sessionId: string }>;
        };
        expect(payload.instanceId).toBe('instance-a');
        expect(payload.sessions[0]?.sessionId).toBe('ses-a');
      } finally {
        stop();
      }
    });
  });

  test('GET /api/sessions uses aggregateSessionsFn when provided', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Linked card',
        description: 'Linked card',
        sessionId: 'ses-native',
        sessionTitle: 'Linked Session',
        agentType: 'hephaestus',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      const port = 24700 + Math.floor(Math.random() * 100);
      const aggregateSessionsFn = async () => [
        {
          sessionId: 'ses-native',
          sessionTitle: 'Native Session',
          updatedAt: '2026-04-03T00:00:00.000Z',
          sourceInstanceId: 'peer-a',
          sourcePort: 24680,
          sourceCwd: '/Users/user/workspace/agent-kanban',
        },
      ];

      const { stop, port: actualPort } = createServer(
        store,
        port,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        aggregateSessionsFn,
      );
      const baseUrl = `http://localhost:${actualPort}`;

      try {
        const res = await fetch(`${baseUrl}/api/sessions`);
        expect(res.status).toBe(200);
        const sessions = await res.json() as Array<{
          sessionId: string;
          cardTitle: string;
          linkState: string;
          relatedCardCount: number;
          isSubagentOnly: boolean;
          visiblePeerCount: number;
          primaryPeerInstanceId?: string;
          primaryPeerIsLocal?: boolean;
          primaryPeerCwd?: string;
        }>;
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.sessionId).toBe('ses-native');
        expect(sessions[0]?.cardTitle).toBe('Linked card');
        expect(sessions[0]?.linkState).toBe('single');
        expect(sessions[0]?.relatedCardCount).toBe(1);
        expect(sessions[0]?.isSubagentOnly).toBe(false);
        expect(sessions[0]?.visiblePeerCount).toBe(1);
        expect(sessions[0]?.primaryPeerInstanceId).toBe('peer-a');
        expect(sessions[0]?.primaryPeerIsLocal).toBe(false);
        expect(sessions[0]?.primaryPeerCwd).toBe('/Users/user/workspace/agent-kanban');
      } finally {
        stop();
      }
    });
  });

  test('GET /api/sessions marks subagent-only linked session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({
        title: 'Subagent child card',
        description: 'Subagent child card',
        sessionId: 'ses-sub-only',
        parentCardId: 'parent-card-1',
        agentType: 'explore',
      });

      const aggregateSessionsFn = async () => [
        {
          sessionId: 'ses-sub-only',
          sessionTitle: 'Subagent Session',
          updatedAt: '2026-04-03T00:00:00.000Z',
          sourceInstanceId: 'peer-sub',
          sourcePort: 24681,
          sourceCwd: '/Users/user/workspace/mcp-server',
        },
      ];

      const port = 24700 + Math.floor(Math.random() * 100);
      const { stop, port: actualPort } = createServer(
        store,
        port,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        aggregateSessionsFn,
      );

      const baseUrl = `http://localhost:${actualPort}`;
      try {
        const res = await fetch(`${baseUrl}/api/sessions`);
        expect(res.status).toBe(200);
        const sessions = await res.json() as Array<{
          sessionId: string;
          isSubagentOnly: boolean;
          hasTopLevelLinkedCard: boolean;
          hasSubagentLinkedCard: boolean;
          primaryPeerPort?: number;
          primaryPeerIsLocal?: boolean;
          primaryPeerCwd?: string;
        }>;
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.sessionId).toBe('ses-sub-only');
        expect(sessions[0]?.isSubagentOnly).toBe(true);
        expect(sessions[0]?.hasTopLevelLinkedCard).toBe(false);
        expect(sessions[0]?.hasSubagentLinkedCard).toBe(true);
        expect(sessions[0]?.primaryPeerPort).toBe(24681);
        expect(sessions[0]?.primaryPeerIsLocal).toBe(false);
        expect(sessions[0]?.primaryPeerCwd).toBe('/Users/user/workspace/mcp-server');
      } finally {
        stop();
      }
    });
  });
});
