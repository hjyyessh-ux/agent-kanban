import { describe, expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import type { DispatchResult, KanbanCard } from '../core/types';
import { createKanbanApp } from '../plugin/bootstrap';
import { dispatchNextQueuedTodoCard } from '../plugin/hooks/event-handler';
import { resyncCardResult } from '../plugin/runtimes/card-result-resync';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { completeTrackedRuntimeCard, syncInterruptedCards } from '../plugin/runtimes/runtime-restart-sync';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

const START = '2026-02-01T00:01:00.000Z';
const SESSION = 'reused-session';
const codexAnswer = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const codexSuccess = { type: 'turn.completed' };
const claudeAnswer = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const claudeSuccess = { type: 'result', subtype: 'success', is_error: false, session_id: SESSION };
const encode = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function testDispatch(calls: string[]) {
  return async (cardId: string): Promise<DispatchResult> => {
    calls.push(cardId);
    return { runId: 'queued-run', sessionId: 'queued-session', startedAt: START };
  };
}

async function seedRun(
  store: KanbanStore,
  runs: RuntimeRunStore,
  dir: string,
  runtime: 'claude' | 'codex',
  events?: string,
  existing?: KanbanCard,
) {
  const card = existing ?? await store.createCard({ title: 'Task', description: 'Same prompt', agentRuntime: runtime });
  const run = await runs.createRun({ cardId: card.id, cwd: dir, runtime, sessionId: SESSION });
  // Keep the synthetic run's time independent of test execution speed.
  await runs.updateRun(run.runId, { startedAt: START, status: 'running', pid: process.pid });
  await Bun.write(run.promptPath, 'Same prompt');
  if (events !== undefined) await Bun.write(run.eventsPath, events);
  const started = await store.updateCard(card.id, { status: 'in_progress', sessionId: SESSION, startedAt: START });
  return { card: started, run };
}

async function syncBoot(store: KanbanStore, runs: RuntimeRunStore, dispatches: string[] = []) {
  const bootCards = await store.getCards({ status: 'in_progress' });
  const bootRuns = await runs.listRuns();
  await runs.reconcileStale(store, undefined, bootRuns);
  await syncInterruptedCards(store, runs, bootCards, bootRuns, testDispatch(dispatches));
}

async function closeApp(app: Awaited<ReturnType<typeof createKanbanApp>>) {
  app.peerSessionCoordinator.markDraining();
  app.unsubscribeRuntimeLock();
  app.stopSingleton();
  app.monitor.stop();
  app.peerSessionCoordinator.unregister();
  app.runtimeLock.release();
}

describe('runtime restart Sync', () => {
  test('recovers a run after listening, leaves TODO alone and advances the queue once across restarts', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const { card, run } = await seedRun(store, runs, dir, 'codex',
        encode(codexAnswer('First reply'), codexAnswer('Final reply'), codexSuccess));
      const finishedRun = await runs.finishRun(run.runId, { status: 'completed', exitCode: 0 });
      const queued = await store.createCard({ title: 'Next', description: 'Next task' });
      await store.updateCard(queued.id, { queuedAfterCardId: card.id, queuePosition: 1 });
      const todo = await store.createCard({ title: 'Backlog', description: 'Leave in TODO', agentRuntime: 'claude' });
      await seedRun(store, runs, dir, 'claude', encode(claudeAnswer('Existing result'), claudeSuccess), todo);
      const ordinaryTodo = await store.updateCard(todo.id, { status: 'todo' });
      const { card: prior } = await seedRun(store, runs, dir, 'claude', encode(claudeAnswer('Prior result'), claudeSuccess));
      const done = await store.updateCard(prior.id, { status: 'done', result: 'Already reviewed' });
      const dispatches: string[] = [];
      let listenerReady = false;
      // Only the port binding is simulated. Each boot constructs the real app,
      // request handler, singleton lifecycle and stores using the same test data.
      const listener = spyOn(Bun, 'serve').mockImplementation(() => {
        listenerReady = true;
        return { port: 45601, stop() { listenerReady = false; } } as ReturnType<typeof Bun.serve>;
      });

      try {
        for (let boot = 0; boot < 2; boot++) {
          const app = await createKanbanApp({
            dataDir: dir,
            opencodeInput: null,
            debugLabel: 'test.restartSync',
            createDispatch: async options => {
              const host = await createStandaloneRuntimeHost({ ...options, dataDir: dir });
              return {
                runStore: host.runStore,
                singletonServices: [host.watchdog],
                dispatchCard: async cardId => {
                  expect(listenerReady).toBe(true);
                  return testDispatch(dispatches)(cardId);
                },
              };
            },
          });
          try {
            expect(app.monitor.isListening()).toBe(true);
            expect(await app.store.getCard(card.id)).toMatchObject({
              status: 'complete', result: 'First reply\n\nFinal reply', finalResult: 'Final reply',
              completedAt: finishedRun.finishedAt!, sessionId: SESSION, startedAt: START, resolution: 'completed',
            });
            expect((await app.store.getCard(card.id))?.completedSeenAt).toBeUndefined();
            expect(await app.store.getCard(todo.id)).toEqual(ordinaryTodo);
            expect(await app.store.getCard(done.id)).toEqual(done);
            expect(dispatches).toEqual([queued.id]);
          } finally {
            await closeApp(app);
          }
        }
      } finally {
        listener.mockRestore();
      }
      expect((await runs.getRun(run.runId))?.status).toBe('completed');
    });
  });

  test('independent server processes preserve board status and dispatch only one eligible successor', async () => {
    await withTempDir(async root => {
      const dir = join(root, 'data'), home = join(root, 'home');
      await mkdir(dir); await mkdir(home);
      const store = new KanbanStore(dir), runs = new RuntimeRunStore(dir);
      const {card: recovered, run} = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('Real HTTP recovery fixture'), codexSuccess));
      await runs.finishRun(run.runId, {status:'completed', exitCode:0});
      const {card: pending, run: interrupted} = await seedRun(store, runs, dir, 'claude', encode(claudeAnswer('not terminal')));
      const queued = await store.createCard({title:'Queued successor', description:'Fixture only'});
      await store.updateCard(queued.id,{queuedAfterCardId:recovered.id, queuePosition:1});
      const blocked = await store.createCard({title:'Blocked successor', description:'Fixture only'});
      await store.updateCard(blocked.id,{queuedAfterCardId:pending.id, queuePosition:1});
      const ordinary = await store.createCard({title:'Unrelated TODO', description:'Fixture only'});
      const script = new URL('./fixtures/runtime-restart-server.ts', import.meta.url).pathname;
      for (let boot = 0; boot < 2; boot++) {
        const proc = Bun.spawn([process.execPath,script],{
          stdin:'pipe',stdout:'pipe',stderr:'inherit',
          env:{HOME:home, USER:'fixture', PATH:'/usr/bin:/bin', KANBAN_PORT:'0', KANBAN_DATA_DIR:dir,
            KANBAN_RUNTIME_DEBUG_LOG_FILE:join(root,'runtime-debug.log')},
        });
        const reader = proc.stdout.getReader();
        try {
          let output = '';
          const timeout = setTimeout(() => { void reader.cancel(); },5_000);
          try {
            const decoder = new TextDecoder();
            while (!output.includes('\n')) {
              const chunk = await reader.read(); if (chunk.done) throw Error('fixture failed to report port');
              output += decoder.decode(chunk.value,{stream:true});
            }
          } finally {clearTimeout(timeout);}
          const {port} = JSON.parse(output.slice(0,output.indexOf('\n'))) as {port:number};
          const snapshot = async (id: string) => {
            const response = await fetch(`http://127.0.0.1:${port}/api/cards/${id}`,{signal:AbortSignal.timeout(3000)});
            expect(response.status).toBe(200);
            return response.json();
          };
          expect(await snapshot(recovered.id)).toMatchObject({status:'complete', result:'Real HTTP recovery fixture', sessionId:SESSION});
          expect(await snapshot(pending.id)).toMatchObject({status:'in_progress', staleStatus:'orphan', sessionId:SESSION, startedAt:START});
          expect((await snapshot(pending.id)).result).toBeUndefined();
          expect(await snapshot(queued.id)).toMatchObject({status:'todo'});
          expect(await snapshot(blocked.id)).toMatchObject({status:'todo'});
          expect(await snapshot(ordinary.id)).toMatchObject({status:'todo'});
          expect(await readFile(join(dir,'fixture-dispatches.txt'),'utf8')).toBe(queued.id+'\n');
        } finally {
          reader.releaseLock(); proc.stdin.end();
          expect(await proc.exited).toBe(0);
        }
        expect(await new KanbanStore(dir).getCard(recovered.id)).toMatchObject({status:'complete'});
        expect(await new KanbanStore(dir).getCard(pending.id)).toMatchObject({status:'in_progress'});
        expect(await new RuntimeRunStore(dir).getRun(interrupted.runId)).toMatchObject({status:'interrupted'});
      }
    });
  });

  test('requires the latest same-card success and keeps failed, missing or ambiguous runs in progress', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const { card: claude } = await seedRun(store, runs, dir, 'claude', encode(claudeAnswer('Recovered'), claudeSuccess));
      const { card: codex } = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('Recovered'), codexSuccess));
      const { card: repeated, run: older } = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('Old'), codexSuccess));
      await runs.finishRun(older.runId, { status: 'completed', exitCode: 0 });
      const { card: newest, run: newestRun } = await seedRun(store, runs, dir, 'codex',
        encode(codexAnswer('Unfinished')), repeated);
      const { card: failedExit, run: failedRun } = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('Output'), codexSuccess));
      await runs.finishRun(failedRun.runId, { status: 'failed', exitCode: 2 });
      const { card: manualOnly } = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('Unfinished')));
      const unverified = [newest, failedExit, manualOnly];
      for (const [runtime, events] of [
        ['claude', encode(claudeAnswer('Output'), { ...claudeSuccess, subtype: 'error_during_execution', is_error: true })],
        ['claude', encode(claudeAnswer('Output'), { type: 'result', result: 'Unknown' })],
        ['codex', encode(codexAnswer('Output'), codexSuccess, { type: 'turn.failed' })],
        ['codex', encode(codexAnswer('First turn'), codexSuccess, { type: 'turn.started' })],
        ['codex', encode({ type: 'thread.started', thread_id: 'different-session' }, codexAnswer('Output'), codexSuccess)],
        ['codex', encode(codexAnswer('Output'), codexSuccess) + '{truncated'],
        ['codex', undefined],
      ] as const) {
        const { card } = await seedRun(store, runs, dir, runtime, events);
        unverified.push(card);
      }

      const dispatches: string[] = [];
      await syncBoot(store, runs, dispatches);
      for (const card of [claude, codex]) {
        expect(await store.getCard(card.id)).toMatchObject({ status: 'complete', result: 'Recovered', finalResult: 'Recovered' });
      }
      for (const card of unverified) {
        expect(await store.getCard(card.id)).toMatchObject({
          status: 'in_progress', sessionId: SESSION, startedAt: START, staleStatus: 'orphan',
        });
        expect((await store.getCard(card.id))?.progressSummary).toContain('could not be verified');
        expect((await store.getCard(card.id))?.completedAt).toBeUndefined();
        expect((await store.getCard(card.id))?.result).toBeUndefined();
      }
      expect((await runs.getRun(newestRun.runId))?.status).toBe('interrupted');
      expect(await runs.findActiveRunByCard(newest.id)).toBeUndefined();
      const manual = await resyncCardResult({ store, runStore: runs, locateTranscript: () => undefined }, manualOnly.id);
      expect(manual.card).toMatchObject({ result: 'Unfinished', status: 'in_progress' });
      expect(manual.turnCompleted).toBe(false);
      expect(dispatches).toEqual([]);
    });
  });

  test.each(['boot wins', 'late completion wins'])('%s and the queued task starts once', async winner => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const { card, run } = await seedRun(store, runs, dir, 'codex', encode(codexAnswer('From stream'), codexSuccess));
      const queued = await store.createCard({ title: 'Next', description: 'Next task' });
      await store.updateCard(queued.id, { queuedAfterCardId: card.id, queuePosition: 1 });
      const dispatches: string[] = [];
      const dispatch = testDispatch(dispatches);
      const bootCards = [card];
      const bootRuns = await runs.listRuns();
      await runs.reconcileStale(store, undefined, bootRuns);
      const lateStore = new KanbanStore(dir);
      const lateRuns = new RuntimeRunStore(dir);

      let enteredCommit!: () => void;
      let allowCommit!: () => void;
      const waiting = new Promise<void>(resolve => { enteredCommit = resolve; });
      const release = new Promise<void>(resolve => { allowCommit = resolve; });
      const delayedRuns = winner === 'boot wins' ? lateRuns : runs;
      const commit = delayedRuns.withLatestRun.bind(delayedRuns);
      const gate = spyOn(delayedRuns, 'withLatestRun').mockImplementation(async (...args) => {
        enteredCommit();
        await release;
        return commit(...args);
      });
      const boot = () => syncInterruptedCards(store, runs, bootCards, bootRuns, dispatch);
      const hook = async () => {
        const finished = await lateRuns.finishRun(run.runId, { status: 'completed', exitCode: 0 });
        const completed = await completeTrackedRuntimeCard(lateStore, lateRuns, finished, 'From hook', 'From hook');
        if (completed) await dispatchNextQueuedTodoCard(lateStore, card.id, dispatch);
      };

      const delayed = winner === 'boot wins' ? hook() : boot();
      await waiting;
      try {
        await (winner === 'boot wins' ? boot() : hook());
      } finally {
        allowCommit();
        await delayed;
        gate.mockRestore();
      }

      expect(await store.getCard(card.id)).toMatchObject({
        status: 'complete', result: winner === 'boot wins' ? 'From stream' : 'From hook',
      });
      await syncBoot(store, runs, dispatches);
      expect(dispatches).toEqual([queued.id]);
    });
  });

  test('a newer run created while checking the boot snapshot prevents recovery of the old run', async () => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const { card } = await seedRun(store, runs, dir, 'claude', encode(claudeAnswer('Old result'), claudeSuccess));
      const bootRuns = await runs.listRuns();
      await runs.reconcileStale(store, undefined, bootRuns);
      const commit = runs.withLatestRun.bind(runs);
      const gate = spyOn(runs, 'withLatestRun').mockImplementationOnce(async (...args) => {
        // The re-dispatch has reserved a new run, even before it has updated the card.
        await new RuntimeRunStore(dir).createRun({ cardId: card.id, runtime: 'claude', sessionId: SESSION, cwd: dir });
        return commit(...args);
      });
      const dispatches: string[] = [];
      try {
        await syncInterruptedCards(store, runs, [card], bootRuns, testDispatch(dispatches));
      } finally {
        gate.mockRestore();
      }
      expect(await store.getCard(card.id)).toEqual(card);
      expect((await runs.findActiveRunByCard(card.id))?.status).toBe('starting');
      expect(dispatches).toEqual([]);
    });
  });

  test.each(['claude', 'codex'] as const)('an interactive %s Stop hook still completes its unverified card', async runtime => {
    await withTempDir(async dir => {
      const store = new KanbanStore(dir);
      const runs = new RuntimeRunStore(dir);
      const sourceContext = runtime === 'claude' ? 'claude-code' : 'codex';
      const card = await store.createCard({ title: 'Interactive', description: 'Prompt', sourceContext });
      const original = await store.updateCard(card.id, { status: 'in_progress', sessionId: SESSION });
      const trackingDir = join(dir, runtime === 'claude' ? '.claude-hooks' : '.codex-hooks');
      await mkdir(trackingDir);
      await writeFile(join(trackingDir, `${SESSION}.card-id`), card.id);
      await syncBoot(store, runs);
      expect(await store.getCard(card.id)).toEqual(original);

      // Capture the real shell hook's HTTP body without opening a network socket.
      const patchPath = join(dir, 'stop-patch.json');
      await writeFile(join(dir, 'curl'), `#!/bin/bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    printf '%s' "$2" > "$KANBAN_TEST_PATCH"
    exit 0
  fi
  shift
done
`, { mode: 0o755 });
      const hook = Bun.spawn(['bash', join(process.cwd(), `.${runtime}/hooks/on-stop.sh`)], {
        stdin: 'pipe',
        env: {
          ...process.env, HOME: dir, KANBAN_DATA_DIR: dir,
          PATH: `${dir}:${process.env.PATH}`, KANBAN_TEST_PATCH: patchPath,
          AGENT_KANBAN_DISPATCH_CARD_ID: '', KANBAN_API_URL: 'http://isolated-kanban.invalid',
        },
      });
      hook.stdin.write(JSON.stringify({ session_id: SESSION, last_assistant_message: 'Organic result' }));
      hook.stdin.end();
      expect(await hook.exited).toBe(0);
      const body = await readFile(patchPath, 'utf8');
      const patch = JSON.parse(body);
      expect(patch).toEqual({ status: 'complete', result: 'Organic result' });
      const { handleRequest } = createRouteHandler(store);
      const response = await handleRequest(new Request(`http://localhost/api/cards/${card.id}`, {
        method: 'PATCH', body,
      }));
      expect(response.status).toBe(200);
      expect(await store.getCard(card.id)).toMatchObject(patch);
    });
  });
});
