import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { FileLock } from './filelock';

type DocumentKey = 'cards' | 'works' | `archive:${string}`;
type WriteContext = { db: Database; afterCommit: (() => void)[]; active: boolean };
type Document = { body: string; revision: number };
export const SQLITE_BOARD_SCHEMA = `CREATE TABLE IF NOT EXISTS board_documents (
  key TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)),
  revision INTEGER NOT NULL CHECK(revision>0), legacy_identity TEXT
) STRICT`;
const archivePrefix = 'archive:';

/**
 * In-process persistence for the existing stores. No server or runtime is
 * started here. JSON payloads preserve the current domain models, but SQLite
 * (not a shadow JSON file) owns every document and archive transaction.
 */
export class SqliteBoardStorage {
  private readonly scope = new AsyncLocalStorage<WriteContext>();
  private readonly lock: FileLock;
  private waiting: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, create = true) {
    this.lock = new FileLock(path + '.write-lock');
    const db = new Database(path,{create,strict:true});
    try {
      db.exec('PRAGMA busy_timeout=3000');
      if(!create)db.query('SELECT key,body,revision,legacy_identity FROM board_documents LIMIT 0').all();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if(create)db.exec(SQLITE_BOARD_SCHEMA);
    } finally { db.close(); }
  }

  private read<T>(fn:(db:Database)=>T):T {
    const tx=this.scope.getStore();
    if(tx?.active) return fn(tx.db);
    const db=new Database(this.path,{readonly:true,strict:true});
    try {return fn(db);} finally {db.close();}
  }

  readDocument<T>(key:DocumentKey):T | null {
    const row=this.read(db=>db.query<Pick<Document,'body'>,[string]>(
      'SELECT body FROM board_documents WHERE key=?').get(key));
    return row ? JSON.parse(row.body) as T : null;
  }

  identity(key:'cards'|'works'):string {
    const row=this.read(db=>db.query<Pick<Document,'revision'> & { legacy_identity:string|null },[string]>(
      'SELECT revision,legacy_identity FROM board_documents WHERE key=?').get(key));
    return row ? row.legacy_identity ?? `sqlite-board-v1:${key}:${row.revision}` : 'missing';
  }

  archiveMonths():string[] {
    return this.read(db=>db.query<{key:string},[]>(
      "SELECT key FROM board_documents WHERE key GLOB 'archive:*' ORDER BY key DESC").all())
      .map(({key})=>key.slice(archivePrefix.length));
  }

  writeDocument(key:DocumentKey, value:unknown):void {
    const tx=this.scope.getStore();
    if(!tx?.active) throw new Error('SQLite board write requires a transaction');
    tx.db.run(`INSERT INTO board_documents (key,body,revision) VALUES (?,?,1)
      ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=revision+1,legacy_identity=NULL`,[key,JSON.stringify(value)]);
  }

  inWrite():boolean {return this.scope.getStore()?.active===true;}

  afterCommit(fn:()=>void):void {
    const tx=this.scope.getStore();
    if(!tx?.active) throw new Error('SQLite board write requires a transaction');
    tx.afterCommit.push(fn);
  }

  async write<T>(fn:()=>Promise<T>):Promise<T> {
    if(this.inWrite()) return fn();
    const previous=this.waiting;
    let release!:()=>void;
    this.waiting=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try {
      return await this.lock.withLock(async()=>{
        const db=new Database(this.path,{create:false,strict:true});
        const tx:WriteContext={db,afterCommit:[],active:true};
        let result:T;
        try {
          db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
          try {
            result=await this.scope.run(tx,fn);
            db.exec('COMMIT');
          } catch(error) {
            try {db.exec('ROLLBACK');} catch { /* preserve original failure */ }
            throw error;
          }
        } finally {tx.active=false;db.close();}
        // Keep the legacy capture callback ordered while the shared writer
        // lock is held. It is best-effort and never changes the commit result.
        for(const effect of tx.afterCommit) effect();
        return result;
      });
    } finally {release();}
  }
}


export const SQLITE_STORAGE_MARKER = '.board-storage';
export const SQLITE_STORAGE_VERSION = 'sqlite-v1\n';
const openStores = new Map<string,SqliteBoardStorage>();

/** Existing app and maintenance stores use one backend selector. Selecting
 * SQLite requires an already provisioned DB; an invalid marker or absent
 * DB fails closed rather than opening the old JSON. */
export function selectSqliteBoardStorage(dataDir:string):SqliteBoardStorage|undefined {
  const marker=join(dataDir,SQLITE_STORAGE_MARKER);
  const path=join(dataDir,'board.sqlite');
  let stat;
  try {stat=lstatSync(marker);}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    try {lstatSync(path);}
    catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw err;}
    throw Error('SQLite Board exists but its activation marker is missing');
  }
  if(!stat.isFile()||stat.size!==SQLITE_STORAGE_VERSION.length||readFileSync(marker,'utf8')!==SQLITE_STORAGE_VERSION)
    throw Error('Invalid Board backend marker');
  if(!lstatSync(path).isFile())throw Error('Invalid SQLite Board file');
  const existing=openStores.get(path);
  if(existing)return existing;
  const opened=new SqliteBoardStorage(path,false);
  openStores.set(path,opened);
  return opened;
}
