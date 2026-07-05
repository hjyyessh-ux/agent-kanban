import { getKanbanDataDir } from '../plugin/config';
import { appendRuntimeDebugLog } from '../plugin/debug-log';
import { createKanbanApp } from '../plugin/bootstrap';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';

const kanbanDataDir = getKanbanDataDir();

const app = await createKanbanApp({
  dataDir: kanbanDataDir,
  opencodeInput: null,
  debugLabel: 'daemon.runtime',
  createDispatch: async ({ store, settingsStore }) => {
    const runtimeHost = await createStandaloneRuntimeHost({
      store,
      settingsStore,
      dataDir: kanbanDataDir,
    });
    return {
      dispatchCard: runtimeHost.dispatchCard,
      runStore: runtimeHost.runStore,
      runtimeCatalogFn: () => runtimeHost.getRuntimeCatalog(),
      singletonServices: [runtimeHost.watchdog],
    };
  },
});

appendRuntimeDebugLog('daemon.init', {
  port: app.port,
  owner: app.isRuntimeOwner(),
  dataDir: kanbanDataDir,
});

const shutdown = (): void => {
  app.stopSingleton();
  app.runtimeLock.release();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep process alive — all real work is driven by timers inside the services above.
setInterval(() => {}, 30_000).unref();
// Prevent Bun from exiting by holding a ref on a dummy timer
setInterval(() => {}, 1_000 * 60 * 60);
