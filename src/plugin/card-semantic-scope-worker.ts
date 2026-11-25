import { Database } from 'bun:sqlite';
import type { CardDocumentKey } from '../core/sqlite-board-storage';
import { boundedSearchProjection, MAX_PROJECTED_BYTES, MAX_PROJECTED_CARDS, type ProjectedSearchCard } from '../core/card-semantic-projection';
import type { IndexPolicy } from '../core/card-semantic-index';
import type { KanbanCard } from '../core/types';

export type ScopeRead = { id: number; path: string; kind: 'board' | 'work' | 'archive'; policy: IndexPolicy };
export type ScopeReply = { id: number; cards: ProjectedSearchCard[] | null };
type CardDocument = { key: CardDocumentKey; revision: number; bytes: number };
type CacheEntry = { revision: number; cards: ProjectedSearchCard[]; bytes: number };
let policyVersion = '';
const cache = new Map<CardDocumentKey, CacheEntry>();

self.onmessage = ({ data }: MessageEvent<ScopeRead>) => {
  const send = (cards: ProjectedSearchCard[] | null) => postMessage({ id: data.id, cards } satisfies ScopeReply);
  const db = new Database(data.path, { readonly: true, strict: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (policyVersion !== data.policy.version) {
      cache.clear();
      policyVersion = data.policy.version;
    }
    const docs = db.query<CardDocument, [string]>(`SELECT key,revision,octet_length(body) AS bytes FROM board_documents
      WHERE (?!='archive' AND key='cards') OR (?1!='board' AND key GLOB 'archive:*') ORDER BY key DESC`).all(data.kind);
    const ids = new Set(docs.map(doc => doc.key));
    for (const key of cache.keys()) {
      // A Board-only read must not evict still-current archive projections.
      if (!ids.has(key) && (data.kind !== 'board' || key === 'cards') && (data.kind !== 'archive' || key !== 'cards')) cache.delete(key);
    }
    const cards: ProjectedSearchCard[] = [];
    let bytes = 0;
    for (const doc of docs) {
      // Never deserialize a single unexpectedly huge record; leave keyword search in place.
      if (doc.bytes > 48 * 1024 * 1024) return send(null);
      let entry = cache.get(doc.key);
      if (entry?.revision !== doc.revision) {
        const source = db.query<{ body: string }, [string]>('SELECT body FROM board_documents WHERE key=?').get(doc.key);
        const original = source ? (JSON.parse(source.body) as {cards: KanbanCard[]}).cards : [];
        const projected = boundedSearchProjection(original, data.policy, MAX_PROJECTED_CARDS - cards.length,
          MAX_PROJECTED_BYTES - bytes);
        if (!projected) return send(null);
        entry = { revision: doc.revision, ...projected };
      }
      if (cards.length + entry.cards.length > MAX_PROJECTED_CARDS || bytes + entry.bytes > MAX_PROJECTED_BYTES)
        return send(null);
      cards.push(...entry.cards);
      bytes += entry.bytes;
      cache.delete(doc.key);
      cache.set(doc.key, entry);
      let cachedBytes = [...cache.values()].reduce((sum, row) => sum + row.bytes, 0);
      for (const [key, row] of cache) {
        if (cachedBytes <= MAX_PROJECTED_BYTES) break;
        cache.delete(key);
        cachedBytes -= row.bytes;
      }
    }
    send(cards);
  } catch {
    send(null);
  } finally { db.close(); }
};
