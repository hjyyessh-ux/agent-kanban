import {expect,test} from 'bun:test';
import {existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {KanbanStore} from '../core/store';
import {WorkStore} from '../core/work-store';
import {installBoardHistory,BoardHistoryService,observeCards} from '../core/board-history';
import {importFrozenBoard} from '../core/import-frozen-board';
import {withTempDir} from './setup';

const repo=join(import.meta.dir,'../..');
const command=(dir:string,mode='--activate')=>Bun.spawnSync([process.execPath,
  join(repo,'scripts/sqlite-board-cutover.ts'),mode,'--data-dir',dir,...(mode==='--activate'?['--all-writers-stopped']:[])]);
const state=(p:ReturnType<typeof command>)=>JSON.parse(p.stdout.toString()).state;
const status=(p:ReturnType<typeof command>,code:number)=>expect([p.exitCode,p.stderr.toString()]).toEqual([code,'']);
const historyFile=(dir:string)=>join(dir,'board-history','consumer.json');
const token='synthetic_history_cutover_test_token_123456789';

test('cold CLI validates and resumes a verified unpublished import, refuses stale input and live peers',()=>withTempDir(async temp=>{
  const dir=realpathSync(temp);
  await new KanbanStore(dir).createCard({title:'freeze',description:''});
  const db=join(dir,'board.sqlite'), marker=join(dir,'.board-storage');
  const unconfirmed=Bun.spawnSync([process.execPath,join(repo,'scripts/sqlite-board-cutover.ts'),
    '--activate','--data-dir',dir]);
  expect(unconfirmed.exitCode).toBe(64);
  expect(existsSync(db)).toBe(false);expect(existsSync(marker)).toBe(false);
  const check=command(dir,'--check');status(check,0);expect(state(check)).toBe('validated');
  expect(existsSync(db)).toBe(false);expect(existsSync(marker)).toBe(false);
  const peerDir=join(dir,'peers');
  mkdirSync(peerDir);writeFileSync(join(peerDir,'peer.json'),JSON.stringify({pid:process.pid}));
  expect(command(dir).stderr.toString()).toContain('Live Board peer');
  const dead=Bun.spawnSync(['/usr/bin/true']);
  writeFileSync(join(peerDir,'peer.json'),JSON.stringify({pid:dead.pid}));
  importFrozenBoard(dir,db);
  const source=join(dir,'active.json'), original=readFileSync(source);
  const changed=JSON.parse(original.toString());
  changed.cards[0].title='changed between preparation and activation';
  writeFileSync(source,JSON.stringify(changed));
  expect(command(dir).stderr.toString()).toContain('does not match current frozen source');
  expect(existsSync(marker)).toBe(false);
  // Restore an identical staged state using freshly imported test data for the
  // following recovery case. The rollback itself is never done by the CLI.
  writeFileSync(source,original);
  const imported=new Database(db);
  try {
    const stats=(await import('node:fs')).statSync(source);
    imported.run('UPDATE board_documents SET legacy_identity=? WHERE key=?',
      [`${stats.ino}:${stats.size}:${Math.trunc(stats.mtimeMs)}`,'cards']);
  } finally {imported.close();}
  const sqlite=new Database(db);
  try {sqlite.exec('UPDATE board_documents SET revision=2');} finally {sqlite.close();}
  expect(command(dir).stderr.toString()).toContain('later SQLite changes');
  expect(existsSync(marker)).toBe(false);
  const fresh=new Database(db);
  try {fresh.exec('UPDATE board_documents SET revision=1');} finally {fresh.close();}
  const resume=command(dir);status(resume,0);expect(state(resume)).toBe('activated');
  const repeat=command(dir);status(repeat,0);expect(state(repeat)).toBe('already-active');
}));

test('activation refuses an orphan with broken identity and a marker bound to another DB',()=>withTempDir(async temp=>{
  const dir=realpathSync(temp), sqlite=join(dir,'board.sqlite'), marker=join(dir,'.board-storage');
  await new KanbanStore(dir).createCard({title:'identity test',description:''});
  importFrozenBoard(dir,sqlite);
  const db=new Database(sqlite);
  const identity=db.query<{incarnation:string},[]>('SELECT incarnation FROM board_backend').get()!.incarnation;
  try { db.run('DELETE FROM board_backend'); } finally {db.close();}
  expect(command(dir,'--check').stderr.toString()).toContain('Invalid SQLite Board identity');
  expect(command(dir).stderr.toString()).toContain('Invalid SQLite Board identity');
  expect(existsSync(marker)).toBe(false);
  const restore=new Database(sqlite);
  try {restore.run('INSERT INTO board_backend VALUES (1,?)',[identity]);} finally {restore.close();}
  status(command(dir),0);
  writeFileSync(marker,'sqlite-v1:11111111-1111-1111-1111-111111111111\n',{mode:0o600});
  expect(()=>new KanbanStore(dir)).toThrow('marker does not match database identity');
  expect(command(dir,'--check').stderr.toString()).toContain('Incomplete or invalid Board SQLite activation');
}));

test('ordinary daemon restart replays existing History delivery then persists new SQLite writes',()=>withTempDir(async temp=>{
  const dir=realpathSync(temp);
  const legacy=new KanbanStore(dir);
  const card=await legacy.createCard({title:'legacy test fixture',description:''});
  await new WorkStore(dir).createWork({title:'legacy Work fixture'});
  await installBoardHistory({dataDir:dir,subscriptionId:'fixture',token});
  const history=new BoardHistoryService(dir);
  let delivery:ReturnType<BoardHistoryService['page']>;
  try {
    legacy.setChangeObserver(history.observer('card',observeCards));
    await legacy.updateCard(card.id,{status:'in_progress'});
    delivery=history.page(20);
    expect(delivery.deliveryId).not.toBeNull();
  } finally {history.close();}
  const snapshots=new Map(['active.json','works.json',...readdirSync(join(dir,'board-history')).map(name=>'board-history/'+name)].map(name=>
    [name,readFileSync(join(dir,name))]));
  expect(existsSync(historyFile(dir))).toBe(true);
  const cutover=command(dir);status(cutover,0);expect(state(cutover)).toBe('activated');
  for(const [path,bytes] of snapshots)expect(readFileSync(join(dir,path))).toEqual(bytes);
  const home=join(dir,'isolated-home');mkdirSync(home);
  const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response()});
  const port=probe.port;if(!port || port===24680)throw Error('Unexpected fixture port');
  probe.stop(true);
  const base='http://127.0.0.1:'+port;
  const daemon=Bun.spawn([process.execPath,join(repo,'src/daemon/index.ts')],{
    env:{HOME:home,PATH:process.env.PATH,KANBAN_DATA_DIR:dir,KANBAN_PORT:String(port)},stdout:'ignore',stderr:'pipe',
  });
  const errors=new Response(daemon.stderr).text();
  try {
    let owner:string|undefined;
    for(let i=0;i<80 && daemon.exitCode===null;i++){
      try {const r=await fetch(base+'/api/auth/token');if(r.ok){owner=(await r.json() as {token:string}).token;break;}}
      catch { /* wait for normal daemon */ }
      await Bun.sleep(35);
    }
    if(!owner) throw Error(daemon.exitCode===null?'Fixture daemon failed to bind':await errors);
    const subscriber={authorization:'Bearer '+token,'content-type':'application/json'};
    const first=await fetch(base+'/api/board-history/events',{headers:subscriber});
    expect(first.status).toBe(200);
    const pending=await first.json() as typeof delivery;
    expect(pending.deliveryId).toBe(delivery.deliveryId);
    expect(pending.events).toEqual(delivery.events);
    expect(pending.coverage.gaps).toEqual(delivery.coverage.gaps);
    const ack=await fetch(base+'/api/board-history/ack',{method:'POST',headers:subscriber,
      body:JSON.stringify({deliveryId:pending.deliveryId})});
    expect(ack.status).toBe(200);
    const create=await fetch(base+'/api/cards',{method:'POST',headers:{authorization:'Bearer '+owner,'content-type':'application/json'},
      body:JSON.stringify({title:'after migration',description:'synthetic test'})});
    expect(create.status).toBe(201);
    const newCard=await create.json() as {id:string};
    const second=await fetch(base+'/api/board-history/events',{headers:subscriber});
    const ongoing=await second.json() as typeof delivery;
    expect(ongoing.events.some(event=>event.entityId===newCard.id && event.sequence>pending.throughSequence)).toBe(true);
    expect(readFileSync(join(dir,'active.json'))).toEqual(snapshots.get('active.json')!);
  } finally {daemon.kill('SIGTERM');await daemon.exited;}
}),15_000);
