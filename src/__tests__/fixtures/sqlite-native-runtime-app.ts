import { join } from 'node:path';
import { createKanbanApp } from '../../plugin/bootstrap';
import { createStandaloneRuntimeHost } from '../../plugin/runtimes/runtime-host';

const dataDir = process.env.KANBAN_DATA_DIR;
if (!dataDir || !process.env.KANBAN_PORT) throw Error('explicit fixture paths and port required');
const app = await createKanbanApp({
  dataDir, opencodeInput: null, debugLabel: 'fixture.sqlite-native',
  createDispatch: async (stores) => {
    const stub = join(import.meta.dir, 'sqlite-native-runtime-stub.ts');
    const host = await createStandaloneRuntimeHost({
      ...stores, dataDir,
      codexCommandOverride:[process.execPath,stub,dataDir,'codex'],
      claudeCommandOverride:[process.execPath,stub,dataDir,'claude'],
      codexThreadIdTimeoutMs:3000,claudeSessionIdTimeoutMs:3000,
    });
    return {dispatchCard:host.dispatchCard,runStore:host.runStore,singletonServices:[host.watchdog]};
  },
});
if (!app.port) throw Error('normal app did not listen');
await new Response(Bun.stdin.stream()).text();
app.peerSessionCoordinator.markDraining();
app.unsubscribeRuntimeLock();
app.stopSingleton();
app.monitor.stop();
app.peerSessionCoordinator.unregister();
app.runtimeLock.release();
process.exit(0);
