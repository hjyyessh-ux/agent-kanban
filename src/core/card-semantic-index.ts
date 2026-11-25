import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ProjectedSearchCard } from './card-semantic-projection';
import type { KanbanCard } from './types';
import type { CardDocumentKey, SqliteBoardStorage } from './sqlite-board-storage';
import { CARD_EMBEDDING_DIMENSIONS as dimensions, CARD_EMBEDDING_VERSION } from './card-semantic-model';
import { splitFeedbackHeader } from './mention-search';
import { stripReferenceBlock } from './mention-reference';

const schema = `
CREATE TABLE IF NOT EXISTS card_embeddings (
  card_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, model_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL, input_hash TEXT NOT NULL, token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','error')), vector BLOB,
  priority INTEGER NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL,
  CHECK((state='ready' AND vector IS NOT NULL AND length(vector)=dimensions*4)
      OR (state!='ready' AND vector IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS card_embedding_progress (
  source_key TEXT PRIMARY KEY, version TEXT NOT NULL, revision INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('scan','prune','complete')), cursor TEXT NOT NULL
) STRICT;`;
const sensitive = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:token|secret|password|api[ _-]?key|authorization)\s*[:=]\s*\S+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16})\b|\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/i;

export const containsSensitiveSearchText = (text: string) => sensitive.test(text);

export interface IndexPolicy {
  directories: ReadonlySet<string>;
  secrets: readonly string[];
  version: string;
}

type SourceCard = Pick<KanbanCard, 'id' | 'title' | 'description' | 'deletedAt' | 'projectDir'>;
type Progress = { revision: number; phase: 'scan' | 'prune' | 'complete'; cursor: string };
type EmbeddingRow = { card_id: string; source_key: CardDocumentKey; input_hash: string; token: string;
  attempts: number; priority: number; vector: Uint8Array };
export type IndexJob = EmbeddingRow & { text: string; sourceRevision: number };

const fingerprint = (input: string) => Bun.CryptoHasher.hash('sha256', input, 'hex');
const versioned = (policy: IndexPolicy) => CARD_EMBEDDING_VERSION + ':' + policy.version;

export function cardEmbeddingInput(card: SourceCard, policy: IndexPolicy): string | null {
  const project = card.projectDir?.replace(/\/+$/, '');
  if (!project || card.deletedAt || !policy.directories.has(project)) return null;
  const description = splitFeedbackHeader(stripReferenceBlock(card.description ?? '')).body;
  const text = `${card.title}\n${description}`.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  if (!text || sensitive.test(text) || policy.secrets.some(secret => text.includes(secret))) return null;
  return text.slice(0, 8_192);
}

const progress = (db: Database, key: CardDocumentKey, version: string, revision: number): Progress =>
  db.query<Progress,[string,string,number]>(
    'SELECT revision,phase,cursor FROM card_embedding_progress WHERE source_key=? AND version=? AND revision=?')
    .get(key, version, revision) ?? { revision, phase: 'scan', cursor: '' };

function saveProgress(db: Database, key: CardDocumentKey, version: string, next: Progress) {
  db.run(`INSERT INTO card_embedding_progress VALUES (?,?,?,?,?) ON CONFLICT(source_key)
    DO UPDATE SET version=excluded.version,revision=excluded.revision,phase=excluded.phase,cursor=excluded.cursor`,
  [key, version, next.revision, next.phase, next.cursor]);
}

function enqueue(db: Database, key: CardDocumentKey, card: Pick<SourceCard, 'id'>, input: string, version: string, priority: number) {
  const upsert = db.run(`INSERT INTO card_embeddings VALUES (?,?,?,?,?,?,'pending',NULL,?,0,?)
    ON CONFLICT(card_id) DO UPDATE SET source_key=excluded.source_key,model_version=excluded.model_version,
      dimensions=excluded.dimensions,input_hash=excluded.input_hash,token=excluded.token,state='pending',
      vector=NULL,priority=excluded.priority,attempts=0,retry_at=excluded.retry_at
    WHERE (model_version,dimensions,input_hash) != (excluded.model_version,excluded.dimensions,excluded.input_hash)`,
  [card.id, key, version, dimensions, fingerprint(input), randomUUID(), priority, Date.now()]);
  if (!upsert.changes) db.run('UPDATE card_embeddings SET source_key=? WHERE card_id=? AND source_key!=?', [key, card.id, key]);
}

function fieldsChanged(before: SourceCard, after: SourceCard): boolean {
  return before.title !== after.title || before.description !== after.description ||
    before.deletedAt !== after.deletedAt || before.projectDir !== after.projectDir;
}

export class CardSemanticIndex {
  // Two source-document projections avoid repeatedly decoding large JSON when
  // a scan page and a small embedding job alternate. No raw results are cached.
  private readonly sourceCache = new Map<CardDocumentKey, {
    revision: number; version: string; ids: string[]; input: Map<string, string | null>;
  }>();

  private source(db: Database, key: CardDocumentKey, revision: number, policy: IndexPolicy) {
    let snapshot = this.sourceCache.get(key);
    if (!snapshot || snapshot.revision !== revision || snapshot.version !== policy.version) {
      const data = db.query<{body: string}, [string]>('SELECT body FROM board_documents WHERE key=?').get(key);
      const cards = data ? (JSON.parse(data.body) as { cards: SourceCard[] }).cards : [];
      snapshot = { revision, version: policy.version, ids: cards.map(card => card.id).sort(),
        input: new Map(cards.map(card => [card.id, cardEmbeddingInput(card, policy)])) };
    }
    this.sourceCache.delete(key);
    this.sourceCache.set(key, snapshot);
    if (this.sourceCache.size > 2) this.sourceCache.delete(this.sourceCache.keys().next().value!);
    return snapshot;
  }

  constructor(readonly storage: SqliteBoardStorage) {}

  init() { return this.storage.writeCardIndex(db => db.exec(schema)); }

  observe(policy: IndexPolicy, failed: () => void) {
    this.storage.observeCardIndex({
      failed,
      write: (db, changes) => {
        const version = versioned(policy);
        const mark = (source: CardDocumentKey, card: SourceCard) => {
          const input = cardEmbeddingInput(card, policy);
          if (input) enqueue(db, source, card, input, version, 1);
          else db.run('DELETE FROM card_embeddings WHERE card_id=?', [card.id]);
        };
        for (const [source, { before }] of changes) {
          db.run(`UPDATE card_embedding_progress SET revision=(SELECT revision FROM board_documents WHERE key=?)
            WHERE source_key=? AND version=? AND revision=?`, [source, source, version, before?.revision ?? 0]);
        }
        if (changes.size === 1) {
          const [source, { before, after }] = changes.entries().next().value!;
          if (before && before.cards.length === after.length && after.every((card, i) => card.id === before.cards[i].id)) {
            after.forEach((card, i) => { if (fieldsChanged(before.cards[i], card)) mark(source, card); });
            return;
          }
        }
        const previous = new Map<string, { source: CardDocumentKey; card: SourceCard }>();
        const current = new Map<string, { source: CardDocumentKey; card: SourceCard }>();
        for (const [source, { before, after }] of changes) {
          before?.cards.forEach(card => previous.set(card.id, { source, card }));
          after.forEach(card => current.set(card.id, { source, card }));
        }
        for (const { source, card } of current.values()) {
          const old = previous.get(card.id);
          previous.delete(card.id);
          if (!old || old.source !== source || fieldsChanged(old.card, card)) mark(source, card);
        }
        for (const id of previous.keys()) db.run('DELETE FROM card_embeddings WHERE card_id=?', [id]);
      },
    });
  }

  stop() { this.sourceCache.clear(); this.storage.observeCardIndex(); }

  hasSchema() {
    return this.storage.readCardIndex(db => !!db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_embeddings'").get());
  }

  pruneVersion(policy: IndexPolicy) {
    return this.storage.writeCardIndex(db => {
      db.run('DELETE FROM card_embeddings WHERE model_version!=?', [versioned(policy)]);
      db.run('DELETE FROM card_embedding_progress WHERE version!=?', [versioned(policy)]);
    });
  }

  clear() {
    return this.storage.writeCardIndex(db => {
      db.exec('DELETE FROM card_embeddings; DELETE FROM card_embedding_progress');
    });
  }

  counts(policy: IndexPolicy) {
    return this.storage.readCardIndex(db => db.query<{pending: number; initial: number; failed: number; ready: number}, [string]>(`
      SELECT count(*) FILTER(WHERE state='pending') AS pending,
        count(*) FILTER(WHERE state='pending' AND priority=0) AS initial,
        count(*) FILTER(WHERE state='ready') AS ready,
        count(*) FILTER(WHERE state='error') AS failed FROM card_embeddings WHERE model_version=?`).get(versioned(policy))!);
  }

  async scan(policy: IndexPolicy): Promise<boolean> {
    const version = versioned(policy);
    const page = this.storage.readCardIndex(db => {
      const document = db.query<{key: CardDocumentKey; revision: number}, [string]>(`
        SELECT d.key,d.revision FROM board_documents d
        LEFT JOIN card_embedding_progress p ON p.source_key=d.key AND p.version=? AND p.revision=d.revision
        WHERE (d.key='cards' OR d.key GLOB 'archive:*') AND (p.phase IS NULL OR p.phase!='complete')
        ORDER BY d.key='cards' DESC,d.key DESC LIMIT 1`).get(version);
      if (!document) return null;
      const { key, revision } = document;
      const state = progress(db, key, version, revision);
      const cards = this.source(db, key, revision, policy);
      if (state.phase === 'scan') {
        const ids = cards.ids.filter(id => id > state.cursor).slice(0, 33);
        return { key, revision, state, rows: ids.map(id => ({ id, card: { id }, input: cards.input.get(id) ?? null })) };
      }
      const rows = db.query<{ id: string }, [string,string]>(`
        SELECT card_id AS id FROM card_embeddings WHERE source_key=? AND card_id>? ORDER BY card_id LIMIT 33`)
        .all(key, state.cursor);
      return { key, revision, state, rows: rows.map(({ id }) => ({ id, card: null, input: cards.input.get(id) ? '' : null })) };
    });
    if (!page) return true;
    await this.storage.writeCardIndex(db => {
      const { key, revision, state, rows } = page;
      const current = db.query<{revision: number}, [string]>('SELECT revision FROM board_documents WHERE key=?').get(key);
      const cursor = progress(db, key, version, revision);
      if (current?.revision !== revision || cursor.phase !== state.phase || cursor.cursor !== state.cursor) return;
      for (const row of rows.slice(0, 32)) {
        if (row.card && row.input) enqueue(db, key, row.card, row.input, version, 0);
        else if (row.input === null) db.run('DELETE FROM card_embeddings WHERE source_key=? AND card_id=?', [key, row.id]);
      }
      const next: Progress = rows.length > 32
        ? { ...state, cursor: rows[31].id }
        : { revision, cursor: '', phase: state.phase === 'scan' ? 'prune' : 'complete' };
      saveProgress(db, key, version, next);
    });
    return false;
  }

  jobs(policy: IndexPolicy, preferInitial: boolean): IndexJob[] {
    return this.storage.readCardIndex(db => {
      const rows = db.query<EmbeddingRow,[string,number,number]>(`SELECT * FROM card_embeddings
        WHERE model_version=? AND state='pending' AND retry_at<=? ORDER BY priority!=?,retry_at,card_id LIMIT 4`)
        .all(versioned(policy), Date.now(), preferInitial ? 0 : 1);
      return rows.map(row => {
        const revision = db.query<{revision: number}, [string]>('SELECT revision FROM board_documents WHERE key=?')
          .get(row.source_key)?.revision ?? 0;
        const source = this.source(db, row.source_key, revision, policy);
        return { ...row, sourceRevision: revision, text: source.input.get(row.card_id) ?? '' };
      });
    });
  }

  async finish(policy: IndexPolicy, jobs: IndexJob[], vectors?: Float32Array[]) {
    await this.storage.writeCardIndex(db => {
      jobs.forEach((job, i) => {
        const current = db.query<EmbeddingRow,[string,string,string]>(`SELECT * FROM card_embeddings
          WHERE card_id=? AND token=? AND model_version=? AND state='pending'`)
          .get(job.card_id, job.token, versioned(policy));
        if (!current || job.attempts !== current.attempts) return;
        const revision = db.query<{ revision: number }, [string]>('SELECT revision FROM board_documents WHERE key=?')
          .get(current.source_key)?.revision ?? 0;
        if (current.source_key !== job.source_key || revision !== job.sourceRevision) return;
        if (!job.text || fingerprint(job.text) !== current.input_hash) {
          if (job.text) enqueue(db, current.source_key, { id: job.card_id }, job.text, versioned(policy), 1);
          else db.run('DELETE FROM card_embeddings WHERE card_id=? AND token=?', [job.card_id, job.token]);
          return;
        }
        const vector = vectors?.[i];
        const norm = vector?.reduce((sum, item) => sum + item * item, 0);
        if (vector?.length === dimensions && norm !== undefined && Math.abs(norm - 1) < 0.001) {
          db.run("UPDATE card_embeddings SET state='ready',vector=?,attempts=0 WHERE card_id=?", [vector, job.card_id]);
        } else {
          const delay = [1_000, 5_000, 30_000][job.attempts];
          db.run('UPDATE card_embeddings SET state=?,attempts=attempts+1,retry_at=? WHERE card_id=?',
            [delay ? 'pending' : 'error', delay ? Date.now() + delay : 0, job.card_id]);
        }
      });
    });
  }

  retry(policy: IndexPolicy) {
    return this.storage.writeCardIndex(db => db.run(`UPDATE card_embeddings SET state='pending',attempts=0,retry_at=?,token=lower(hex(randomblob(16)))
      WHERE model_version=? AND state='error'`, [Date.now(), versioned(policy)]));
  }

  candidates(policy: IndexPolicy, cards: ReadonlyMap<string, KanbanCard>) {
    return this.storage.readCardIndex(db => db.query<EmbeddingRow,[string,number,string]>(`
      SELECT card_id,source_key,input_hash,token,vector FROM card_embeddings
      WHERE model_version=? AND dimensions=? AND state='ready'
      AND card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id`)
      .all(versioned(policy), dimensions, JSON.stringify([...cards.keys()])));
  }

  validate(policy: IndexPolicy, tokens: ReadonlyMap<string, string>, cards: ReadonlyMap<string, KanbanCard>) {
    return this.storage.readCardIndex(db => {
      const rows = db.query<Pick<EmbeddingRow,'card_id'|'token'|'input_hash'>,[string,number,string]>(`
        SELECT card_id,token,input_hash FROM card_embeddings WHERE model_version=? AND dimensions=? AND state='ready'
        AND card_id IN (SELECT value FROM json_each(?))`).all(versioned(policy), dimensions, JSON.stringify([...tokens.keys()]));
      return new Set(rows.filter(row => {
        const card = cards.get(row.card_id);
        if (!card || row.token !== tokens.get(row.card_id)) return false;
        if ('searchProjection' in card) return row.input_hash === (card as ProjectedSearchCard).searchProjection.inputHash;
        const input = cardEmbeddingInput(card, policy);
        return input && row.input_hash === fingerprint(input);
      }).map(row => row.card_id));
    });
  }
}
