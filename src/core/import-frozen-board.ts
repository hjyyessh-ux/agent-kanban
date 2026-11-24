import { Database } from 'bun:sqlite';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SQLITE_BOARD_SCHEMA } from './sqlite-board-storage';

const monthPattern=/^\d{4}-(0[1-9]|1[0-2])\.json$/;
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const legacyIdentity=(s:BigIntStats)=>`${s.ino}:${s.size}:${s.mtimeNs / 1_000_000n}`;
const maxDocument=128n*1024n*1024n;

interface Source { path:string; key:string; field:'cards'|'works'; month?:string }
function lstatIfPresent(path:string) {
  try {return lstatSync(path,{bigint:true});}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw error;
  }
}
function inventory(dataDir:string):Source[] {
  const active=join(dataDir,'active.json'), old=join(dataDir,'board.json'), works=join(dataDir,'works.json');
  const activeStat=lstatIfPresent(active), oldStat=lstatIfPresent(old);
  if(activeStat && oldStat) throw Error('Ambiguous active and legacy Board files');
  const entries:Source[]=[];
  if(activeStat||oldStat)entries.push({path:activeStat?active:old,key:'cards',field:'cards'});
  if(lstatIfPresent(works))entries.push({path:works,key:'works',field:'works'});
  const archive=join(dataDir,'archive'), archiveStat=lstatIfPresent(archive);
  if(archiveStat && !archiveStat.isDirectory())throw Error('Invalid Board archive directory');
  if(archiveStat)for(const file of readdirSync(archive).sort()){
    if(!file.endsWith('.json'))continue;
    if(!monthPattern.test(file))throw Error('Unknown Board archive filename');
    const month=file.slice(0,-5);
    entries.push({path:join(archive,file),key:'archive:'+month,field:'cards',month});
  }
  return entries;
}

/** Copies documents from a stopped legacy Board into a new SQLite file.
 * The caller must stop writers first. It never modifies source, assets,
 * History or service registration, and will not replace an existing file. */
export function importFrozenBoard(dataDir:string, outputPath:string):number {
  if (!isAbsolute(dataDir)||resolve(dataDir)!==dataDir||realpathSync(dataDir)!==dataDir ||
      !isAbsolute(outputPath)||resolve(outputPath)!==outputPath||realpathSync(dirname(outputPath))!==dirname(outputPath))
    throw Error('Frozen Board import requires canonical paths');
  if(lstatIfPresent(outputPath))throw Error('Destination Board already exists');
  const out=dirname(outputPath), staging=mkdtempSync(join(out,'.sqlite-board-import-'));
  const tmp=join(staging,'board.sqlite');
  try {
    const seedFd=openSync(tmp,'wx',0o600);closeSync(seedFd);
    const inputs=inventory(dataDir);
    const db=new Database(tmp,{create:false,strict:true});
    const stamps=new Map<string,string>();
    const seenCardIds=new Set<string>(), seenWorkIds=new Set<string>();
    try {
      db.exec(`PRAGMA synchronous=FULL; ${SQLITE_BOARD_SCHEMA}`);
      db.transaction(()=>{
        for(const input of inputs){
          const fd=openSync(input.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          try {
            const before=fstatSync(fd,{bigint:true});
            if(!before.isFile()||before.size<1n||before.size>maxDocument)throw Error('Invalid Board input file');
            const bytes=readFileSync(fd);
            const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
            if(BigInt(bytes.length)!==before.size || stamp(fstatSync(fd,{bigint:true}))!==stamp(before))
              throw Error('Board changed during import');
            const value=JSON.parse(body) as Record<string,unknown> | null;
            const records=value?.[input.field];
            if(!Array.isArray(records)||(input.month && value?.month!==input.month))throw Error('Invalid Board input document');
            const seen=input.field==='cards'?seenCardIds:seenWorkIds;
            for(const row of records){
              if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))throw Error('Invalid or duplicate Board record identity');
              seen.add(row.id);
            }
            stamps.set(input.path,stamp(before));
            // Preserve the old observer fence for the same Board on its first
            // SQLite boot. The first actual SQLite save advances this identity.
            const previous=input.month?null:legacyIdentity(before);
            db.run('INSERT INTO board_documents(key,body,revision,legacy_identity) VALUES (?,?,1,?)',
              [input.key,body,previous]);
          } finally {closeSync(fd);}
        }
      }).immediate();
    } finally {db.close();}
    const fd=openSync(tmp,'r');
    try {fsyncSync(fd);} finally {closeSync(fd);}
    const after=inventory(dataDir);
    if(after.length!==inputs.length||after.some(input=>!stamps.has(input.path)||
        stamp(lstatSync(input.path,{bigint:true}))!==stamps.get(input.path)))throw Error('Board changed during import');
    linkSync(tmp,outputPath);
    const dirfd=openSync(out,constants.O_RDONLY|constants.O_DIRECTORY);
    try {fsyncSync(dirfd);} finally {closeSync(dirfd);}
    return inputs.length;
  } finally {rmSync(staging,{recursive:true,force:true});}
}
