import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { ChildLinker } from '../plugin/runtimes/child-linker';
import { ClaudeCodexWatchdog } from '../plugin/runtimes/claude-codex-watchdog';
import { withTempDir } from './setup';

const TASK_STARTED_LINE = JSON.stringify({
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-recon-001',
  tool_use_id: 'toolu-recon-xyz',
  subagent_type: 'general-purpose',
  description: 'Reconcile test subagent',
  prompt: 'Do the reconcile work',
  session_id: 'sess-recon',
});

describe('reconcileStale with ChildLinker', () => {
  test('restores missing child card from eventsPath', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const childLinker = new ChildLinker(store);

      const parent = await store.createCard({
        title: 'Parent',
        description: 'p',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.updateCard(parent.id, { status: 'in_progress', sessionId: 'sess-recon' });

      const run = await runStore.createRun({
        cardId: parent.id,
        runtime: 'claude',
        sessionId: 'sess-recon',
        cwd: dir,
      });
      await Bun.write(run.eventsPath, `${TASK_STARTED_LINE}\n`);

      await runStore.reconcileStale(store, childLinker);

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id && c.linkKind === 'subagent');
      expect(children).toHaveLength(1);
      expect(children[0].childTaskId).toBe('task-recon-001');

      const updated = await store.getCard(parent.id);
      expect(updated?.status).toBe('todo');
    });
  });

  test('idempotent: running reconcile twice does not create duplicate child cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const childLinker = new ChildLinker(store);

      const parent = await store.createCard({
        title: 'Parent',
        description: 'p',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.updateCard(parent.id, { status: 'in_progress', sessionId: 'sess-recon' });

      const run = await runStore.createRun({
        cardId: parent.id,
        runtime: 'claude',
        sessionId: 'sess-recon',
        cwd: dir,
      });
      await Bun.write(run.eventsPath, `${TASK_STARTED_LINE}\n`);

      // First reconcile
      await runStore.reconcileStale(store, childLinker);

      // Simulate a second restart: parent is back to in_progress, create another stale run
      await store.updateCard(parent.id, { status: 'in_progress' });
      const run2 = await runStore.createRun({
        cardId: parent.id,
        runtime: 'claude',
        sessionId: 'sess-recon',
        cwd: dir,
      });
      await Bun.write(run2.eventsPath, `${TASK_STARTED_LINE}\n`);

      // Second reconcile
      await runStore.reconcileStale(store, childLinker);

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id && c.linkKind === 'subagent');
      expect(children).toHaveLength(1);
    });
  });

  test('order: in_progress subagent children closed (superseded) before parent returns to todo', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const childLinker = new ChildLinker(store);

      const parent = await store.createCard({
        title: 'Parent',
        description: 'p',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.updateCard(parent.id, { status: 'in_progress' });

      const child = await store.createCard({
        title: 'Child Subagent',
        description: 'c',
        parentCardId: parent.id,
        linkKind: 'subagent',
        childTaskId: 'task-stuck-001',
        childRunId: 'run-old',
      });
      await store.updateCard(child.id, { status: 'in_progress' });

      await runStore.createRun({
        cardId: parent.id,
        runtime: 'claude',
        cwd: dir,
      });

      await runStore.reconcileStale(store, childLinker);

      const updatedChild = await store.getCard(child.id);
      expect(updatedChild?.status).toBe('complete');
      expect(updatedChild?.resolution).toBe('superseded');

      const updatedParent = await store.getCard(parent.id);
      expect(updatedParent?.status).toBe('todo');
    });
  });
});

describe('ClaudeCodexWatchdog', () => {
  test('moves orphaned in_progress claude card (no active run) back to todo', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const card = await store.createCard({
        title: 'Claude Task',
        description: 'stuck',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'sess-orphan' });

      // No run in runStore → orphaned
      await watchdog.check();

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('todo');
    });
  });

  test('does not touch organic codex hook card with no run', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      // Organic prompt-hook card: codex runtime, sourceContext 'codex', no run.
      const card = await store.createCard({
        title: 'Codex prompt',
        description: 'organic CLI use',
        agentRuntime: 'codex',
        sourceContext: 'codex',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'sess-hook' });

      await watchdog.check();

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('in_progress');
    });
  });

  test('does not touch organic claude-code hook card with no run', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const card = await store.createCard({
        title: 'Claude prompt',
        description: 'organic CLI use',
        agentRuntime: 'claude',
        sourceContext: 'claude-code',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'sess-hook-cc' });

      await watchdog.check();

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('in_progress');
    });
  });

  test('does not touch opencode in_progress cards', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const card = await store.createCard({
        title: 'Opencode Task',
        description: 'running',
        agentRuntime: 'opencode',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'sess-oc' });

      await watchdog.check();

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('in_progress');
    });
  });

  test('skips claude card that has an active run', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const card = await store.createCard({
        title: 'Claude Task',
        description: 'still running',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'sess-live' });

      // Create an active run (status: 'running')
      const run = await runStore.createRun({
        cardId: card.id,
        runtime: 'claude',
        sessionId: 'sess-live',
        cwd: dir,
      });
      await runStore.updateRun(run.runId, { status: 'running' });

      await watchdog.check();

      const updated = await store.getCard(card.id);
      // Card should still be in_progress (has an active run)
      expect(updated?.status).toBe('in_progress');
    });
  });
});
