import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import type { KanbanCard } from '../core/types';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('card runtime options via API', () => {
  test('POST drops invalid option fields so Settings defaults apply; valid fields are kept', async () => {
    await withTempDir(async (dir) => {
      const { handleRequest } = createRouteHandler(new KanbanStore(dir));

      const claudeRes = await handleRequest(jsonRequest('/api/cards', 'POST', {
        title: 'claude', description: 'd', agentRuntime: 'claude',
        claudeOptions: { permissionMode: 'default', dangerouslySkipPermissions: false, effort: 'huge' },
      }));
      expect(claudeRes.status).toBe(201);
      expect(((await claudeRes.json()) as KanbanCard).claudeOptions).toEqual({ dangerouslySkipPermissions: false });

      const onlyInvalid = await handleRequest(jsonRequest('/api/cards', 'POST', {
        title: 'claude2', description: 'd', agentRuntime: 'claude',
        claudeOptions: { permissionMode: 'default' },
      }));
      expect(((await onlyInvalid.json()) as KanbanCard).claudeOptions).toBeUndefined();

      const codexRes = await handleRequest(jsonRequest('/api/cards', 'POST', {
        title: 'codex', description: 'd', agentRuntime: 'codex',
        codexOptions: { sandbox: 'read-only', bypassApprovalsAndSandbox: 'yes', skipGitRepoCheck: false, reasoningEffort: 'high' },
      }));
      expect(((await codexRes.json()) as KanbanCard).codexOptions).toEqual({
        sandbox: 'read-only', skipGitRepoCheck: false, reasoningEffort: 'high',
      });
    });
  });

  test('PATCH replaces options with the valid subset; nothing valid clears them', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 't', description: 'd', agentRuntime: 'claude',
        claudeOptions: { permissionMode: 'plan', effort: 'high' },
      });
      const { handleRequest } = createRouteHandler(store);

      const patched = await handleRequest(jsonRequest(`/api/cards/${card.id}`, 'PATCH', {
        claudeOptions: { permissionMode: 'manual', effort: 'nope' },
      }));
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as KanbanCard).claudeOptions).toEqual({ permissionMode: 'manual' });

      const cleared = await handleRequest(jsonRequest(`/api/cards/${card.id}`, 'PATCH', {
        claudeOptions: { permissionMode: 'default' },
      }));
      expect(((await cleared.json()) as KanbanCard).claudeOptions).toBeUndefined();
    });
  });
});
