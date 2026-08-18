import { describe, test, expect } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { KanbanStore } from '../core/store';
import { StaleCardChecker } from '../plugin/stale-checker';
import { withTempDir } from './setup';

function createMockInput(activeSessionIds: string[]): PluginInput {
  return {
    client: {
      session: {
        list: async () => ({
          data: activeSessionIds.map(id => ({ id })),
        }),
      },
    },
    project: {},
    directory: '/tmp/test-project',
    worktree: '/tmp/test-project',
    serverUrl: new URL('http://localhost:4000'),
    $: {},
  } as unknown as PluginInput;
}

describe('StaleCardChecker', () => {
  test('does not mark top-level parent orphan while direct child is still in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const checker = new StaleCardChecker(store, createMockInput(['child-session']));

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Parent task',
        sessionId: 'parent-session',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Child task',
        sessionId: 'child-session',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      await store.updateCard(child.id, { status: 'in_progress' });

      await checker.check();

      const updatedParent = await store.getCard(parent.id);
      const updatedChild = await store.getCard(child.id);

      expect(updatedParent?.staleStatus).toBeUndefined();
      expect(updatedParent?.staleDetectedAt).toBeUndefined();
      expect(updatedChild?.staleStatus).toBeUndefined();
    });
  });

  test('marks top-level parent orphan once direct child is no longer in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const checker = new StaleCardChecker(store, createMockInput([]));

      const parent = await store.createCard({
        title: 'Parent task',
        description: 'Parent task',
        sessionId: 'parent-session',
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Child task',
        sessionId: 'child-session',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      await store.updateCard(child.id, { status: 'complete' });

      await checker.check();

      const updatedParent = await store.getCard(parent.id);
      expect(updatedParent?.staleStatus).toBe('orphan');
      expect(updatedParent?.staleDetectedAt).toBeString();
    });
  });

  test('does not mark Codex cards orphan using opencode session list', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const checker = new StaleCardChecker(store, createMockInput([]));

      const card = await store.createCard({
        title: 'Codex task',
        description: 'Codex task',
        sessionId: 'thread-codex',
        agentRuntime: 'codex',
      });
      await store.updateCard(card.id, { status: 'in_progress' });

      await checker.check();

      const updated = await store.getCard(card.id);
      expect(updated?.staleStatus).toBeUndefined();
      expect(updated?.staleDetectedAt).toBeUndefined();
    });
  });

  test('does not mark long-running tracked script cards as opencode stale work', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const checker = new StaleCardChecker(store, createMockInput([]));
      const card = await store.createCard({
        title: 'Long deployment',
        description: 'Tracked by ScriptExecutionService',
        executionKind: 'script',
        scriptRunId: 'script-run-long',
      });
      await store.updateCard(card.id, { status: 'in_progress' });
      const board = await store.load();
      board.cards[0].updatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await store.save(board);

      await checker.check();

      const updated = await store.getCard(card.id);
      expect(updated).toMatchObject({ status: 'in_progress', executionKind: 'script' });
      expect(updated?.staleStatus).toBeUndefined();
    });
  });

  test('clears stale flags when a card is re-dispatched to in_progress', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);

      const card = await store.createCard({
        title: 'Retry task',
        description: 'Retry task',
        sessionId: 'stale-session',
      });

      await store.updateCard(card.id, {
        status: 'complete',
        staleStatus: 'orphan',
        staleDetectedAt: new Date().toISOString(),
      });

      await store.updateCard(card.id, {
        status: 'in_progress',
        staleStatus: null,
        staleDetectedAt: null,
      });

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('in_progress');
      expect(updated?.staleStatus).toBeUndefined();
      expect(updated?.staleDetectedAt).toBeUndefined();
    });
  });
});
