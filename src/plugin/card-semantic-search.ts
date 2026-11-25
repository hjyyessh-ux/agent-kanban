import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { KanbanCard } from '../core/types';
import type { SettingsStore } from '../core/settings-store';
import type { SqliteBoardStorage } from '../core/sqlite-board-storage';
import { CardSemanticIndex, containsSensitiveSearchText, type IndexPolicy } from '../core/card-semantic-index';
import { CARD_EMBEDDING_DIMENSIONS as dimensions } from '../core/card-semantic-model';
import { CARD_SEMANTIC_SETTINGS_KEY as settingKey, exactCardSearchMatch, splitCardSearch, type CardSemanticConfig, type CardSemanticResult, type CardSemanticStatus } from '../core/card-semantic';
import type { ProjectedSearchCard } from '../core/card-semantic-projection';
import type { ScopeRead, ScopeReply } from './card-semantic-scope-worker';
import type { CardEmbeddingRequest } from './card-semantic-worker';

export const CARD_SEMANTIC_SCOPE_LIMIT = 4_096;
const defaultConfig: CardSemanticConfig = { enabled: false, directories: [] };
const hit = ({ id, title, sessionId }: KanbanCard) => ({ id, title, sessionId });

type RequestWithoutId<T = CardEmbeddingRequest> = T extends CardEmbeddingRequest ? Omit<T, 'id'> : never;
type Reply = { id: number; ok: boolean; ranked?: number[]; vectors?: Float32Array[] };

export function parseSemanticConfig(value: unknown): CardSemanticConfig | null {
  if (!value || typeof value !== 'object' || !('enabled' in value) || typeof value.enabled !== 'boolean' ||
    !('directories' in value) || !Array.isArray(value.directories) || value.directories.length > 50) return null;
  const directories = new Set<string>();
  for (const entry of value.directories) {
    if (typeof entry !== 'string' || entry.length > 1024 || entry.includes('\0')) return null;
    const path = entry.replace(/\/+$/, '');
    if (!path.startsWith('/')) return null;
    directories.add(path);
  }
  if (value.enabled && !directories.size) return null;
  return { enabled: value.enabled, directories: [...directories].sort() };
}

export class CardSemanticSearch {
  private readonly index?: CardSemanticIndex;
  private worker?: Worker;
  private scopeWorker?: Worker;
  private scopeJob?: { finish(cards: ProjectedSearchCard[] | null): void };
  private timer?: ReturnType<typeof setInterval>;
  private job?: { id: number; cancel: () => void };
  private nextId = 0;
  private ticking = false;
  private updating = false;
  private querying = false;
  private waitingForQuery = false;
  private generation = 0;
  private iteration = 0;
  private config = defaultConfig;
  private policy?: IndexPolicy;
  private state: CardSemanticStatus['state'] = 'off';
  private initialized = false;

  constructor(
    storage: SqliteBoardStorage | undefined,
    private readonly settings: SettingsStore,
    private readonly dataDir: string,
    private readonly workerFactory: () => Worker = () => new Worker(new URL(
      import.meta.url.endsWith('.ts') ? './card-semantic-worker.ts' : './card-semantic-worker.js', import.meta.url)),
  ) {
    if (storage) this.index = new CardSemanticIndex(storage);
  }

  start() {
    if (!this.index || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 250);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reset();
  }

  private reset() {
    this.generation++;
    this.index?.stop();
    this.job?.cancel();
    this.worker?.terminate();
    this.worker = undefined;
    this.scopeJob?.finish(null);
    this.scopeWorker?.terminate();
    this.scopeWorker = undefined;
    this.policy = undefined;
    this.config = defaultConfig;
    this.state = 'off';
  }

  private async readSettings() {
    const entries = await this.settings.getEntries();
    const entry = entries.find(setting => setting.key === settingKey);
    const stored: unknown = entry ? JSON.parse(entry.value) : null;
    const config = parseSemanticConfig(stored) ?? defaultConfig;
    const epoch = stored && typeof stored === 'object' && 'epoch' in stored && typeof stored.epoch === 'string'
      ? stored.epoch : '';

    const secrets = entries.filter(item => item.masked !== false && item.key !== settingKey && typeof item.value === 'string' && item.value.length >= 4)
      .map(item => item.value).sort();
    const version = Bun.CryptoHasher.hash('sha256', JSON.stringify([epoch, config.directories, secrets]), 'hex');
    return { config, epoch, policy: { version, directories: new Set(config.directories), secrets } };
  }

  async status(): Promise<CardSemanticStatus> {
    const config = (await this.readSettings()).config;
    const counts = this.initialized && this.policy ? this.index?.counts(this.policy) : undefined;
    const state = this.state === 'off' && config.enabled ? 'preparing' : this.state;
    const revision = config.enabled && this.index ? this.index.storage.readCardIndex(db =>
      db.query<{revision: number}, []>('SELECT coalesce(sum(revision),0) AS revision FROM board_documents').get()!.revision) : 0;
    return { ...config, state: !this.index || !this.timer ? 'unavailable' : config.enabled || this.state === 'failed' ? state : 'off',
      pending: counts?.pending ?? 0, failed: counts?.failed ?? 0,
      revision: [this.generation, revision, counts?.ready, counts?.pending, counts?.failed].join(':') };
  }

  async configure(config: CardSemanticConfig) {
    if (!this.timer || !this.index) throw Error('SQLite runtime owner required');
    if (this.updating) throw Error('Semantic search settings are being saved');
    this.updating = true;
    try {
      const previous = await this.readSettings();
      this.reset();
      // A new activation invalidates old rows even if the previous OFF cleanup
      // failed. Persist before allowing the worker to see the new policy.
      const epoch = config.enabled && previous.config.enabled ? previous.epoch : randomUUID();
      await this.settings.upsertByKey(settingKey, JSON.stringify({ ...config, epoch }), { masked: true });
      if (this.index.hasSchema() &&
        (!config.enabled || previous.policy.version !== (await this.readSettings()).policy.version)) {
        await this.index.clear();
      }
    } catch (error) {
      this.state = 'failed';
      throw error;
    } finally {
      this.updating = false;
      void this.tick();
    }
  }

  async retry() {
    if (!this.index || !this.timer) return;
    if (this.initialized && this.policy) await this.index.retry(this.policy);
    if (this.state === 'failed') this.reset();
    void this.tick();
  }

  private request(message: RequestWithoutId, limit = 30_000): Promise<Reply> {
    const worker = this.worker;
    if (!worker || this.job) return Promise.reject(Error('Worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (reply?: Reply) => {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        this.job = undefined;
        if (reply?.ok) resolve(reply);
        else reject(Error('Semantic worker failed'));
      };
      const timer = setTimeout(() => {
        finish();
        if (this.worker === worker) {
          worker.terminate();
          this.worker = undefined;
          this.state = message.type === 'search' ? 'preparing' : 'failed';
        }
      }, limit);
      this.job = { id, cancel: () => finish() };
      worker.onmessage = ({ data }: MessageEvent<Reply>) => { if (data.id === id) finish(data); };
      worker.onerror = event => { event.preventDefault(); finish(); };
      try { worker.postMessage({ ...message, id }); }
      catch { finish(); }
    });
  }

  private async tick() {
    const index = this.index;
    if (!index || this.ticking || this.updating || this.querying || !this.timer || this.state === 'failed') return;
    this.ticking = true;
    let generation = this.generation;
    try {
      const { config, policy } = await this.readSettings();
      if (!this.timer || this.updating || generation !== this.generation) return;
      if (this.config.enabled !== config.enabled || this.policy?.version !== policy.version) {
        this.reset();
        generation = this.generation;
        if (index.hasSchema()) {
          if (config.enabled) await index.pruneVersion(policy);
          else await index.clear();
          if (generation !== this.generation) return;
          this.initialized = true;
        }
        this.config = config;
        this.policy = policy;
      }
      if (!config.enabled) return;
      if (!this.worker) {
        this.state = 'preparing';
        this.worker = this.workerFactory();
        const modelDir = process.env.KANBAN_SEARCH_MODEL_DIR ?? join(this.dataDir, 'semantic-search-model');
        const wasmDir = import.meta.url.endsWith('.ts')
          ? join(import.meta.dir, '../../node_modules/onnxruntime-web/dist')
          : import.meta.dir;
        await this.request({ type: 'init', modelDir, wasmDir });
        if (generation !== this.generation) return;
        await index.init();
        if (generation !== this.generation) return;
        this.initialized = true;
        index.observe(policy, () => {
          this.reset();
          this.state = 'failed';
        });
      }
      const counts = index.counts(policy);
      const complete = counts.initial < 128 && await index.scan(policy);
      if (generation !== this.generation) return;
      if (complete && !counts.initial && this.state !== 'ready') {
        this.state = counts.failed && !counts.ready ? 'failed' : 'ready';
      }
      if (this.querying || this.job || this.state === 'failed') return;
      const jobs = index.jobs(policy, ++this.iteration % 4 === 0);
      if (!jobs.length) return;
      let vectors: Float32Array[] | undefined;
      try {
        const reply = await this.request({ type: 'index', texts: jobs.map(job => job.text) });
        vectors = reply.vectors;
      } catch {
        // The current tickets record retries. Stop/reconfigure invalidates this whole batch.
      }
      if (generation === this.generation) await index.finish(policy, jobs, vectors);
    } catch {
      if (generation === this.generation) {
        this.reset();
        this.state = 'failed';
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Read only bounded, projected card fields on a worker thread. */
  async projectedCards(kind: ScopeRead['kind'], signal: AbortSignal): Promise<ProjectedSearchCard[] | null> {
    if (signal.aborted || !this.index || !this.policy || !this.config.enabled || this.scopeJob) return null;
    const worker = this.scopeWorker ??= new Worker(new URL(
      import.meta.url.endsWith('.ts') ? './card-semantic-scope-worker.ts' : './card-semantic-scope-worker.js', import.meta.url));
    const id = ++this.nextId;
    const data: ScopeRead = { id, kind, path: this.index.storage.path, policy: this.policy };
    return new Promise(resolve => {
      const finish = (cards: ProjectedSearchCard[] | null) => {
        clearTimeout(timer);
        this.scopeJob = undefined;
        worker.onmessage = null;
        worker.onerror = null;
        resolve(cards);
      };
      const timer = setTimeout(() => {
        finish(null);
        worker.terminate();
        if (this.scopeWorker === worker) this.scopeWorker = undefined;
      }, 8_000);
      this.scopeJob = { finish };
      worker.onmessage = ({ data }: MessageEvent<ScopeReply>) => { if (data.id === id) finish(data.cards); };
      worker.onerror = event => {
        event.preventDefault();
        finish(null);
        worker.terminate();
        if (this.scopeWorker === worker) this.scopeWorker = undefined;
      };
      try { worker.postMessage(data); }
      catch { finish(null); }
    });
  }

  async search(query: string, select: (signal: AbortSignal) => Promise<KanbanCard[] | null>, signal: AbortSignal, scope: 'board' | 'work' | 'archive' = 'board', projected = false): Promise<CardSemanticResult> {
    const empty = (status: CardSemanticResult['status'], exact: CardSemanticResult['exact'] = []) =>
      ({ status, exact, semantic: [] });
    if (!this.timer || !this.config.enabled || !this.index || !this.policy || this.updating) return empty('off');
    const generation = this.generation;
    const deadline = performance.now() + 300;
    if (signal.aborted || this.waitingForQuery) return empty('timeout');
    if (this.querying) {
      this.waitingForQuery = true;
      try {
        while (this.querying && !signal.aborted && generation === this.generation && performance.now() < deadline) {
          await Bun.sleep(5);
        }
      } finally {
        this.waitingForQuery = false;
      }
      if (signal.aborted || generation !== this.generation) return empty('off');
      if (this.querying || performance.now() >= deadline) return empty('timeout');
    }
    const index = this.index;
    const policy = this.policy;
    let expired = false;
    const deadlineSignal = new AbortController();
    const selectionSignal = AbortSignal.any([signal, deadlineSignal.signal]);
    const valid = () => !expired && !signal.aborted && generation === this.generation && performance.now() < deadline;
    const settingsCurrent = async () => {
      const latest = await this.readSettings();
      return latest.config.enabled && latest.policy.version === policy.version && valid();
    };
    this.querying = true;
    const calculate = async (): Promise<CardSemanticResult> => {
      try {
        if (!await settingsCurrent()) return empty('off');
        const sourceRevision = index.storage.cardSearchRevision();
        const currentScope = () => valid() && sourceRevision === index.storage.cardSearchRevision();
        const cards = await index.storage.readSnapshot(async () => (projected || index.storage.cardSearchWithinBudget(scope !== 'board'))
          ? select(selectionSignal) : null);
        if (!cards || !projected && cards.length > CARD_SEMANTIC_SCOPE_LIMIT || !currentScope()) return empty('timeout');
        const { keys, text } = splitCardSearch(query, new Set(cards.map(card => card.id)));
        if (!keys.size && !text) return empty('ready');
        const exactMatches = (cards: KanbanCard[]) => keys.size
          ? cards.filter(card => {
            if ('searchProjection' in card) {
              const meta = (card as ProjectedSearchCard).searchProjection;
              return keys.has(card.id) || (scope === 'archive' ? meta.archiveKeys : meta.exactKeys).some(key => keys.has(key));
            }
            return exactCardSearchMatch(card.id,
              (scope === 'archive' ? [card.title, card.description, card.projectDir, card.sessionTitle]
                : [card.title, card.description, card.progressSummary, card.result]).join(' '), keys);
          }).slice(0, 50).map(hit)
          : [];
        const exact = exactMatches(cards);
        if (!text || containsSensitiveSearchText(text) || policy.secrets.some(secret => text.includes(secret))) return empty('ready', exact);
        if (this.state !== 'ready') return empty(this.state === 'failed' ? 'failed' : 'preparing', exact);
        while (this.job && valid()) await Bun.sleep(5);
        if (!currentScope()) return empty('timeout');
        const eligible = projected
          ? cards.filter(card => (card as ProjectedSearchCard).searchProjection.inputHash !== null)
          : cards;
        if (eligible.length > CARD_SEMANTIC_SCOPE_LIMIT) return empty('timeout');
        const rows = index.candidates(policy, new Map(eligible.map(card => [card.id, card])));
        if (!rows.length) return empty('ready', exact);
        const array = new Float32Array(rows.length * dimensions);
        rows.forEach((row, i) => array.set(new Float32Array(row.vector.buffer, row.vector.byteOffset, dimensions), i * dimensions));
        if (!valid()) return empty('timeout');
        const reply = await this.request({ type: 'search', text, vectors: array }, 1_000).catch(() => undefined);
        if (!valid() || !reply?.ranked) return empty('timeout');
        if (!await settingsCurrent()) return empty('off');
        const ranked = reply.ranked;
        const finalRevision = index.storage.cardSearchRevision();
        const result = await index.storage.readSnapshot(async (): Promise<CardSemanticResult> => {
          if (!projected && !index.storage.cardSearchWithinBudget(scope !== 'board')) return empty('timeout');
          const latest = await select(selectionSignal);
          if (!latest || !projected && latest.length > CARD_SEMANTIC_SCOPE_LIMIT || !valid()) return empty('timeout');
          const current = new Map(latest.map(card => [card.id, card]));
          const top = new Map(ranked.map(row => [rows[row].card_id, rows[row].token]));
          const matches = index.validate(policy, top, current);
          const semantic = [...top.keys()].filter(id => matches.has(id)).map(id => hit(current.get(id)!));
          return { status: 'ready', exact: exactMatches(latest), semantic };
        });
        // Read outside the snapshot. A Work link or card can change while a
        // cooperative archive selection holds an older consistent snapshot.
        return valid() && finalRevision === index.storage.cardSearchRevision() ? result : empty('timeout');
      } finally {
        this.querying = false;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CardSemanticResult>(resolve => {
      timer = setTimeout(() => {
        expired = true;
        deadlineSignal.abort();
        resolve(empty(signal.aborted || generation !== this.generation ? 'off' : 'timeout'));
      }, Math.max(0, deadline - performance.now()));
    });
    try {
      const result = await Promise.race([calculate(), timeout]);
      return signal.aborted || generation !== this.generation ? empty('off') : result;
    } finally {
      clearTimeout(timer);
      deadlineSignal.abort();
    }
  }

}
