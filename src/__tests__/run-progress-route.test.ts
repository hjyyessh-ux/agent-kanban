import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { createRouteHandler } from '../server/routes';
import { KanbanStore } from '../core/store';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { createClaudeAdapter } from '../plugin/runtimes/claude-adapter';
import { createCodexCliAdapter } from '../plugin/runtimes/codex-cli-adapter';
import { SettingsStore } from '../core/settings-store';
import type { CardRunProgress } from '../core/types';
import { withTempDir } from './setup';

function buildHandler(store: KanbanStore, runStore?: RuntimeRunStore) {
  return createRouteHandler(
    store,
    undefined, // dispatchFn
    undefined, // schedulerStore
    undefined, // schedulerEngine
    undefined, // settingsStore
    undefined, // onNetworkSettingChange
    undefined, // scriptStore
    undefined, // modelsFn
    undefined, // questionMonitor
    undefined, // aggregateSessionsFn
    undefined, // localPeerSessionsFn
    undefined, // peerTokenFn
    undefined, // runtimeCatalogFn
    undefined, // wikiWorker
    undefined, // skillStore
    undefined, // skillRootsStore
    undefined, // placementTargetsStore
    runStore,
  ).handleRequest;
}

describe('GET /api/cards/:id/progress', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    test(`persists the ${runtime} start before completion and uses the latest run on retry`, async () => {
      await withTempDir(async dir => {
        const store = new KanbanStore(dir);
        const runStore = new RuntimeRunStore(dir);
        const handleRequest = buildHandler(store, runStore);
        const card = await store.createCard({
          title: 'Fixture', description: 'Fixture', agentRuntime: runtime,
          ...(runtime === 'codex' ? { codexOptions: { bypassApprovalsAndSandbox: true } } : {}),
        });
        const request = () => new Request(`http://localhost/api/cards/${card.id}/progress`);
        const read = async (): Promise<CardRunProgress> => {
          const response = await handleRequest(request());
          expect(response.status).toBe(200);
          return response.json();
        };
        const release = join(dir, 'release');
        const fixture = join(dir, 'fake-cli.ts');
        await Bun.write(fixture, `
          const emit = (event) => console.log(JSON.stringify(event));
          await Bun.stdin.text();
          if (${JSON.stringify(runtime)} === 'codex') {
            emit({ type: 'thread.started', thread_id: 'fixture-session' });
            emit({ type: 'item.started', item: { type: 'command_execution', id: 'one', command: 'sleep 30' } });
          } else {
            emit({ type: 'system', subtype: 'init', session_id: 'fixture-session' });
            emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command: 'sleep 30', run_in_background: true } }] } });
            emit({ type: 'system', subtype: 'task_started', task_type: 'local_bash', tool_use_id: 'one', is_backgrounded: true });
          }
          for (let n = 0; n < 300 && !await Bun.file(${JSON.stringify(release)}).exists(); n++) await Bun.sleep(10);
          if (!await Bun.file(${JSON.stringify(release)}).exists()) process.exit(1);
          if (${JSON.stringify(runtime)} === 'codex') {
            emit({ type: 'item.completed', item: { type: 'command_execution', id: 'one', command: 'sleep 30 && printf done' } });
            emit({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } });
            emit({ type: 'turn.completed' });
          } else {
            emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'ok' }] } });
            emit({ type: 'result', result: 'fixture result' });
          }
        `);
        const deps = { store, runStore, settingsStore: new SettingsStore(dir), commandOverride: [process.execPath, fixture] };
        const adapter = runtime === 'codex' ? createCodexCliAdapter(deps) : createClaudeAdapter(deps);
        const lowerBound = Date.now();
        const handle = await adapter.start({ card, prompt: 'fixture', cwd: dir });
        let startedAt: string | undefined;
        try {
          for (let n = 0; n < 100 && !startedAt; n++) {
            startedAt = (await read()).steps[0]?.commandStartedAt;
            if (!startedAt) await Bun.sleep(10);
          }
          expect(startedAt).toBeDefined();
          expect(Date.parse(startedAt ?? '')).toBeGreaterThanOrEqual(lowerBound);
          expect(Date.parse(startedAt ?? '')).toBeLessThanOrEqual(Date.now());
          expect((await read()).steps.map(step => [step.body, step.commandStartedAt])).toEqual([['sleep 30', startedAt]]);
          expect((await runStore.getRun(handle.runId))?.status).toBe('running');
        } finally {
          await Bun.write(release, 'release');
          await handle.done;
        }
        const completed = await read();
        expect(completed.steps.map(step => [step.body, step.commandStartedAt])).toEqual([
          [runtime === 'codex' ? 'sleep 30 && printf done' : 'sleep 30', startedAt],
        ]);
        expect((await store.getCard(card.id))?.result).toBe('fixture result');

        const retry = await adapter.start({ card, prompt: 'fixture retry', cwd: dir, resumeSessionId: handle.sessionId });
        await retry.done;
        const retried = await read();
        expect(retried.runId).toBe(retry.runId);
        expect(retried.steps).toHaveLength(1);
        expect(retried.steps[0].commandStartedAt).toBeDefined();
        expect(retried.steps[0].commandStartedAt).not.toBe(startedAt);

        if (runtime === 'codex') {
          const standardCard = { ...card, codexOptions: { bypassApprovalsAndSandbox: false } };
          const ambiguous = await adapter.start({ card: standardCard, prompt: 'fixture with approvals', cwd: dir });
          await ambiguous.done;
          const progress = await read();
          expect(progress.runId).toBe(ambiguous.runId);
          expect(progress.steps[0].commandStartedAt).toBeUndefined();
        }
      });
    });
  }

  test('serves the parsed step timeline of the card latest run', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });

      const run = await runStore.createRun({
        cardId: card.id,
        runtime: 'claude',
        cwd: dir,
      });
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'verify' } }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
        }),
      ];
      await Bun.write(run.eventsPath, `${lines.join('\n')}\n`);

      const handleRequest = buildHandler(store, runStore);
      const res = await handleRequest(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(res.status).toBe(200);
      const progress = (await res.json()) as CardRunProgress;
      expect(progress.runId).toBe(run.runId);
      expect(progress.steps.map(s => s.kind)).toEqual(['skill', 'command']);
      expect(progress.summary.skills).toEqual(['verify']);
    });
  });

  test('404s when the card has no run or the run store is not wired', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'T', description: 'D' });

      const noRun = await buildHandler(store, runStore)(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(noRun.status).toBe(404);

      const noStore = await buildHandler(store, undefined)(
        new Request(`http://localhost/api/cards/${card.id}/progress`),
      );
      expect(noStore.status).toBe(404);

      const noCard = await buildHandler(store, runStore)(
        new Request('http://localhost/api/cards/missing/progress'),
      );
      expect(noCard.status).toBe(404);
    });
  });
});
