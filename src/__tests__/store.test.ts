import { describe, test, expect } from 'bun:test';
import { KanbanStore } from '../core/store';
import { setDynamicSkillCommands } from '../core/commands';
import { withTempDir } from './setup';

describe('KanbanStore', () => {
  test('creates board file if not exists', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const board = await store.load();
      expect(board.version).toBe(1);
      expect(board.cards).toHaveLength(0);
      expect(board.lastModified).toBeTruthy();
    });
  });

  test('saves and loads a card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Test Task',
        description: 'Test Description',
      });
      expect(card.id).toBeTruthy();
      expect(card.title).toBe('Test Task');
      expect(card.status).toBe('todo');

      const loaded = await store.getCard(card.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Test Task');
    });
  });

  test('updates a card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Update me', description: 'Desc' });
      const updated = await store.updateCard(card.id, { status: 'in_progress', progressSummary: 'Working...' });
      expect(updated.status).toBe('in_progress');
      expect(updated.progressSummary).toBe('Working...');

      // Reload from disk
      const reloaded = await store.getCard(card.id);
      expect(reloaded!.status).toBe('in_progress');
    });
  });

  test('records completion and completion seen timestamps', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Complete me', description: 'Desc' });

      const completed = await store.updateCard(card.id, { status: 'complete' });
      expect(completed.status).toBe('complete');
      expect(completed.completedAt).toBeTruthy();
      expect(completed.completedSeenAt).toBeUndefined();

      const seen = await store.updateCard(card.id, { completedSeenAt: '2026-05-28T10:00:00.000Z' });
      expect(seen.completedAt).toBe(completed.completedAt);
      expect(seen.completedSeenAt).toBe('2026-05-28T10:00:00.000Z');

      const done = await store.updateCard(card.id, { status: 'done' });
      expect(done.status).toBe('done');
      expect(done.completedSeenAt).toBeTruthy();
    });
  });

  test('stamps startedAt on first in_progress and computes durationMs on completion', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Time me', description: 'Desc' });
      expect(card.startedAt).toBeUndefined();

      const started = await store.updateCard(card.id, { status: 'in_progress' });
      expect(started.startedAt).toBeTruthy();
      const firstStartedAt = started.startedAt;

      // Re-entering in_progress must not overwrite the original start time
      await store.updateCard(card.id, { status: 'todo' });
      const restarted = await store.updateCard(card.id, { status: 'in_progress' });
      expect(restarted.startedAt).toBe(firstStartedAt);

      const completed = await store.updateCard(card.id, { status: 'complete' });
      expect(completed.completedAt).toBeTruthy();
      expect(typeof completed.durationMs).toBe('number');
      const expected = new Date(completed.completedAt!).getTime() - new Date(firstStartedAt!).getTime();
      expect(completed.durationMs).toBe(expected);
    });
  });

  test('does not compute durationMs when card was never started', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Never started', description: 'Desc' });
      const completed = await store.updateCard(card.id, { status: 'complete' });
      expect(completed.completedAt).toBeTruthy();
      expect(completed.durationMs).toBeUndefined();
    });
  });

  test('allows explicit startedAt and durationMs overrides, and clears via null', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Override', description: 'Desc' });

      const set = await store.updateCard(card.id, {
        startedAt: '2026-05-28T10:00:00.000Z',
        durationMs: 1234,
      });
      expect(set.startedAt).toBe('2026-05-28T10:00:00.000Z');
      expect(set.durationMs).toBe(1234);

      const cleared = await store.updateCard(card.id, { startedAt: null, durationMs: null });
      expect(cleared.startedAt).toBeUndefined();
      expect(cleared.durationMs).toBeUndefined();
    });
  });

  test('persists and clears response timestamp', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Response time', description: 'Desc' });

      const responded = await store.updateCard(card.id, {
        status: 'complete',
        responseAt: '2026-05-31T12:00:00.000Z',
      });
      expect(responded.responseAt).toBe('2026-05-31T12:00:00.000Z');

      const cleared = await store.updateCard(card.id, { responseAt: null });
      expect(cleared.responseAt).toBeUndefined();
    });
  });

  test('marks completion as seen without changing card updatedAt', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Read me', description: 'Desc' });
      const completed = await store.updateCard(card.id, { status: 'complete' });

      const seen = await store.markCompletionSeen(card.id);

      expect(seen.updatedAt).toBe(completed.updatedAt);
      expect(seen.completedAt).toBe(completed.completedAt);
      expect(seen.completedSeenAt).toBeTruthy();
    });
  });

  test('markCompletionSeen backfills completedAt for legacy complete cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Legacy complete', description: 'Desc' });
      await store.updateCard(card.id, { status: 'complete' });
      const legacy = await store.updateCard(card.id, { completedAt: null });

      const seen = await store.markCompletionSeen(card.id);

      expect(seen.updatedAt).toBe(legacy.updatedAt);
      expect(seen.completedAt).toBe(legacy.updatedAt);
      expect(seen.completedSeenAt).toBeTruthy();
    });
  });

  test('soft-deletes a card and hides it from active reads', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Delete me', description: 'Desc' });
      await store.deleteCard(card.id);

      const found = await store.getCard(card.id);
      expect(found).toBeNull();

      const activeCards = await store.getCards();
      expect(activeCards).toHaveLength(0);

      const deleted = await store.getDeletedCards();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].id).toBe(card.id);
      expect(deleted[0].deletedAt).toBeTruthy();

      const included = await store.getCard(card.id, { includeDeleted: true });
      expect(included!.id).toBe(card.id);
      expect(included!.deletedAt).toBeTruthy();
    });
  });

  test('restores a soft-deleted card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Restore me', description: 'Desc' });
      await store.deleteCard(card.id);

      const restored = await store.restoreCard(card.id);
      expect(restored.id).toBe(card.id);
      expect(restored.deletedAt).toBeUndefined();

      const found = await store.getCard(card.id);
      expect(found!.id).toBe(card.id);
      expect(await store.getDeletedCards()).toHaveLength(0);
    });
  });

  test('generates unique IDs for 100 cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const cards = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          store.createCard({ title: `Card ${i}`, description: `Desc ${i}` })
        )
      );
      const ids = cards.map(c => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(100);
    });
  });

  test('filters cards by status', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Todo 1', description: 'D' });
      await store.createCard({ title: 'Todo 2', description: 'D' });
      const card = await store.createCard({ title: 'Progress', description: 'D' });
      await store.updateCard(card.id, { status: 'in_progress' });

      const todos = await store.getCards({ status: 'todo' });
      expect(todos).toHaveLength(2);
      const inProgress = await store.getCards({ status: 'in_progress' });
      expect(inProgress).toHaveLength(1);
    });
  });

  test('returns all cards when no filter', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'C1', description: 'D' });
      await store.createCard({ title: 'C2', description: 'D' });
      const all = await store.getCards();
      expect(all).toHaveLength(2);
    });
  });

  test('migrates legacy board.json to active.json', async () => {
    await withTempDir(async (dir) => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');
      
      // Create legacy board.json
      const legacyBoard = {
        version: 1,
        cards: [{ id: 'legacy-1', title: 'Old', description: 'Card', status: 'todo', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }],
        lastModified: '2025-01-01T00:00:00Z',
      };
      writeFileSync(join(dir, 'board.json'), JSON.stringify(legacyBoard));
      
      const store = new KanbanStore(dir);
      const board = await store.load();
      
      expect(board.cards).toHaveLength(1);
      expect(board.cards[0].id).toBe('legacy-1');
      // active.json should exist now
      expect(existsSync(join(dir, 'active.json'))).toBe(true);
      // board.json should be renamed to board.json.bak
      expect(existsSync(join(dir, 'board.json'))).toBe(false);
      expect(existsSync(join(dir, 'board.json.bak'))).toBe(true);
    });
  });

  test('archiveCards moves done cards to archive file', async () => {
    await withTempDir(async (dir) => {
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      
      const store = new KanbanStore(dir);
      const card1 = await store.createCard({ title: 'Done 1', description: 'D' });
      const card2 = await store.createCard({ title: 'Done 2', description: 'D' });
      const card3 = await store.createCard({ title: 'Todo', description: 'D' });
      
      await store.updateCard(card1.id, { status: 'done' });
      await store.updateCard(card2.id, { status: 'done' });
      
      const result = await store.archiveCards();
      
      expect(result.archivedCount).toBe(2);
      expect(result.archiveMonth).toBeTruthy();
      
      // Active board should only have the todo card
      const remaining = await store.getCards();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(card3.id);
      
      // Archive dir should exist
      expect(existsSync(join(dir, 'archive'))).toBe(true);
    });
  });

  test('archiveCards with specific cardIds', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card1 = await store.createCard({ title: 'Done 1', description: 'D' });
      const card2 = await store.createCard({ title: 'Done 2', description: 'D' });
      
      await store.updateCard(card1.id, { status: 'done' });
      await store.updateCard(card2.id, { status: 'done' });
      
      // Only archive card1
      const result = await store.archiveCards([card1.id]);
      
      expect(result.archivedCount).toBe(1);
      
      // card2 should still be active
      const remaining = await store.getCards();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(card2.id);
    });
  });

  test('archiveCards with parent cardIds also archives direct done children only', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const directChild = await store.createCard({
        title: 'Explore#1',
        description: 'Child',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      const grandChild = await store.createCard({
        title: 'Oracle#1',
        description: 'Grandchild',
        parentCardId: directChild.id,
        agentType: 'oracle',
      });
      const unrelatedChild = await store.createCard({
        title: 'Explore#2',
        description: 'Unrelated child',
        parentCardId: 'other-parent',
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(directChild.id, { status: 'done' });
      await store.updateCard(grandChild.id, { status: 'done' });
      await store.updateCard(unrelatedChild.id, { status: 'done' });

      const result = await store.archiveCards([parent.id]);

      expect(result.archivedCount).toBe(2);

      const remaining = await store.getCards();
      expect(remaining.map((card) => card.id).sort()).toEqual([
        grandChild.id,
        unrelatedChild.id,
      ].sort());
    });
  });

  test('archiveCards with parent cardIds skips favorite direct children', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const favoriteChild = await store.createCard({
        title: 'Explore#1',
        description: 'Favorite child',
        parentCardId: parent.id,
        agentType: 'explore',
      });

      await store.updateCard(parent.id, { status: 'done' });
      await store.updateCard(favoriteChild.id, { status: 'done', favorite: true });

      const result = await store.archiveCards([parent.id]);

      expect(result.archivedCount).toBe(1);

      const remaining = await store.getCards();
      expect(remaining.map((card) => card.id)).toEqual([favoriteChild.id]);
    });
  });

  test('archiveCards returns 0 when no done cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Todo', description: 'D' });
      
      const result = await store.archiveCards();
      expect(result.archivedCount).toBe(0);
    });
  });

  test('loadArchives returns archived cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Archive me', description: 'D' });
      await store.updateCard(card.id, { status: 'done' });
      
      await store.archiveCards();
      
      const archived = await store.loadArchives();
      expect(archived).toHaveLength(1);
      expect(archived[0].title).toBe('Archive me');
    });
  });

  test('getCards with includeArchived returns both active and archived', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      await store.createCard({ title: 'Active', description: 'D' });
      const card2 = await store.createCard({ title: 'Will archive', description: 'D' });
      await store.updateCard(card2.id, { status: 'done' });
      
      await store.archiveCards();
      
      // Without includeArchived — only active
      const activeOnly = await store.getCards();
      expect(activeOnly).toHaveLength(1);
      expect(activeOnly[0].title).toBe('Active');
      
      // With includeArchived — both
      const all = await store.getCards({ includeArchived: true });
      expect(all).toHaveLength(2);
    });
  });

  test('loadArchives returns empty when no archive dir', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const archived = await store.loadArchives();
      expect(archived).toHaveLength(0);
    });
  });

  test('creates card with command, arguments, skills, and sourceContext fields', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Tracked Task',
        description: 'A task initiated by a slash command',
        command: '/start-work',
        arguments: '--plan sprint-12',
        skills: ['git-master', 'playwright'],
        sourceContext: '/start-work plan-abc',
      });
      expect(card.command).toBe('start-work');
      expect(card.arguments).toBe('--plan sprint-12');
      expect(card.skills).toEqual(['git-master', 'playwright']);
      expect(card.sourceContext).toBe('/start-work plan-abc');

      const loaded = await store.getCard(card.id);
      expect(loaded!.command).toBe('start-work');
      expect(loaded!.arguments).toBe('--plan sprint-12');
      expect(loaded!.skills).toEqual(['git-master', 'playwright']);
      expect(loaded!.sourceContext).toBe('/start-work plan-abc');
    });
  });

  test('infers runtime for Codex and Claude hook source contexts', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const codexCard = await store.createCard({
        title: 'Codex hook task',
        description: 'From Codex hook',
        sourceContext: 'codex',
      });
      const claudeCard = await store.createCard({
        title: 'Claude hook task',
        description: 'From Claude hook',
        sourceContext: 'claude-code',
      });

      expect(codexCard.agentRuntime).toBe('codex');
      expect(claudeCard.agentRuntime).toBe('claude');
    });
  });

  test('normalizes slash-prefixed command to builtin command id', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Slash Command Task',
        description: 'Normalize command format',
        command: '/start-work',
      });

      expect(card.command).toBe('start-work');
      const loaded = await store.getCard(card.id);
      expect(loaded!.command).toBe('start-work');
    });
  });

  test('normalizes commands against the selected runtime', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const codexCard = await store.createCard({
        title: 'Codex Command Task',
        description: 'Use architect prompt',
        agentRuntime: 'codex',
        command: '/prompts:architect',
      });
      const opencodeCard = await store.createCard({
        title: 'Wrong Runtime Command Task',
        description: 'Codex command on opencode should be ignored',
        agentRuntime: 'opencode',
        command: '/prompts:architect',
      });

      expect(codexCard.command).toBe('prompts:architect');
      expect(opencodeCard.command).toBeUndefined();
    });
  });

  test('normalizes Codex skill commands from explicit skill invocation', async () => {
    // skill-creator is no longer a static command; register it as a disk-discovered
    // skill, mirroring how SkillStore.sync() surfaces user skills at runtime.
    setDynamicSkillCommands([
      {
        id: 'skills:skill-creator',
        runtime: 'codex',
        kind: 'codex_skill',
        skillName: 'skill-creator',
        displayName: '$skill-creator',
        description: 'Scaffold a new skill.',
        source: 'test',
        directory: '/tmp/test-skills/skill-creator',
        scope: 'user',
      },
    ]);
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Codex Skill Task',
        description: 'Create a reusable skill',
        agentRuntime: 'codex',
        command: '$skill-creator',
      });

      expect(card.command).toBe('skills:skill-creator');
    });
  });

  test('drops unsupported command values during create', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Unknown Command Task',
        description: 'Ignore unsupported commands',
        command: '/not-a-real-command',
      });

      expect(card.command).toBeUndefined();
    });
  });

  test('omits command/arguments/skills/sourceContext when not provided', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Plain Task',
        description: 'No command tracking',
      });
      expect(card.command).toBeUndefined();
      expect(card.arguments).toBeUndefined();
      expect(card.skills).toBeUndefined();
      expect(card.sourceContext).toBeUndefined();
    });
  });

  test('creates card with parentCardId and agentType, persists to disk', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({
        title: 'Parent Task',
        description: 'Main work',
      });
      const child = await store.createCard({
        title: 'Explore#1',
        description: 'Searching for patterns',
        parentCardId: parent.id,
        agentType: 'explore',
      });
      expect(child.parentCardId).toBe(parent.id);
      expect(child.agentType).toBe('explore');

      // Verify persisted to disk via fresh load
      const loaded = await store.getCard(child.id);
      expect(loaded!.parentCardId).toBe(parent.id);
      expect(loaded!.agentType).toBe('explore');
    });
  });

describe('KanbanStore — Queue Operations', () => {
  test('getQueuedCards returns cards queued after a specific card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child1 = await store.createCard({ title: 'Child 1', description: 'D' });
      const child2 = await store.createCard({ title: 'Child 2', description: 'D' });
      await store.createCard({ title: 'Unrelated', description: 'D' });

      await store.updateCard(child1.id, { queuedAfterCardId: parent.id, queuePosition: 1 });
      await store.updateCard(child2.id, { queuedAfterCardId: parent.id, queuePosition: 2 });

      const queued = await store.getQueuedCards(parent.id);
      expect(queued).toHaveLength(2);
      expect(queued[0].id).toBe(child1.id);
      expect(queued[1].id).toBe(child2.id);
    });
  });

  test('getQueuedCards returns empty array when no cards queued', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Lonely', description: 'D' });
      const queued = await store.getQueuedCards(card.id);
      expect(queued).toHaveLength(0);
    });
  });

  test('getQueuedCards sorts by queuePosition ascending', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const c1 = await store.createCard({ title: 'C1', description: 'D' });
      const c2 = await store.createCard({ title: 'C2', description: 'D' });
      const c3 = await store.createCard({ title: 'C3', description: 'D' });

      // Insert in reverse order
      await store.updateCard(c3.id, { queuedAfterCardId: parent.id, queuePosition: 3 });
      await store.updateCard(c1.id, { queuedAfterCardId: parent.id, queuePosition: 1 });
      await store.updateCard(c2.id, { queuedAfterCardId: parent.id, queuePosition: 2 });

      const queued = await store.getQueuedCards(parent.id);
      expect(queued[0].id).toBe(c1.id);
      expect(queued[1].id).toBe(c2.id);
      expect(queued[2].id).toBe(c3.id);
    });
  });

  test('getNextQueuePosition returns 1 when no cards queued', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Card', description: 'D' });
      const pos = await store.getNextQueuePosition(card.id);
      expect(pos).toBe(1);
    });
  });

  test('getNextQueuePosition returns max+1', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const c1 = await store.createCard({ title: 'C1', description: 'D' });
      const c2 = await store.createCard({ title: 'C2', description: 'D' });

      await store.updateCard(c1.id, { queuedAfterCardId: parent.id, queuePosition: 1 });
      await store.updateCard(c2.id, { queuedAfterCardId: parent.id, queuePosition: 5 });

      const pos = await store.getNextQueuePosition(parent.id);
      expect(pos).toBe(6);
    });
  });

  test('deleteCard clears queue references on dependent cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child1 = await store.createCard({ title: 'Child 1', description: 'D' });
      const child2 = await store.createCard({ title: 'Child 2', description: 'D' });

      await store.updateCard(child1.id, { queuedAfterCardId: parent.id, queuePosition: 1 });
      await store.updateCard(child2.id, { queuedAfterCardId: parent.id, queuePosition: 2 });

      // Delete parent — should cascade clear children
      await store.deleteCard(parent.id);

      const c1 = await store.getCard(child1.id);
      const c2 = await store.getCard(child2.id);
      expect(c1!.queuedAfterCardId).toBeUndefined();
      expect(c1!.queuePosition).toBeUndefined();
      expect(c2!.queuedAfterCardId).toBeUndefined();
      expect(c2!.queuePosition).toBeUndefined();
    });
  });

  test('updateCard with null queuedAfterCardId removes the field', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child = await store.createCard({ title: 'Child', description: 'D' });

      await store.updateCard(child.id, { queuedAfterCardId: parent.id, queuePosition: 1 });
      const before = await store.getCard(child.id);
      expect(before!.queuedAfterCardId).toBe(parent.id);

      // null removes the field
      await store.updateCard(child.id, { queuedAfterCardId: null, queuePosition: null });
      const after = await store.getCard(child.id);
      expect(after!.queuedAfterCardId).toBeUndefined();
      expect(after!.queuePosition).toBeUndefined();
    });
  });

  test('updateCard with undefined queuedAfterCardId preserves existing value', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child = await store.createCard({ title: 'Child', description: 'D' });

      await store.updateCard(child.id, { queuedAfterCardId: parent.id, queuePosition: 3 });

      // Update title only — queue fields should be preserved
      await store.updateCard(child.id, { title: 'Renamed' });
      const after = await store.getCard(child.id);
      expect(after!.title).toBe('Renamed');
      expect(after!.queuedAfterCardId).toBe(parent.id);
      expect(after!.queuePosition).toBe(3);
    });
  });

  test('queue session mode persists with queued cards and clears with null updates', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D', sessionId: 'ses-parent' });
      const child = await store.createCard({ title: 'Child', description: 'D' });

      await store.updateCard(child.id, {
        queuedAfterCardId: parent.id,
        queuePosition: 1,
        queueSessionMode: 'continue_queued_after_session',
      });

      const queued = await store.getCard(child.id);
      expect(queued!.queueSessionMode).toBe('continue_queued_after_session');

      await store.updateCard(child.id, {
        queuedAfterCardId: null,
        queuePosition: null,
        queueSessionMode: null,
      });

      const cleared = await store.getCard(child.id);
      expect(cleared!.queuedAfterCardId).toBeUndefined();
      expect(cleared!.queuePosition).toBeUndefined();
      expect(cleared!.queueSessionMode).toBeUndefined();
    });
  });

  test('deleteCard clears queue session mode on dependent cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'D' });
      const child = await store.createCard({ title: 'Child', description: 'D' });

      await store.updateCard(child.id, {
        queuedAfterCardId: parent.id,
        queuePosition: 1,
        queueSessionMode: 'continue_queued_after_session',
      });

      await store.deleteCard(parent.id);

      const updated = await store.getCard(child.id);
      expect(updated!.queuedAfterCardId).toBeUndefined();
      expect(updated!.queuePosition).toBeUndefined();
      expect(updated!.queueSessionMode).toBeUndefined();
    });
  });


  test('creates card with model field and persists to disk', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Model Card',
        description: 'D',
        model: 'anthropic/claude-sonnet-4-5',
      });
      expect(card.model).toBe('anthropic/claude-sonnet-4-5');
      const loaded = await store.getCard(card.id);
      expect(loaded!.model).toBe('anthropic/claude-sonnet-4-5');
    });
  });

  test('updateCard persists model field', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });
      await store.updateCard(card.id, { model: 'openai/gpt-4o' });
      const updated = await store.getCard(card.id);
      expect(updated!.model).toBe('openai/gpt-4o');
    });
  });

  test('updateCard clears model and agentType fields with null', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'T',
        description: 'D',
        model: 'openai/gpt-4o',
        agentType: 'sisyphus',
      });

      await store.updateCard(card.id, { model: null, agentType: null });

      const updated = await store.getCard(card.id);
      expect(updated!.model).toBeUndefined();
      expect(updated!.agentType).toBeUndefined();
    });
  });

  test('updateCard normalizes and clears command/arguments fields', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });

      await store.updateCard(card.id, {
        command: '/start-work',
        arguments: '--plan sprint-42',
      });

      const updated = await store.getCard(card.id);
      expect(updated!.command).toBe('start-work');
      expect(updated!.arguments).toBe('--plan sprint-42');

      await store.updateCard(card.id, {
        command: null,
        arguments: null,
      });

      const cleared = await store.getCard(card.id);
      expect(cleared!.command).toBeUndefined();
      expect(cleared!.arguments).toBeUndefined();
    });
  });

  test('updateCard throws for non-existent card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      expect(store.updateCard('non-existent', { title: 'X' })).rejects.toThrow('Card not found: non-existent');
    });
  });
});
});
