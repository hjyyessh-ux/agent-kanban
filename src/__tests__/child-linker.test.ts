import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { ChildLinker } from '../plugin/runtimes/child-linker';
import { withTempDir } from './setup';

describe('ChildLinker', () => {
  test('started → updated → completed: creates and completes one child card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent Task', description: 'parent desc' });

      const linker = new ChildLinker(store);
      const RUN_ID = 'run-001';
      const TASK_ID = 'task-abc123';

      // subagent_started → child card created
      await linker.onChildEvent(parent.id, RUN_ID, {
        type: 'subagent_started',
        taskId: TASK_ID,
        toolUseId: 'toolu-xyz',
        agentType: 'general-purpose',
        description: 'Do work',
        prompt: 'Do the work now',
        sessionId: 'sess-shared',
      });

      const afterStarted = await store.findByChildLink(parent.id, RUN_ID, TASK_ID);
      expect(afterStarted).not.toBeNull();
      expect(afterStarted!.parentCardId).toBe(parent.id);
      expect(afterStarted!.linkKind).toBe('subagent');
      expect(afterStarted!.childTaskId).toBe(TASK_ID);
      expect(afterStarted!.childToolUseId).toBe('toolu-xyz');
      expect(afterStarted!.childRunId).toBe(RUN_ID);
      expect(afterStarted!.agentType).toBe('general-purpose');
      expect(afterStarted!.agentRuntime).toBe('claude');
      expect(afterStarted!.status).toBe('todo');

      // subagent_updated → in_progress
      await linker.onChildEvent(parent.id, RUN_ID, {
        type: 'subagent_updated',
        taskId: TASK_ID,
        status: 'in_progress',
        sessionId: 'sess-shared',
      });

      const afterUpdated = await store.findByChildLink(parent.id, RUN_ID, TASK_ID);
      expect(afterUpdated!.status).toBe('in_progress');

      // subagent_completed → complete with result + durationMs
      await linker.onChildEvent(parent.id, RUN_ID, {
        type: 'subagent_completed',
        taskId: TASK_ID,
        toolUseId: 'toolu-xyz',
        summary: 'Work done successfully',
        outputFile: '',
        usage: { totalTokens: 5000, durationMs: 2000 },
        sessionId: 'sess-shared',
      });

      const afterCompleted = await store.findByChildLink(parent.id, RUN_ID, TASK_ID);
      expect(afterCompleted!.status).toBe('complete');
      expect(afterCompleted!.result).toBe('Work done successfully');
      expect(afterCompleted!.durationMs).toBe(2000);
    });
  });

  test('idempotent: duplicate subagent_started does not create a second card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'p' });
      const linker = new ChildLinker(store);

      const startedEvent = {
        type: 'subagent_started' as const,
        taskId: 'task-dedup',
        agentType: 'general-purpose',
        description: 'Dedup test',
        prompt: 'Test',
        taskType: 'local_agent',
      };

      await linker.onChildEvent(parent.id, 'run-002', startedEvent);
      await linker.onChildEvent(parent.id, 'run-002', startedEvent); // duplicate

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id);
      expect(children).toHaveLength(1);
    });
  });

  test('skips local_bash background tasks (no agent/prompt) — no junk card', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'p' });
      const linker = new ChildLinker(store);

      // Claude CLI emits task_started for background shell commands too, with
      // task_type 'local_bash' and no subagent_type/prompt. These must NOT become cards.
      await linker.onChildEvent(parent.id, 'run-bash', {
        type: 'subagent_started',
        taskId: 'task-bash',
        description: 'Type check the project',
        taskType: 'local_bash',
      });
      // Its later notification (keyed by task_id) is a no-op since no card exists.
      await linker.onChildEvent(parent.id, 'run-bash', {
        type: 'subagent_completed',
        taskId: 'task-bash',
        summary: 'Type check the project',
      });

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id);
      expect(children).toHaveLength(0);
    });
  });

  test('creates card for real subagent even if task_type missing (agentType present)', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'p' });
      const linker = new ChildLinker(store);

      // Backward-compat: older streams may omit task_type; agentType alone marks a subagent.
      await linker.onChildEvent(parent.id, 'run-compat', {
        type: 'subagent_started',
        taskId: 'task-compat',
        agentType: 'explore',
        description: 'Explore something',
        prompt: 'Find X',
      });

      const child = await store.findByChildLink(parent.id, 'run-compat', 'task-compat');
      expect(child).not.toBeNull();
      expect(child!.agentType).toBe('explore');
    });
  });

  test('subagent_updated and subagent_completed are no-ops when child card not found', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({ title: 'Parent', description: 'p' });
      const linker = new ChildLinker(store);

      // Should not throw even when no child card exists
      await linker.onChildEvent(parent.id, 'run-x', {
        type: 'subagent_updated',
        taskId: 'task-missing',
        status: 'completed',
      });

      await linker.onChildEvent(parent.id, 'run-x', {
        type: 'subagent_completed',
        taskId: 'task-missing',
        summary: 'done',
      });
    });
  });

  test('findCardBySessionId prefers top-level card over linkKind=subagent child', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const SESSION_ID = 'sess-shared';

      const parent = await store.createCard({
        title: 'Parent',
        description: 'p',
        sessionId: SESSION_ID,
      });

      // Child with same sessionId (linkKind=subagent, parentCardId set)
      await store.createCard({
        title: 'Child',
        description: 'c',
        sessionId: SESSION_ID,
        parentCardId: parent.id,
        linkKind: 'subagent',
        childTaskId: 'task-t1',
        childRunId: 'run-r1',
      });

      const found = await store.findCardBySessionId(SESSION_ID);
      expect(found?.id).toBe(parent.id);
    });
  });

  test('findCardBySessionId excludes linkKind=nested cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const SESSION_ID = 'sess-nested-only';

      const parent = await store.createCard({ title: 'Parent', description: 'p' });

      // Only nested-kind card with this sessionId
      await store.createCard({
        title: 'Nested',
        description: 'n',
        sessionId: SESSION_ID,
        parentCardId: parent.id,
        linkKind: 'nested',
      });

      // Should return null because the only match is linkKind=nested
      const found = await store.findCardBySessionId(SESSION_ID);
      expect(found).toBeNull();
    });
  });
});
