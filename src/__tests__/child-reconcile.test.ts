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
      expect(updated?.status).toBe('in_progress');
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

      // Repeat startup without a distinct run; the same persisted run must not be replayed twice.
      const restarted = new RuntimeRunStore(dir);
      await restarted.reconcileStale(new KanbanStore(dir), new ChildLinker(new KanbanStore(dir)));

      const all = await store.getCards();
      const children = all.filter(c => c.parentCardId === parent.id && c.linkKind === 'subagent');
      expect(children).toHaveLength(1);
    });
  });

  test('closes interrupted subagent children and preserves parent status', async () => {
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

      const run = await runStore.createRun({
        cardId: parent.id,
        runtime: 'claude',
        cwd: dir,
      });

      const child = await store.createCard({
        title: 'Child Subagent',
        description: 'c',
        parentCardId: parent.id,
        linkKind: 'subagent',
        childTaskId: 'task-stuck-001',
        childRunId: run.runId,
      });
      await store.updateCard(child.id, { status: 'in_progress' });

      await runStore.reconcileStale(store, childLinker);

      const updatedChild = await store.getCard(child.id);
      expect(updatedChild?.status).toBe('complete');
      expect(updatedChild?.resolution).toBe('superseded');

      const updatedParent = await store.getCard(parent.id);
      expect(updatedParent?.status).toBe('in_progress');
    });
  });
});

describe('ClaudeCodexWatchdog', () => {
  test('flags an orphaned Claude card and keeps it in progress', async () => {
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
      expect(updated?.status).toBe('in_progress');
      expect(updated?.staleStatus).toBe('orphan');
    });
  });

  test('does not mistake a native child for an orphan while its parent runtime owns it', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const linker = new ChildLinker(store);
      const parent = await store.createCard({title: 'parent', description: '', agentRuntime: 'codex'});
      const run = await runs.createRun({cardId: parent.id, runtime: 'codex', cwd: dir});
      await linker.onChildEvent(parent.id, run.runId, {
        type: 'subagent_started', taskType: 'local_agent', taskId: 'child',
      }, 'codex');
      await linker.onChildEvent(parent.id, run.runId, {
        type: 'subagent_updated', status: 'in_progress', taskId: 'child',
      }, 'codex');
      await new ClaudeCodexWatchdog(store, runs).check();
      expect((await store.findByChildLink(parent.id, run.runId, 'child'))?.status).toBe('in_progress');
    });
  });

  test('leaves organic Codex and Claude CLI hook cards in progress without run artifacts', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const codexCard = await store.createCard({
        title: 'Organic Codex Task',
        description: 'direct cli prompt',
        sourceContext: 'codex',
        projectDir: dir,
      });
      const claudeCard = await store.createCard({
        title: 'Organic Claude Task',
        description: 'direct cli prompt',
        sourceContext: 'claude-code',
        projectDir: dir,
      });
      await store.updateCard(codexCard.id, { status: 'in_progress', sessionId: 'codex-hook-session' });
      await store.updateCard(claudeCard.id, { status: 'in_progress', sessionId: 'claude-hook-session' });

      await watchdog.check();

      expect((await store.getCard(codexCard.id))?.status).toBe('in_progress');
      expect((await store.getCard(claudeCard.id))?.status).toBe('in_progress');
    });
  });

  test('keeps dispatched Codex orphan cards in progress and flags missing tracking', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const watchdog = new ClaudeCodexWatchdog(store, runStore);

      const card = await store.createCard({
        title: 'Dispatched Codex Task',
        description: 'dispatch prompt',
        agentRuntime: 'codex',
        projectDir: dir,
      });
      await store.updateCard(card.id, { status: 'in_progress', sessionId: 'codex-dispatch-session' });
      await watchdog.check();

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('in_progress');
      expect(updated?.progressSummary).toContain('No active codex run');
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
