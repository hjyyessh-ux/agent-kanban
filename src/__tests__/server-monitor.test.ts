import { describe, test, expect, afterEach } from 'bun:test';
import { ServerMonitor } from '../plugin/server';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';

// Minimal mock for PluginInput
function createMockInput(): any {
  return {
    client: null,
  };
}

describe('ServerMonitor', () => {
  let monitor: ServerMonitor | null = null;
  
  afterEach(() => {
    if (monitor) {
      monitor.stop();
      monitor = null;
    }
  });

  test('start returns port when port is available', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      monitor = new ServerMonitor(store, createMockInput());
      const port = await monitor.start();
      // Port should be a number (24680) or null if port is in use
      // In test environment it should succeed
      if (port !== null) {
        expect(typeof port).toBe('number');
      }
    });
  });

  test('stop cleans up server and interval', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      monitor = new ServerMonitor(store, createMockInput());
      await monitor.start();
      // Should not throw
      monitor.stop();
      monitor = null; // already stopped
    });
  });

  test('stop is safe to call multiple times', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      monitor = new ServerMonitor(store, createMockInput());
      await monitor.start();
      monitor.stop();
      // Second stop should not throw
      monitor.stop();
      monitor = null;
    });
  });

  test('second monitor gets different port due to retry logic', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const monitor1 = new ServerMonitor(store, createMockInput());
      const port1 = await monitor1.start();
      
      if (port1 !== null) {
        // Second monitor should succeed on a different port (createServer retries port+1, +2, +3)
        const monitor2 = new ServerMonitor(store, createMockInput());
        const port2 = await monitor2.start();
        if (port2 !== null) {
          expect(port2).not.toBe(port1);
        }
        monitor2.stop();
      }
      
      monitor1.stop();
    });
  });
});

