import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { ChildLinker } from '../plugin/runtimes/child-linker';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { withTempDir } from './setup';

describe('native child recovery preservation', () => {
  test('replays completion and delayed progress without losing request or output; repeated boot is idempotent', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const linker = new ChildLinker(store);
      const parent = await store.createCard({title: 'parent', description: ''});
      const run = await runs.createRun({cardId: parent.id, runtime: 'claude', cwd: dir});
      const events = [
        {type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', prompt: 'Keep this request'},
        {type: 'system', subtype: 'task_notification', task_id: 'child', summary: 'Keep this result'},
        {type: 'system', subtype: 'task_updated', task_id: 'child', patch: {status: 'in_progress'}},
      ];
      await Bun.write(run.eventsPath, events.map(e => JSON.stringify(e)).join('\n'));
      await runs.reconcileStale(store, linker);
      const child = await store.findByChildLink(parent.id, run.runId, 'child');
      expect(child?.status).toBe('complete');
      expect(child?.description).toBe('Keep this request');
      expect(child?.result).toBe('Keep this result');
      expect(child?.resolution).not.toBe('superseded');
      await linker.onChildEvent(parent.id, run.runId, {type: 'subagent_completed', taskId: 'child', summary: 'stale replacement'});
      expect((await store.getCard(child!.id))?.result).toBe('Keep this result');
      expect(await runs.reconcileStale(store, linker)).toHaveLength(0);
      expect(await store.getCards()).toHaveLength(2);
    });
  });

  test('replays Codex child events after restart once without creating unrelated children', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const parent = await store.createCard({title: 'parent', description: '', agentRuntime: 'codex'});
      const run = await runs.createRun({cardId: parent.id, runtime: 'codex', cwd: dir});
      const collab = (tool: string, receivers: string[], states: object, prompt?: string) => ({
        type: 'item.completed', item: {type: 'collab_tool_call', status: 'completed', tool,
          sender_thread_id: 'parent-thread', receiver_thread_ids: receivers, agents_states: states, prompt},
      });
      const raw = [
        {type: 'thread.started', thread_id: 'parent-thread'},
        collab('spawn_agent', ['child'], {}, 'saved request'),
        collab('wait', ['child'], {child: {status: 'completed', message: 'saved result'}}),
        collab('spawn_agent', ['child'], {}, 'duplicate'),
        collab('wait', ['child'], {child: {status: 'completed', message: 'duplicate result'}}),
        collab('spawn_agent', ['interrupted'], {}, 'partial request'),
        {type: 'system', subtype: 'task_started', task_id: 'not-codex', task_type: 'local_agent'},
      ];
      await Bun.write(run.eventsPath, raw.map(e => JSON.stringify(e)).join('\n'));
      await runs.reconcileStale(store, new ChildLinker(store));
      const child = await store.findByChildLink(parent.id, run.runId, 'child');
      expect(child?.parentCardId).toBe(parent.id);
      expect(child?.status).toBe('complete');
      expect(child?.description).toBe('saved request');
      expect(child?.result).toBe('saved result');
      expect((await store.findByChildLink(parent.id, run.runId, 'interrupted'))?.resolution).toBe('superseded');
      const restarted = new RuntimeRunStore(dir);
      expect(await restarted.reconcileStale(new KanbanStore(dir), new ChildLinker(new KanbanStore(dir)))).toHaveLength(0);
      expect(await store.getCards()).toHaveLength(3);
    });
  });

  test('an interrupted recovery retries persisted child events without reopening a newer parent', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const parent = await store.createCard({title: 'parent', description: '', agentRuntime: 'claude'});
      const old = await runs.createRun({cardId: parent.id, runtime: 'claude', cwd: dir});
      await Bun.write(old.eventsPath, JSON.stringify({
        type: 'system', subtype: 'task_started', task_id: 'saved', task_type: 'local_agent',
      }));
      await runs.updateRun(old.runId, {status: 'failed', restartReconcilePending: true});
      const newer = await runs.createRun({cardId: parent.id, runtime: 'claude', cwd: dir});
      await runs.finishRun(newer.runId, {status: 'completed'});
      await store.updateCard(parent.id, {status: 'in_progress', progressSummary: 'newer state'});
      await new RuntimeRunStore(dir).reconcileStale(new KanbanStore(dir), new ChildLinker(new KanbanStore(dir)));
      expect((await store.findByChildLink(parent.id, old.runId, 'saved'))?.parentCardId).toBe(parent.id);
      expect((await store.getCard(parent.id))?.progressSummary).toBe('newer state');
      expect((await store.getCard(parent.id))?.status).toBe('in_progress');
      expect((await runs.getRun(old.runId))?.restartReconcilePending).toBeUndefined();
    });
  });

  test('restart closes only this run children and preserves saved messages and partial result', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const parent = await store.createCard({title: 'parent', description: ''});
      const run = await runs.createRun({cardId: parent.id, runtime: 'claude', cwd: dir});
      const mine = await store.createCard({title: 'mine', description: 'request', parentCardId: parent.id, linkKind: 'subagent', childRunId: run.runId});
      const other = await store.createCard({title: 'other', description: '', parentCardId: parent.id, linkKind: 'subagent', childRunId: 'different-run'});
      const messages = [{direction: 'in' as const, from: 'main', message: 'keep user follow-up'}];
      await store.updateCard(mine.id, {status: 'in_progress', result: 'partial result', agentMessages: messages});
      await store.updateCard(other.id, {status: 'in_progress'});
      await runs.reconcileStale(store);
      expect((await store.getCard(mine.id))?.result).toBe('partial result');
      expect((await store.getCard(mine.id))?.agentMessages).toEqual(messages);
      expect((await store.getCard(mine.id))?.resolution).toBe('superseded');
      expect((await store.getCard(other.id))?.status).toBe('in_progress');
    });
  });

  test('progress completion does not suppress authoritative final summary after partial output', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const linker = new ChildLinker(store);
      const parent = await store.createCard({title: 'parent', description: ''});
      await linker.onChildEvent(parent.id, 'run', {type: 'subagent_started', taskId: 'child', taskType: 'local_agent'});
      const child = await store.findByChildLink(parent.id, 'run', 'child');
      await store.updateCard(child!.id, {result: 'partial', resolution: 'superseded'});
      await linker.onChildEvent(parent.id, 'run', {type: 'subagent_updated', taskId: 'child', status: 'completed'});
      await linker.onChildEvent(parent.id, 'run', {type: 'subagent_completed', taskId: 'child', summary: 'final', usage: {durationMs: 42}});
      const final = await store.getCard(child!.id);
      expect(final?.result).toBe('final');
      expect(final?.finalResult).toBe('final');
      expect(final?.resolution).toBeUndefined();
      expect(final?.durationMs).toBe(42);
    });
  });

  test('reused task labels belong to separate runs under one parent; old progress cannot touch the new child', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const linker = new ChildLinker(store);
      const parent = await store.createCard({title: 'parent', description: ''});
      const start = {type: 'subagent_started' as const, taskId: 'same-label', taskType: 'local_agent'};
      await linker.onChildEvent(parent.id, 'old-run', {...start, prompt: 'old request'});
      await linker.onChildEvent(parent.id, 'old-run', {type: 'subagent_completed', taskId: 'same-label', summary: 'old summary'});
      await linker.onChildEvent(parent.id, 'new-run', {...start, prompt: 'new request'});
      await linker.onChildEvent(parent.id, 'new-run', {type: 'subagent_updated', taskId: 'same-label', status: 'in_progress'});
      const old = await store.findByChildLink(parent.id, 'old-run', 'same-label');
      const newer = await store.findByChildLink(parent.id, 'new-run', 'same-label');
      expect(old?.id).not.toBe(newer?.id);
      expect(old?.parentCardId).toBe(parent.id);
      expect(newer?.parentCardId).toBe(parent.id);
      expect(newer?.description).toBe('new request');
      // A second linker represents same-run replay after restart, not rebind.
      const restarted = new ChildLinker(store);
      await restarted.onChildEvent(parent.id, 'old-run', start);
      await restarted.onChildEvent(parent.id, 'old-run', {type: 'subagent_updated', taskId: 'same-label', status: 'in_progress'});
      await restarted.onChildEvent(parent.id, 'old-run', {type: 'subagent_completed', taskId: 'same-label', summary: 'stale overwrite'});
      expect(await store.getCard(newer!.id)).toEqual(newer);
      expect((await store.getCard(old!.id))?.result).toBe('old summary');
      expect((await store.getCard(old!.id))?.status).toBe('complete');
      expect(await store.getCards()).toHaveLength(3);
    });
  });

  test('concurrent stores reserve one child per run/task and retain separate run ownership', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({title: 'parent', description: ''});
      const event = {type: 'subagent_started' as const, taskId: 'shared', taskType: 'local_agent', prompt: 'request'};
      await Promise.all(Array.from({length: 12}, (_, i) =>
        new ChildLinker(new KanbanStore(dir)).onChildEvent(parent.id, i % 2 ? 'run-a' : 'run-b', event)));
      const cards = (await store.getCards()).filter(c => c.parentCardId === parent.id);
      expect(cards).toHaveLength(2);
      expect(new Set(cards.map(c => c.childRunId)).size).toBe(2);
      expect(cards.every(c => c.description === 'request')).toBe(true);
    });
  });

  test('deleted child tuple is not resurrected by started replay', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({title: 'parent', description: ''});
      const linker = new ChildLinker(store);
      const event = {type: 'subagent_started' as const, taskId: 'child', taskType: 'local_agent'};
      await linker.onChildEvent(parent.id, 'run', event);
      const child = await store.findByChildLink(parent.id, 'run', 'child');
      await store.deleteCard(child!.id);
      await linker.onChildEvent(parent.id, 'run', event);
      expect(await store.findByChildLink(parent.id, 'run', 'child')).toBeNull();
      expect(await store.getCards()).toHaveLength(1);
    });
  });

  test('failure cleanup preserves same-run output/messages and skips other-run or terminal children', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const parent = await store.createCard({title: 'parent', description: ''});
      const linker = new ChildLinker(store);
      for (const run of ['failed', 'other']) {
        await linker.onChildEvent(parent.id, run, {type: 'subagent_started', taskId: 'task', taskType: 'local_agent'});
      }
      const child = await store.findByChildLink(parent.id, 'failed', 'task');
      const messages = [{direction: 'out' as const, to: 'main', message: 'saved response'}];
      await store.updateCard(child!.id, {result: 'partial', agentMessages: messages, startedAt: '2026-01-01T00:00:00Z'});
      await store.supersedeNativeChildren(parent.id, 'failed', '[parent run failed]');
      expect((await store.getCard(child!.id))?.result).toBe('partial');
      expect((await store.getCard(child!.id))?.agentMessages).toEqual(messages);
      expect((await store.getCard(child!.id))?.resolution).toBe('superseded');
      expect((await store.getCard(child!.id))?.completedAt).toBeTruthy();
      expect((await store.getCard(child!.id))?.durationMs).toBeGreaterThan(0);
      expect((await store.findByChildLink(parent.id, 'other', 'task'))?.status).toBe('todo');
      const saved = await store.getCard(child!.id);
      await store.supersedeNativeChildren(parent.id, 'failed', 'repeated');
      expect(await store.getCard(child!.id)).toEqual(saved);
    });
  });

  test('interrupted started-only child is not left as a stray TODO', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const parent = await store.createCard({title: 'parent', description: ''});
      const run = await runs.createRun({cardId: parent.id, runtime: 'claude', cwd: dir});
      await Bun.write(run.eventsPath, JSON.stringify({type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', prompt: 'request'}));
      await runs.reconcileStale(store, new ChildLinker(store));
      const child = await store.findByChildLink(parent.id, run.runId, 'child');
      expect(child?.status).toBe('complete');
      expect(child?.resolution).toBe('superseded');
      expect(child?.description).toBe('request');
    });
  });
});
