import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { createRouteHandler } from '../server/routes';
import { RUNTIME_CATALOG } from '../core/runtime-config';
import { withTempDir } from './setup';

describe('runtime API', () => {
  test('GET /api/runtimes uses injected availability catalog', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const catalog = RUNTIME_CATALOG.map((entry) => ({
        ...entry,
        available: entry.runtime !== 'opencode',
        disabled: entry.runtime === 'opencode',
        unavailableReason: entry.runtime === 'opencode' ? 'daemon unavailable' : undefined,
        hostKind: 'standalone-daemon' as const,
      }));
      const { handleRequest } = createRouteHandler(
        store,
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
        () => catalog,
      );

      const response = await handleRequest(new Request('http://localhost/api/runtimes'));
      expect(response.status).toBe(200);
      const body = await response.json() as { runtimes: typeof catalog };
      const opencode = body.runtimes.find((entry) => entry.runtime === 'opencode');
      const codex = body.runtimes.find((entry) => entry.runtime === 'codex');
      expect(opencode?.available).toBe(false);
      expect(opencode?.disabled).toBe(true);
      expect(opencode?.unavailableReason).toBe('daemon unavailable');
      expect(codex?.available).toBe(true);
      expect(codex?.models?.length).toBeGreaterThan(0);
    });
  });
});
