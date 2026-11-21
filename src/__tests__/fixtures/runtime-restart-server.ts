import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKanbanApp } from '../../plugin/bootstrap';
import { createStandaloneRuntimeHost } from '../../plugin/runtimes/runtime-host';

const dataDir = process.env.KANBAN_DATA_DIR!;
const app = await createKanbanApp({
  dataDir, opencodeInput: null, debugLabel: 'fixture.restart',
  createDispatch: async options => {
    const host = await createStandaloneRuntimeHost({...options, dataDir});
    return {
      runStore: host.runStore,
      singletonServices: [host.watchdog],
      dispatchCard: async cardId => {
        // Record actual app dispatch invocations; never start a model or real task.
        appendFileSync(join(dataDir, 'fixture-dispatches.txt'), cardId + '\n');
        return {runId:'fixture', sessionId:'fixture', startedAt:new Date().toISOString()};
      },
    };
  },
});
if (!app.port) throw new Error('fixture did not bind its ephemeral server');
console.log(JSON.stringify({port:app.port}));
// The parent closes stdin between boots. Release only this test process.
await new Response(Bun.stdin.stream()).text();
app.peerSessionCoordinator.markDraining();
app.unsubscribeRuntimeLock();
app.stopSingleton();
app.monitor.stop();
app.peerSessionCoordinator.unregister();
app.runtimeLock.release();
