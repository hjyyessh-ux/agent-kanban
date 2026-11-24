import { join } from 'node:path';
import { SqliteBoardStorage } from '../../core/sqlite-board-storage';
import { createKanbanApp } from '../../plugin/bootstrap';

const dataDir = process.env.KANBAN_DATA_DIR;
if (!dataDir || !process.env.KANBAN_PORT) throw Error('Explicit fixture paths/port required');
const boardStorage = new SqliteBoardStorage(join(dataDir,'board.sqlite'));
const app = await createKanbanApp({
  dataDir,boardStorage, opencodeInput:null, debugLabel:'fixture.sqlite',
  createDispatch: async ({store}) => ({
    dispatchCard:async id=>{
      const card=await store.getCard(id);
      if(!card) throw Error('Fixture card missing');
      const sessionId=card.resumeSessionId??'sqlite-fixture-session';
      const startedAt=new Date().toISOString();
      await store.updateCard(id,{status:'in_progress',sessionId,startedAt});
      return {runId:'fixture-run',sessionId,startedAt};
    },
  }),
});
if(!app.port)throw Error('Fixture startup failed');
await new Response(Bun.stdin.stream()).text();
app.peerSessionCoordinator.markDraining();
app.unsubscribeRuntimeLock();
app.stopSingleton();
app.monitor.stop();
app.peerSessionCoordinator.unregister();
app.runtimeLock.release();
process.exit(0);
