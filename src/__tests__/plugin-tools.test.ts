import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { withTempDir } from './setup';
import {
  createKanbanCreateTool,
  createKanbanListTool,
  createKanbanGetTool,
  createKanbanUpdateTool,
  createKanbanDeleteTool,
} from '../plugin/tools/index';
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

describe('kanban_create tool', () => {
  test('creates a card and returns string', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const result = await tool.execute(
        { title: 'Test Task', description: 'Test Description' },
        mockCtx(),
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('Test Task');
      expect(result).toContain('✅');

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe('Test Task');
    });
  });

  test('creates card with command, skills, and sourceContext', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const result = await tool.execute(
        {
          title: 'Tracked Task',
          description: 'From slash command',
          command: '/start-work',
          skills: ['git-master'],
          sourceContext: '/start-work some-plan',
        },
        mockCtx(),
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('Tracked Task');

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].command).toBe('start-work');
      expect(cards[0].skills).toEqual(['git-master']);
      expect(cards[0].sourceContext).toBe('/start-work some-plan');
    });
  });

  test('dedup: returns existing card instead of creating duplicate for same session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const ctx = mockCtx('dispatch-session-1');

      // First call creates the card
      const result1 = await tool.execute(
        { title: 'Dispatched Task', description: 'Original desc' },
        ctx,
      );
      expect(result1).toContain('✅');

      // Second call with same session should NOT create another card
      const result2 = await tool.execute(
        { title: 'Agent Created Task', description: 'Agent desc' },
        ctx,
      );
      expect(result2).toContain('✅');

      // Only 1 card should exist
      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
    });
  });

  test('dedup: updates existing card fields when they differ', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const ctx = mockCtx('dispatch-session-2');

      await tool.execute(
        { title: 'Original Title', description: 'Original desc' },
        ctx,
      );

      // Second call with different title/description
      await tool.execute(
        { title: 'Updated Title', description: 'Updated desc', command: '/start-work' },
        ctx,
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe('Updated Title');
      expect(cards[0].description).toBe('Updated desc');
      expect(cards[0].command).toBe('start-work');
    });
  });

  test('dedup: different sessions create separate cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);

      await tool.execute(
        { title: 'Session A', description: 'Desc A' },
        mockCtx('session-a'),
      );
      await tool.execute(
        { title: 'Session B', description: 'Desc B' },
        mockCtx('session-b'),
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
    });
  });

  test('dedup: subagent cards (with parentCardId) do not block new top-level cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const sessionId = 'session-with-subagent';

      // Create a subagent card (has parentCardId) for this session
      await store.createCard({
        title: 'Explore#1',
        description: 'Subagent task',
        sessionId,
        parentCardId: 'parent-card-id',
        agentType: 'explore',
      });

      // kanban_create should still create a new top-level card
      // because the existing card is a subagent (has parentCardId)
      await tool.execute(
        { title: 'Top Level Task', description: 'Main task' },
        mockCtx(sessionId),
      );

      const cards = await store.getCards();
      expect(cards).toHaveLength(2);
      const topLevel = cards.find(c => !c.parentCardId);
      expect(topLevel).toBeDefined();
      expect(topLevel!.title).toBe('Top Level Task');
    });
  });

  test('dedup: existing card created by hook is returned by tool (no duplicate)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanCreateTool(store, mockInput);
      const sessionId = 'hook-created-session';

      // Simulate a card created by the chat.message hook (no parentCardId)
      await store.createCard({
        title: 'Hook Created Card',
        description: 'Created by chat.message hook',
        sessionId,
      });

      // Now the tool tries to create a card in the same session
      const result = await tool.execute(
        { title: 'Tool Created Card', description: 'Created by kanban_create' },
        mockCtx(sessionId),
      );
      expect(result).toContain('✅');

      // Should still only have 1 card
      const cards = await store.getCards();
      expect(cards).toHaveLength(1);
      // Card should be updated with tool's title
      expect(cards[0].title).toBe('Tool Created Card');
    });
  });
});

describe('kanban_list tool', () => {
  test('returns all cards as string', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Card 1', description: 'D' });
      await store.createCard({ title: 'Card 2', description: 'D' });
      const tool = createKanbanListTool(store, mockInput);
      const result = await tool.execute({}, mockCtx());
      expect(typeof result).toBe('string');
      expect(result).toContain('Card 1');
      expect(result).toContain('Card 2');
      expect(result).toContain('2 cards');
    });
  });

  test('filters by status', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Todo', description: 'D' });
      const c2 = await store.createCard({ title: 'InProg', description: 'D' });
      await store.updateCard(c2.id, { status: 'in_progress' });
      const tool = createKanbanListTool(store, mockInput);
      const result = await tool.execute({ status: 'todo' }, mockCtx());
      expect(result).toContain('Todo');
      expect(result).not.toContain('InProg');
    });
  });
});

describe('kanban_get tool', () => {
  test('returns card details as string', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Get Me',
        description: 'Full desc',
      });
      const tool = createKanbanGetTool(store, mockInput);
      const result = await tool.execute({ id: card.id }, mockCtx());
      expect(typeof result).toBe('string');
      expect(result).toContain('Get Me');
      expect(result).toContain('Full desc');
    });
  });

  test('returns error for missing card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanGetTool(store, mockInput);
      const result = await tool.execute({ id: 'nonexistent' }, mockCtx());
      expect(result).toContain('❌');
      expect(result).toContain('nonexistent');
    });
  });
});

describe('kanban_update tool', () => {
  test('changes status', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Update',
        description: 'D',
      });
      const tool = createKanbanUpdateTool(store, mockInput);
      const result = await tool.execute(
        { id: card.id, status: 'in_progress' },
        mockCtx(),
      );
      expect(typeof result).toBe('string');
      expect(result).toContain('in_progress');
      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('in_progress');
    });
  });

  test('updates model field', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Model Test', description: 'D' });
      const tool = createKanbanUpdateTool(store, mockInput);
      const result = await tool.execute(
        { id: card.id, model: 'anthropic/claude-sonnet-4-5' },
        mockCtx(),
      );
      expect(typeof result).toBe('string');
      const updated = await store.getCard(card.id);
      expect(updated!.model).toBe('anthropic/claude-sonnet-4-5');
    });
  });

  test('updates queue session mode field', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Queue Mode Test', description: 'D' });
      const tool = createKanbanUpdateTool(store, mockInput);
      await tool.execute(
        {
          id: card.id,
          queuedAfterCardId: 'parent-card',
          queuePosition: 1,
          queueSessionMode: 'continue_queued_after_session',
        },
        mockCtx(),
      );
      const updated = await store.getCard(card.id);
      expect(updated!.queuedAfterCardId).toBe('parent-card');
      expect(updated!.queueSessionMode).toBe('continue_queued_after_session');
    });
  });
});

  test('status-only update does not clear existing result or progressSummary', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Feedback Bug', description: 'D' });
      // Set result and progressSummary on the card first
      await store.updateCard(card.id, {
        status: 'complete',
        result: 'Task completed successfully',
        progressSummary: 'Did some work',
      });
      const tool = createKanbanUpdateTool(store, mockInput);
      // Update only status to 'done' — should NOT clear result or progressSummary
      await tool.execute({ id: card.id, status: 'done' }, mockCtx());
      const updated = await store.getCard(card.id);
      expect(updated!.status).toBe('done');
      expect(updated!.result).toBe('Task completed successfully');
      expect(updated!.progressSummary).toBe('Did some work');
    });
  });

describe('kanban_delete tool', () => {
  test('moves card to trash', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Delete',
        description: 'D',
      });
      const tool = createKanbanDeleteTool(store, mockInput);
      const result = await tool.execute({ id: card.id }, mockCtx());
      expect(typeof result).toBe('string');
      expect(result).toContain('🗑️');
      expect(result).toContain('trash');
      const found = await store.getCard(card.id);
      expect(found).toBeNull();
      const deleted = await store.getDeletedCards();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].id).toBe(card.id);
    });
  });

  test('returns not found for missing card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const tool = createKanbanDeleteTool(store, mockInput);
      const result = await tool.execute({ id: 'missing-card' }, mockCtx());
      expect(result).toContain('Card not found');
    });
  });
});
