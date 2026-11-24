import {expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SqliteBoardStorage} from '../core/sqlite-board-storage';
import {KanbanStore} from '../core/store';
import {WorkStore} from '../core/work-store';
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

test('normal application bootstrap serves its existing routes over one SQLite-backed process',()=>withTempDir(async dir=>{
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
    expect(existsSync(join(dir,'active.json'))).toBe(false);
    expect(existsSync(join(dir,'works.json'))).toBe(false);
  } finally {
    proc.stdin.end();
    await proc.exited;
  }
}),10_000);
