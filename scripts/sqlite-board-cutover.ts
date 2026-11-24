import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { importFrozenBoard } from '../src/core/import-frozen-board';
import { SQLITE_STORAGE_MARKER, SQLITE_STORAGE_VERSION } from '../src/core/sqlite-board-storage';

function exists(path:string):boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false; throw error; }
}
function requireCold(dir:string) {
  // Conservative even with stale/malformed files: inspect lifecycle out of
  // band. This CLI will neither acquire/reclaim a runtime lock nor kill anything.
  for (const name of ['.singleton-runtime.lock','.board.json.lock','.works.json.lock','board.sqlite.write-lock'])
    if (exists(join(dir,name))) throw new Error('Board writer lock present; verify shutdown first.');
  const peers=join(dir,'peers');
  if (!exists(peers)) return;
  if (!lstatSync(peers).isDirectory()) throw new Error('Cannot verify Board peer shutdown.');
  for (const name of readdirSync(peers)) {
    if (!name.endsWith('.json')) continue;
    const path=join(peers,name), stat=lstatSync(path);
    if (!stat.isFile() || stat.size>64*1024) throw new Error('Cannot verify Board peer shutdown.');
    const record=JSON.parse(readFileSync(path,'utf8')) as {pid?:unknown};
    if (typeof record.pid!=='number' || !Number.isSafeInteger(record.pid) || record.pid<1)
      throw new Error('Cannot verify Board peer shutdown.');
    try { process.kill(record.pid,0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code==='ESRCH') continue;
      throw new Error('Cannot verify Board peer shutdown.');
    }
    throw new Error('Live Board peer present; verify shutdown first.');
  }
}
function syncDirectory(dir:string) {
  const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY);
  try {fsyncSync(fd);} finally {closeSync(fd);}
}
function digestState(path:string, frozen:boolean):string {
  if (!lstatSync(path).isFile() || realpathSync(path)!==path) throw new Error('Board SQLite must be a regular file.');
  if (frozen && ['-wal','-shm','-journal'].some(suffix=>exists(path+suffix)))
    throw new Error('Interrupted import has SQLite sidecars; do not activate it.');
  const db=new Database(path,{readonly:true,strict:true});
  try {
    const checks=db.query<{ quick_check:string },[]>('PRAGMA quick_check').all();
    if (checks.length!==1 || checks[0].quick_check!=='ok') throw new Error('Board SQLite integrity check failed.');
    const digest=createHash('sha256');
    // The orphan comparison includes the actual schema (not just data).
    // An existing file with unrelated DDL must not be treated as this import.
    for (const row of db.query<{type:string; name:string; tbl_name:string; sql:string|null},[]>(
      'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').iterate())
      digest.update(JSON.stringify([row.type,row.name,row.tbl_name,row.sql])+'\n');

    for (const row of db.query<{key:string; body:string; revision:number; legacy_identity:string|null},[]>(
      'SELECT key,body,revision,legacy_identity FROM board_documents ORDER BY key').iterate()) {
      if (frozen && row.revision!==1) throw new Error('Interrupted import has later SQLite changes.');
      digest.update(JSON.stringify([row.key,row.body,row.revision,row.legacy_identity])+'\n');
    }
    return digest.digest('hex');
  } finally {db.close();}
}

export function prepareSqliteCutover(dir:string, activate:boolean) {
  if (!isAbsolute(dir) || resolve(dir)!==dir || realpathSync(dir)!==dir || !lstatSync(dir).isDirectory())
    throw new Error('Use an explicit canonical absolute Board directory.');
  requireCold(dir);
  const sqlite=join(dir,'board.sqlite'), marker=join(dir,SQLITE_STORAGE_MARKER);
  if (exists(marker)) {
    if (!lstatSync(marker).isFile() || readFileSync(marker,'utf8')!==SQLITE_STORAGE_VERSION || !exists(sqlite))
      throw new Error('Incomplete or invalid Board SQLite activation.');
    digestState(sqlite,false);
    return { state:'already-active' as const };
  }
  const stage=mkdtempSync(join(dir,'.board-cutover-'));
  try {
    const candidate=join(stage,'candidate.sqlite');
    const documents=importFrozenBoard(dir,candidate);
    const digest=digestState(candidate,true);
    requireCold(dir);
    if (exists(sqlite) && digestState(sqlite,true)!==digest)
      throw new Error('Interrupted import does not match current frozen source; refusing to activate.');
    if (!activate) return { state:'validated' as const, documents };

    if (!exists(sqlite)) {
      try {linkSync(candidate,sqlite);}
      catch (error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
      if (digestState(sqlite,true)!==digest) throw new Error('SQLite destination changed before activation.');
    }
    syncDirectory(dir); // The DB name is durable before its activation marker.
    requireCold(dir);
    const stagingMarker=join(stage,basename(marker));
    const fd=openSync(stagingMarker,'wx',0o600);
    try {writeFileSync(fd,SQLITE_STORAGE_VERSION);fsyncSync(fd);} finally {closeSync(fd);}
    try {linkSync(stagingMarker,marker);}
    catch (error) {if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
    if (!lstatSync(marker).isFile() || readFileSync(marker,'utf8')!==SQLITE_STORAGE_VERSION)
      throw new Error('Board activation marker changed.');
    syncDirectory(dir);
    return {state:'activated' as const, documents};
  } finally {rmSync(stage,{recursive:true,force:true});}
}

if (import.meta.main) {
  const [mode,flag,dataDir,confirm,...extra]=process.argv.slice(2);
  const valid=flag==='--data-dir' && dataDir && !extra.length &&
    ((mode==='--check' && confirm===undefined)||(mode==='--activate' && confirm==='--all-writers-stopped'));
  if (!valid) {
    console.error('Usage: bun scripts/sqlite-board-cutover.ts --check --data-dir /absolute/board');
    console.error('       bun scripts/sqlite-board-cutover.ts --activate --data-dir /absolute/board --all-writers-stopped');
    process.exitCode=64;
  } else {
    try {console.log(JSON.stringify(prepareSqliteCutover(dataDir,mode==='--activate')));}
    catch (error) {
      // Parser errors can echo the legacy payload; suppress them.
      console.error(error instanceof SyntaxError ? 'Invalid legacy Board JSON.' : error instanceof Error ? error.message : 'Cold cutover failed.');
      process.exitCode=1;
    }
  }
}
