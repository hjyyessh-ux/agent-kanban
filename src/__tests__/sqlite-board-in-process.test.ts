import {expect,test} from 'bun:test';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SqliteBoardStorage,SQLITE_STORAGE_MARKER,SQLITE_STORAGE_VERSION} from '../core/sqlite-board-storage';
import {KanbanStore} from '../core/store';
import {WorkStore} from '../core/work-store';
import {BoardHistoryService,installBoardHistory,observeCards} from '../core/board-history';
import {importFrozenBoard} from '../core/import-frozen-board';
import {withTempDir} from './setup';

const setup=(dir:string)=>{
  const path=join(dir,'board.sqlite');
  const storage=new SqliteBoardStorage(path);
  return {path,storage,cards:new KanbanStore(dir,storage),works:new WorkStore(dir,storage)};
};

test('existing domain stores share SQLite and preserve card/Work/archive/attachments across reopening',()=>withTempDir(async dir=>{
  const s=setup(dir);
  const card=await s.cards.createCard({title:'existing store',description:'synthetic',sessionId:'fixture-session'});
  const attachment=await s.cards.saveScreenshot(card.id,new Uint8Array([9,4,3]).buffer,'image.png','image/png');
  const work=await s.works.createWork({title:'existing Work'});
  await s.works.addSession(work.id,{sessionId:'fixture-session'});
  await s.cards.updateCard(card.id,{status:'done'});
  const archived=await s.cards.archiveCards([card.id]);
  expect(archived.archivedCount).toBe(1);
  expect(await s.cards.getCard(card.id)).toBeNull();
  const after=setup(dir);
  expect((await after.cards.getCard(card.id,{includeArchived:true}))?.screenshots).toEqual([attachment]);
  expect([...readFileSync(after.cards.getScreenshotPath(attachment.filename))]).toEqual([9,4,3]);
  expect((await after.works.getWork(work.id))?.sessionLinks.map(link=>link.sessionId)).toEqual(['fixture-session']);
  const restored=await after.cards.unarchiveCards([card.id]);
  expect(restored.restoredCardIds).toEqual([card.id]);
  expect((await after.cards.getCard(card.id))?.screenshots).toEqual([attachment]);
  for(const file of ['active.json','works.json','archive']) expect(existsSync(join(dir,file))).toBe(false);
}));

test('outer transaction rolls back Card, archive and Work together and other reads see only committed state',()=>withTempDir(async dir=>{
  const s=setup(dir);
  const reader=setup(dir);
  const card=await s.cards.createCard({title:'archive rollback',description:''});
  await s.cards.updateCard(card.id,{status:'done'});
  await expect(s.storage.write(async()=>{
    expect((await s.cards.archiveCards([card.id])).archivedCount).toBe(1);
    await s.works.createWork({title:'rolled back'});
    expect((await reader.cards.getCard(card.id))?.title).toBe('archive rollback');
    expect(await reader.works.getWorks()).toHaveLength(0);
    throw Error('abort transaction');
  })).rejects.toThrow('abort transaction');
  expect((await s.cards.getCard(card.id))?.title).toBe('archive rollback');
  expect(s.cards.listArchiveMonths()).toEqual([]);
  expect(await s.works.getWorks()).toHaveLength(0);
}));

test('concurrent existing store instances preserve writes without touching JSON',()=>withTempDir(async dir=>{
  const a=setup(dir), b=setup(dir);
  await Promise.all(Array.from({length:18},(_,i)=>(i%2 ? a : b).cards.createCard({title:'card-'+i,description:''})));
  expect(await a.cards.getCards()).toHaveLength(18);
  expect(existsSync(join(dir,'active.json'))).toBe(false);
}));

test('normal application bootstrap serves its existing routes over one SQLite-backed process',()=>withTempDir(async fixturePath=>{
  const dir=realpathSync(fixturePath);
  const legacy = new KanbanStore(dir);
  const prior = await legacy.createCard({title:'preexisting JSON fixture',description:''});
  const historyToken='test_history_token_0123456789abcdef';
  await installBoardHistory({dataDir:dir,subscriptionId:'fixture',token:historyToken});
  const history=new BoardHistoryService(dir);
  let pending:ReturnType<BoardHistoryService['page']>;
  try {
    legacy.setChangeObserver(history.observer('card',observeCards));
    await legacy.updateCard(prior.id,{status:'in_progress'});
    pending=history.page(20);
    expect(pending.deliveryId).not.toBeNull();
  } finally {history.close();}
  const old=readFileSync(join(dir,'active.json'));
  const sqlite=join(dir,'board.sqlite');
  expect(importFrozenBoard(dir,sqlite)).toBe(1);
  expect(()=>importFrozenBoard(dir,sqlite)).toThrow('Destination Board already exists');
  expect(()=>new WorkStore(dir)).toThrow('activation marker is missing');
  writeFileSync(join(dir,SQLITE_STORAGE_MARKER),SQLITE_STORAGE_VERSION,{mode:0o600});


  const originProbe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
  const port=originProbe.port;
  originProbe.stop(true);
  const base='http://127.0.0.1:'+port;
  const proc=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/sqlite-board-app.ts')],{
    env:{HOME:dir,PATH:process.env.PATH,KANBAN_PORT:String(port),KANBAN_DATA_DIR:dir},
    stdin:'pipe',stdout:'ignore',stderr:'pipe',
  });
  const errors=new Response(proc.stderr).text();
  try {
    let token:string|undefined;
    for(let i=0;i<80 && proc.exitCode===null;i++){
      try {
        const r=await fetch(base+'/api/auth/token');
        if(r.ok){token=(await r.json() as {token:string}).token;break;}
      } catch { /* waiting for the existing application server */ }
      await Bun.sleep(35);
    }
    if(!token) throw Error(proc.exitCode===null ? 'Normal app did not open port' : await errors);
    async function api(method:string,path:string,body?:unknown){
      return await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body)});
    }
    const historyHeaders={authorization:'Bearer '+historyToken,'content-type':'application/json'};
    const getHistory=async()=>{
      const r=await fetch(base+'/api/board-history/events',{headers:historyHeaders});
      expect(r.status).toBe(200);
      return await r.json() as typeof pending;
    };
    const carried=await getHistory();
    expect(carried.deliveryId).toBe(pending.deliveryId);
    expect(carried.events).toEqual(pending.events);
    expect(carried.coverage.gaps).toEqual(pending.coverage.gaps);
    const ack=await fetch(base+'/api/board-history/ack',{method:'POST',headers:historyHeaders,
      body:JSON.stringify({deliveryId:carried.deliveryId})});
    expect(ack.status).toBe(200);
    const added=await api('POST','/api/cards',{title:'SQLite via canonical API',description:'fixture'});
    expect(added.status).toBe(201);
    const card=await added.json() as {id:string};
    const start=await api('POST','/api/cards/'+card.id+'/dispatch');
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({sessionId:'sqlite-fixture-session'});
    const cardDetail=await api('GET','/api/cards/'+card.id);
    expect(await cardDetail.json()).toMatchObject({status:'in_progress',sessionId:'sqlite-fixture-session'});
    const form=new FormData();
    form.set('file',new File([new Uint8Array([5,3,7])],'a.png',{type:'image/png'}));
    const uploaded=await fetch(base+'/api/cards/'+card.id+'/screenshots',{
      method:'POST',headers:{authorization:'Bearer '+token},body:form,
    });
    expect(uploaded.status).toBe(201);
    const attachment=await uploaded.json() as {filename:string};
    const readback=await api('GET','/api/screenshots/'+attachment.filename);
    expect([...new Uint8Array(await readback.arrayBuffer())]).toEqual([5,3,7]);
    const work=await api('POST','/api/works',{title:'SQLite Work via same API'});
    expect(work.ok).toBe(true);
    expect(existsSync(join(dir,'board.sqlite'))).toBe(true);
    expect(readFileSync(join(dir,'active.json'))).toEqual(old);
    expect(existsSync(join(dir,'works.json'))).toBe(false);
    const next=await getHistory();
    expect(next.deliveryId).not.toBe(carried.deliveryId);
    expect(next.events.some(e=>e.entityId===card.id && e.operation==='create')).toBe(true);
    expect(next.events.every(e=>e.sequence>carried.throughSequence)).toBe(true);
  } finally {
    proc.stdin.end();
    await proc.exited;
  }
}),10_000);

test('normal backend selector refuses incomplete and corrupt activation',()=>withTempDir(async dir=>{
  const sqlite=join(dir,'board.sqlite'), marker=join(dir,SQLITE_STORAGE_MARKER);
  writeFileSync(marker,'unknown format');
  expect(()=>new KanbanStore(dir)).toThrow('Invalid Board backend marker');
  writeFileSync(marker,SQLITE_STORAGE_VERSION);
  expect(()=>new KanbanStore(dir)).toThrow();
  writeFileSync(sqlite,'invalid SQLite body');
  expect(()=>new WorkStore(dir)).toThrow();
  expect(existsSync(join(dir,'active.json'))).toBe(false);
}));

test('a new History installation snapshots the current SQLite store, not leftover JSON',()=>withTempDir(async dir=>{
  const s=setup(dir);
  const card=await s.cards.createCard({title:'on SQLite before History',description:''});
  writeFileSync(join(dir,SQLITE_STORAGE_MARKER),SQLITE_STORAGE_VERSION,{mode:0o600});
  await installBoardHistory({dataDir:dir,subscriptionId:'fixture',token:'fixture_history_token_0123456789abc'});
  const history=new BoardHistoryService(dir);
  try {
    s.cards.setChangeObserver(history.observer('card',observeCards));
    await s.cards.updateCard(card.id,{status:'in_progress'});
    expect(history.page().events).toMatchObject([{entityId:card.id,operation:'update'}]);
    expect(history.status().coverage.gaps).toEqual([]);
  } finally {history.close();}
}));

test('already open legacy stores refuse mutation once backing DB has been staged',()=>withTempDir(async temp=>{
  const dir=realpathSync(temp);
  const oldCards=new KanbanStore(dir),oldWorks=new WorkStore(dir);
  const card=await oldCards.createCard({title:'old card',description:''});
  const work=await oldWorks.createWork({title:'old Work'});
  const active=readFileSync(join(dir,'active.json')),works=readFileSync(join(dir,'works.json'));
  importFrozenBoard(dir,join(dir,'board.sqlite'));
  await expect(oldCards.updateCard(card.id,{title:'must not write'})).rejects.toThrow('sealed');
  await expect(oldWorks.updateWork(work.id,{title:'must not write'})).rejects.toThrow('sealed');
  expect(readFileSync(join(dir,'active.json'))).toEqual(active);
  expect(readFileSync(join(dir,'works.json'))).toEqual(works);
}));

test('archive readers keep a single view across a concurrent transition',()=>withTempDir(async dir=>{
  const src=setup(dir), other=setup(dir);
  const card=await src.cards.createCard({title:'snapshot',description:''});
  await src.cards.updateCard(card.id,{status:'done'});
  await src.storage.readSnapshot(async()=>{
    const before=await src.cards.getCards({includeArchived:true});
    expect(before.map(c=>c.id)).toEqual([card.id]);
    await other.cards.archiveCards([card.id]);
    const after=await src.cards.getCards({includeArchived:true});
    expect(after).toEqual(before);
  });
  expect(await src.cards.getCard(card.id)).toBeNull();
  expect((await src.cards.getCard(card.id,{includeArchived:true}))?.id).toBe(card.id);
}));

test('known rollback leaves existing attachment bytes and does not leave History intent or uploading bytes',()=>withTempDir(async dir=>{
  const s=setup(dir);
  const card=await s.cards.createCard({title:'rollback capture',description:''});
  const file=await s.cards.saveScreenshot(card.id,new Uint8Array([1,2,3]).buffer,'before.png','image/png');
  writeFileSync(join(dir,SQLITE_STORAGE_MARKER),SQLITE_STORAGE_VERSION,{mode:0o600});
  await installBoardHistory({dataDir:dir,subscriptionId:'fixture',token:'fixture_history_token_0123456789abc'});
  const history=new BoardHistoryService(dir);
  s.cards.setChangeObserver(history.observer('card',observeCards));
  let uploaded:string|undefined;
  try {
    await expect(s.storage.write(async()=>{
      await s.cards.deleteScreenshot(card.id,file.id);
      uploaded=(await s.cards.saveScreenshot(card.id,new Uint8Array([4]).buffer,'after.png','image/png')).filename;
      throw Error('known rollback');
    })).rejects.toThrow('known rollback');
    expect(readFileSync(s.cards.getScreenshotPath(file.filename))).toEqual(Buffer.from([1,2,3]));
    expect(existsSync(s.cards.getScreenshotPath(uploaded!))).toBe(false);
    await s.cards.reconcileChangeObserver();
    expect(history.page().events).toEqual([]);
    expect(history.status().coverage.gaps).toEqual([]);
    expect(history.status().coverage.pendingSince).toBeNull();
  } finally {history.close();}
}));
