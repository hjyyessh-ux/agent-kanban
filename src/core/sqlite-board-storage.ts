import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { KanbanCard } from './types';

export type CardDocumentKey = 'cards' | `archive:${string}`;
type DocumentKey = CardDocumentKey | 'works';
type IndexCard = Pick<KanbanCard, 'id' | 'title' | 'description' | 'deletedAt' | 'projectDir'>;
type IndexDocument = { revision: number; cards: IndexCard[] };
type IndexChange = { before: IndexDocument | null; after: IndexCard[] };
function indexCards(value: unknown): IndexCard[] {
  return (value as { cards: IndexCard[] }).cards.map(({ id, title, description, deletedAt, projectDir }) =>
    ({ id, title, description, deletedAt, projectDir }));
}
type IndexObserver = { write(db: Database, changes: ReadonlyMap<CardDocumentKey, IndexChange>): void; failed(): void };
type Transaction = {
  db: Database;
  observers: Map<DocumentKey,{before:string; commit:(before:string)=>void}>;
  mode: 'read'|'write';
  active: boolean;
  afterCommit: (()=>void)[];
  afterRollback: (()=>void)[];
  indexReads?: Map<CardDocumentKey, IndexDocument | null>;
  indexChanges?: Map<CardDocumentKey, IndexChange>;
};
type Document = { body: string; revision: number };
export const SQLITE_BOARD_SCHEMA = `CREATE TABLE IF NOT EXISTS board_documents (
  key TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)),
  revision INTEGER NOT NULL CHECK(revision>0), legacy_identity TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS board_backend (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  incarnation TEXT NOT NULL
) STRICT`;
const archivePrefix = 'archive:';

/**
 * In-process persistence for the existing stores. No server or runtime is
 * started here. JSON payloads preserve the current domain models, but SQLite
 * (not a shadow JSON file) owns every document and archive transaction.
 */
export class SqliteBoardStorage {
  private readonly scope = new AsyncLocalStorage<Transaction>();
  readonly incarnation: string;
  private waiting: Promise<void> = Promise.resolve();
  private indexObserver?: IndexObserver;

  observeCardIndex(observer?: IndexObserver): void { this.indexObserver = observer; }

  readCardIndex<T>(fn: (db: Database) => T): T { return this.read(fn); }

  cardSearchRevision(): string {
    return this.read(db => JSON.stringify(db.query<{key: DocumentKey; revision: number}, []>(
      'SELECT key,revision FROM board_documents ORDER BY key').all()));
  }

  cardSearchWithinBudget(includeArchives: boolean): boolean {
    // SQLite octet_length(column) reads the text size from the record header,
    // not the entire archive payload. Bound both one large month and the
    // combined search scope before materializing any JSON.
    return this.read(db => {
      const size = db.query<{largest: number; total: number}, [number]>(`
        SELECT coalesce(max(bytes),0) AS largest, coalesce(sum(bytes),0) AS total
        FROM (SELECT octet_length(body) AS bytes FROM board_documents WHERE
          key='cards' OR (?=1 AND (key='works' OR key GLOB 'archive:*')))`).get(Number(includeArchives))!;
      return size.largest <= 8 * 1024 * 1024 && size.total <= 32 * 1024 * 1024;
    });
  }

  writeCardIndex<T>(fn: (db: Database) => T): Promise<T> {
    return this.write(async () => fn(this.scope.getStore()!.db));
  }

  constructor(readonly path: string, create = true, expected?:string) {
    const db = new Database(path,{create,strict:true});
    try {
      db.exec('PRAGMA busy_timeout=3000');
      if(!create){
        db.query('SELECT key,body,revision,legacy_identity FROM board_documents LIMIT 0').all();
        if (expected && boardIdentity(db)!==expected) throw Error('SQLite Board marker does not match database identity');
      }
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if(create){
        db.exec(SQLITE_BOARD_SCHEMA);
        db.run('INSERT OR IGNORE INTO board_backend VALUES (1,?)',[randomUUID()]);
      }
      this.incarnation=boardIdentity(db);
    } finally { db.close(); }
  }

  // WAL setup can require writable access to its own shared-memory files
  // on a cold open. SQL stays read-only with query_only; create stays false.
  private openForRead():Database {
    const db=new Database(this.path,{create:false,strict:true});
    try {db.exec('PRAGMA query_only=ON');return db;}
    catch(error){db.close();throw error;}
  }

  private read<T>(fn:(db:Database)=>T):T {
    const tx=this.scope.getStore();
    if(tx?.active) return fn(tx.db);
    const db=this.openForRead();
    try {return fn(db);} finally {db.close();}
  }

  readDocument<T>(key:DocumentKey):T | null {
    const row=this.read(db=>db.query<Document,[string]>(
      'SELECT body,revision FROM board_documents WHERE key=?').get(key));
    const value = row ? JSON.parse(row.body) as T : null;
    const tx = this.scope.getStore();
    if (key !== 'works' && tx?.indexReads && !tx.indexReads.has(key)) {
      tx.indexReads.set(key, row ? { revision: row.revision, cards: indexCards(value) } : null);
    }
    return value;
  }

  identity(key:'cards'|'works'):string {
    const row=this.read(db=>db.query<Pick<Document,'revision'> & { legacy_identity:string|null },[string]>(
      'SELECT revision,legacy_identity FROM board_documents WHERE key=?').get(key));
    return row ? row.legacy_identity ?? `sqlite-board-v1:${this.incarnation}:${key}:${row.revision}` : 'missing';
  }

  archiveMonths():string[] {
    return this.read(db=>db.query<{key:string},[]>(
      "SELECT key FROM board_documents WHERE key GLOB 'archive:*' ORDER BY key DESC").all())
      .map(({key})=>key.slice(archivePrefix.length));
  }

  writeDocument(key:DocumentKey, value:unknown):void {
    const tx=this.scope.getStore();
    if(!tx?.active||tx.mode!=='write') throw new Error('SQLite board write requires a transaction');
    if (key !== 'works' && tx.indexChanges && tx.indexReads) {
      const stored = tx.indexChanges.get(key);
      if (!stored && !tx.indexReads.has(key)) this.readDocument(key);
      const before = stored ? stored.before : tx.indexReads.get(key) ?? null;
      tx.indexChanges.set(key, { before, after: (value as { cards: IndexCard[] }).cards });
    }
    tx.db.run(`INSERT INTO board_documents (key,body,revision) VALUES (?,?,1)
      ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=revision+1,legacy_identity=NULL`,[key,JSON.stringify(value)]);
  }

  inWrite():boolean {
    const active=this.scope.getStore();
    return active?.active===true && active.mode==='write';
  }

  afterDocumentCommit(key:DocumentKey,before:string,commit:(before:string)=>void):void {
    const tx=this.scope.getStore();
    if(!tx?.active||tx.mode!=='write') throw new Error('SQLite board write requires a transaction');
    tx.observers.set(key,{before:tx.observers.get(key)?.before??before,commit});
  }

  afterFinish(commit:(()=>void)|null, rollback:(()=>void)|null):void {
    const tx=this.scope.getStore();
    if(!tx?.active||tx.mode!=='write')throw Error('SQLite Board hook requires a write');
    if(commit)tx.afterCommit.push(commit);
    if(rollback)tx.afterRollback.push(rollback);
  }

  async readSnapshot<T>(fn:()=>Promise<T>):Promise<T> {
    if(this.scope.getStore()?.active)return fn();
    const db=this.openForRead();
    const tx:Transaction={db,observers:new Map(),mode:'read',active:true,afterCommit:[],afterRollback:[]};
    try {
      db.exec('BEGIN');
      return await this.scope.run(tx,fn);
    } finally { tx.active=false; db.close(); }
  }

  // A separate SQLite lock serializes the board commit *and* its History
  // callback across processes. There is no age-based ownership transfer;
  // the OS releases SQLite's lock on process death. Never wait synchronously
  // on another async writer in this process.
  private async observerLease():Promise<Database> {
    const db=new Database(this.path+'.observer-lock',{create:true,strict:true});
    try {
      db.exec('PRAGMA busy_timeout=0');
      const deadline=Date.now()+5_000;
      while(true){
        try { db.exec('BEGIN IMMEDIATE'); return db; }
        catch(error) {
          if((error as {code?:string}).code!=='SQLITE_BUSY'||Date.now()>=deadline)throw error;
          await Bun.sleep(20);
        }
      }
    } catch(error) {db.close();throw error;}
  }

  async write<T>(fn:()=>Promise<T>):Promise<T> {
    const current=this.scope.getStore();
    if(current?.active) {
      if(current.mode!=='write')throw Error('Cannot mutate inside a Board read snapshot');
      return fn();
    }
    const previous=this.waiting;
    let release!:()=>void;
    this.waiting=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try {
      const lock=await this.observerLease();
      try {
        const db=new Database(this.path,{create:false,strict:true});
        const tx:Transaction={db,observers:new Map(),mode:'write',active:true,afterCommit:[],afterRollback:[]};
        const observer = this.indexObserver;
        if (observer) {
          tx.indexReads = new Map();
          tx.indexChanges = new Map();
        }
        let result:T;
        try {
          db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
          try {
            result=await this.scope.run(tx,fn);
            if (observer && tx.indexChanges?.size) {
              db.exec('SAVEPOINT card_index');
              try {
                observer.write(db, tx.indexChanges);
                db.exec('RELEASE card_index');
              } catch {
                db.exec('ROLLBACK TO card_index; RELEASE card_index');
                tx.afterCommit.push(observer.failed);
              }
            }
            db.exec('COMMIT');
          } catch(error) {
            let rolledBack=false;
            try {db.exec('ROLLBACK');rolledBack=true;} catch { /* unknown; do not discard files */ }
            if(rolledBack)for(const effect of tx.afterRollback.reverse())effect();
            throw error;
          }
        } finally {tx.active=false;db.close();}
        for(const effect of tx.observers.values())effect.commit(effect.before);
        for(const effect of tx.afterCommit)effect();
        return result;
      } finally {lock.close();}
    } finally {release();}
  }

}


export const SQLITE_STORAGE_MARKER = '.board-storage';
const boardUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function boardIdentity(db:Database):string {
  const id=db.query<{incarnation:string},[]>('SELECT incarnation FROM board_backend WHERE singleton=1').get()?.incarnation;
  if(!id||!boardUuid.test(id))throw Error('Invalid SQLite Board identity');
  return id;
}
export function sqliteBoardMarkerFor(path:string):string {
  if(!lstatSync(path).isFile())throw Error('Invalid SQLite Board file');
  const db=new Database(path,{create:false,strict:true});
  try {db.exec('PRAGMA query_only=ON');return 'sqlite-v1:'+boardIdentity(db)+'\n';}
  finally {db.close();}
}
function parseBoardMarker(marker:string):string|undefined {
  const match=/^sqlite-v1:([0-9a-f-]{36})\n$/.exec(marker);
  return match&&boardUuid.test(match[1]) ? match[1] : undefined;
}
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
  const identity=stat.isFile() && stat.size===47 ? parseBoardMarker(readFileSync(marker,'utf8')) : undefined;
  if(!identity)throw Error('Invalid Board backend marker');
  if(!lstatSync(path).isFile())throw Error('Invalid SQLite Board file');
  const existing=openStores.get(path);
  if(existing?.incarnation===identity){
    if(sqliteBoardMarkerFor(path)!=='sqlite-v1:'+identity+'\n')
      throw Error('SQLite Board marker does not match database identity');
    return existing;
  }
  const opened=new SqliteBoardStorage(path,false,identity);
  openStores.set(path,opened);
  return opened;
}


// Rechecked at a mutation boundary as well as construction: a cooperating
// JSON instance cannot keep updating files after a cold activation was staged.
export function assertLegacyBoardStorageWritable(dir:string):void {
  if(storeArtifactPresent(join(dir, SQLITE_STORAGE_MARKER))||storeArtifactPresent(join(dir,'board.sqlite')))
    throw Error('Legacy JSON Board is sealed for SQLite');
}
function storeArtifactPresent(path:string):boolean {
  try {lstatSync(path);return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
