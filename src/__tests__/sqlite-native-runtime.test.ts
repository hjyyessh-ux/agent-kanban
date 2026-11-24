import { expect,test } from 'bun:test';
import { existsSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFrozenBoard } from '../core/import-frozen-board';
import { SQLITE_STORAGE_MARKER,SQLITE_STORAGE_VERSION } from '../core/sqlite-board-storage';
import { KanbanStore } from '../core/store';
import type { KanbanCard } from '../core/types';
import { withTempDir } from './setup';

for(const runtime of ['codex','claude'] as const){
  test(`SQLite normal app dispatches ${runtime} and resumes feedback and queue once`,()=>withTempDir(async path=>{
    const dir=realpathSync(path);
    const legacy=new KanbanStore(dir);
    const fixture=await legacy.createCard({title:'preexisting',description:'migration fixture'});
    const before=readFileSync(join(dir,'active.json'));
    importFrozenBoard(dir,join(dir,'board.sqlite'));
    writeFileSync(join(dir,SQLITE_STORAGE_MARKER),SQLITE_STORAGE_VERSION,{mode:0o600});
    const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
    const base='http://127.0.0.1:'+probe.port;
    const port=String(probe.port);
    probe.stop(true);
    const proc=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/sqlite-native-runtime-app.ts')],{
      env:{HOME:dir,PATH:process.env.PATH,KANBAN_PORT:port,KANBAN_DATA_DIR:dir},
      stdin:'pipe',stdout:'ignore',stderr:'pipe',
    });
    const errors=new Response(proc.stderr).text();
    async function until<T>(fn:()=>Promise<T|undefined>):Promise<T>{
      for(let i=0;i<110;i++){
        const value=await fn();
        if(value!==undefined)return value;
        await Bun.sleep(40);
      }
      throw Error('timed out waiting for native runtime fixture');
    }
    try{
      const token=await until(async()=>{
        try{const r=await fetch(base+'/api/auth/token');return r.ok?(await r.json() as {token:string}).token:undefined;}
        catch{if(proc.exitCode!==null)throw Error(await errors);return undefined;}
      });
      async function api<T>(method:string,url:string,body?:unknown):Promise<T>{
        const r=await fetch(base+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
          body:body===undefined?undefined:JSON.stringify(body)});
        const payload=await r.json();
        if(!r.ok)throw Error(`${method} ${url} => ${r.status}: ${JSON.stringify(payload)}`);
        return payload as T;
      }
      const get=(id:string)=>api<KanbanCard>('GET','/api/cards/'+id);
      const create=(input:Record<string,unknown>)=>api<KanbanCard>('POST','/api/cards',{agentRuntime:runtime,projectDir:dir,...input});
      const dispatch=(id:string)=>api<{sessionId:string;runId:string}>('POST','/api/cards/'+id+'/dispatch');
      const complete=(id:string)=>until(async()=>{ const c=await get(id);if(c.status==='todo'&&c.progressSummary)throw Error(c.progressSummary);return c.status==='complete'?c:undefined; });
      expect((await get(fixture.id)).title).toBe('preexisting');
      const original=await create({title:'original',description:'queue predecessor'});
      const started=await dispatch(original.id);
      const continuation=await create({title:'queued',description:'queued follow-up'});
      await api('PATCH','/api/cards/'+continuation.id,{queuedAfterCardId:original.id,
        queuePosition:1,queueSessionMode:'continue_queued_after_session'});
      expect(await get(continuation.id)).toMatchObject({status:'todo',queuedAfterCardId:original.id});
      writeFileSync(join(dir,'allow-'+runtime),'go');
      expect((await complete(original.id)).sessionId).toBe(started.sessionId);
      const resumed=await complete(continuation.id);
      expect(resumed.sessionId).toBe(started.sessionId);
      expect(resumed.result).toContain('queued follow-up');
      const feedback=await create({title:'feedback',description:'feedback follow-up',feedbackForCardId:original.id});
      expect((await dispatch(feedback.id)).sessionId).toBe(started.sessionId);
      expect((await complete(feedback.id)).result).toContain('feedback follow-up');
      const starts=readFileSync(join(dir,'stub-runs.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
      expect(starts.map(e=>e.resumed)).toEqual([null,started.sessionId,started.sessionId]);
      expect(starts.map(e=>e.runtime)).toEqual([runtime,runtime,runtime]);
      expect(readFileSync(join(dir,'active.json'))).toEqual(before);
      expect(existsSync(join(dir,'board.sqlite'))).toBe(true);
    }finally{
      proc.stdin.end();
      await proc.exited;
    }
  }),15000);
}
