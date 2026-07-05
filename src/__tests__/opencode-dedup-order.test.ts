import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { createOpencodeAdapter } from '../plugin/runtimes/opencode-adapter';
import type { OpencodeClient } from '../plugin/runtimes/types';
import { withTempDir } from './setup';

describe('OpencodeAdapter', () => {
  test('preserves updateCard -> trackDispatch -> promptAsync order', async () => {
    await withTempDir(async (dir) => {
      const calls: string[] = [];
      const store = new KanbanStore(dir);
      const originalUpdateCard = store.updateCard.bind(store);
      store.updateCard = async (...args) => {
        calls.push('updateCard');
        return originalUpdateCard(...args);
      };

      const card = await store.createCard({
        title: 'Opencode task',
        description: 'Prompt',
        projectDir: dir,
      });

      const client = {
        session: {
          create: async () => ({
            data: {
              id: 'ses-order',
              title: 'Opencode task',
              time: { created: Date.now() },
            },
          }),
          get: async () => ({ data: undefined }),
          command: async () => undefined,
          promptAsync: async () => {
            calls.push('promptAsync');
          },
        },
        tui: {
          showToast: () => undefined,
        },
      };

      const adapter = createOpencodeAdapter({
        store,
        client: client as unknown as OpencodeClient,
        serverUrl: new URL('http://localhost:24680'),
        trackDispatch: () => calls.push('trackDispatch'),
        buildPromptBody: () => ({ parts: [{ type: 'text', text: 'Prompt' }] }),
        runCommandThenPrompt: async ({ runPrompt }) => {
          await runPrompt();
        },
      });

      const result = await adapter.start({
        card,
        prompt: card.description,
        cwd: dir,
      });

      expect(result.sessionId).toBe('ses-order');
      expect(calls).toEqual(['updateCard', 'trackDispatch', 'promptAsync']);
    });
  });
});
