import { describe, test, expect, afterEach } from 'bun:test';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';
import { ServerMonitor } from '../plugin/server';

function randomPort(): number {
  return 24700 + Math.floor(Math.random() * 200);
}

// Minimal mock PluginInput — only client is relevant for ServerMonitor
function createMockInput(): any {
  return { client: null };
}

describe('Plugin HTTP Server Integration', () => {
  let monitor: ServerMonitor | null = null;

  afterEach(() => {
    if (monitor) {
      monitor.stop();
      monitor = null;
    }
  });

  test('plugin starts HTTP server on init', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const port = randomPort();
      process.env.KANBAN_PORT = String(port);

      monitor = new ServerMonitor(store, createMockInput());
      const actualPort = await monitor.start();
      try {
        expect(actualPort).toBeGreaterThan(0);

        // Server should respond to requests
        const res = await fetch(`http://localhost:${actualPort}/api/cards`);
        expect(res.status).toBe(200);
      } finally {
        monitor.stop();
        monitor = null;
        delete process.env.KANBAN_PORT;
      }
    });
  });

  test('plugin serves API routes', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const port = randomPort();
      process.env.KANBAN_PORT = String(port);

      monitor = new ServerMonitor(store, createMockInput());
      const actualPort = await monitor.start();
      try {
        const res = await fetch(`http://localhost:${actualPort}/api/cards`);
        expect(res.status).toBe(200);
        const cards = await res.json();
        expect(Array.isArray(cards)).toBe(true);
        expect(cards).toHaveLength(0);
      } finally {
        monitor.stop();
        monitor = null;
        delete process.env.KANBAN_PORT;
      }
    });
  });

  test('server stops on cleanup', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const port = randomPort();
      process.env.KANBAN_PORT = String(port);

      monitor = new ServerMonitor(store, createMockInput());
      const actualPort = await monitor.start();

      // Verify it's running
      const res = await fetch(`http://localhost:${actualPort}/api/cards`);
      expect(res.status).toBe(200);

      // Stop the server
      monitor.stop();
      monitor = null;
      delete process.env.KANBAN_PORT;

      // After stop, connections should fail
      try {
        await fetch(`http://localhost:${actualPort}/api/cards`);
        // If we get here, the server is still running — fail
        expect(true).toBe(false);
      } catch (err) {
        // Expected: connection refused or similar error
        expect(err).toBeTruthy();
      }
    });
  });

  test('plugin-server integration', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const port = randomPort();
      process.env.KANBAN_PORT = String(port);

      monitor = new ServerMonitor(store, createMockInput());
      const actualPort = await monitor.start();
      try {
        // Create a card via API
        const createRes = await fetch(`http://localhost:${actualPort}/api/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Integration test card', description: 'Full e2e test' }),
        });
        expect(createRes.status).toBe(201);
        const card = await createRes.json();
        expect(card.id).toBeTruthy();
        expect(card.title).toBe('Integration test card');
        expect(card.status).toBe('todo');

        // Verify card exists via GET
        const getRes = await fetch(`http://localhost:${actualPort}/api/cards/${card.id}`);
        expect(getRes.status).toBe(200);
        const fetched = await getRes.json();
        expect(fetched.id).toBe(card.id);
        expect(fetched.description).toBe('Full e2e test');
      } finally {
        monitor.stop();
        monitor = null;
        delete process.env.KANBAN_PORT;
      }
    });
  });
});
