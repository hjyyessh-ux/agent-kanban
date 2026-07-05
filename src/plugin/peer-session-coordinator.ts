import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileLock } from '../core/filelock';

const PROTOCOL_VERSION = 1;
const PEER_CAPABILITY = 'session-aggregate';
const PEER_QUERY_TIMEOUT_MS = 250;
const AGGREGATION_CONCURRENCY = 4;

export interface NativeSessionInfo {
  sessionId: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  updatedAt?: string;
  sourceInstanceId?: string;
  sourcePort?: number;
  sourceIsLocal?: boolean;
  sourceCwd?: string;
}

interface PeerRecord {
  protocol: number;
  instanceId: string;
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  cwd: string;
  state: 'ready' | 'draining';
  capabilities: string[];
}

export interface LocalPeerSessionPayload {
  instanceId: string;
  port?: number;
  cwd?: string;
  sessions: NativeSessionInfo[];
}

export class PeerSessionCoordinator {
  private readonly peersDir: string;
  private readonly tokenPath: string;
  private readonly tokenLock: FileLock;
  private readonly instanceId: string;
  private readonly startedAt: string;
  private token = '';
  private recordPath: string;
  private localRecord: PeerRecord | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly listLocalSessions: () => Promise<NativeSessionInfo[]>,
  ) {
    this.peersDir = join(this.dataDir, 'peers');
    this.tokenPath = join(this.dataDir, '.peer-token');
    this.tokenLock = new FileLock(join(this.dataDir, '.peer-token.lock'));
    this.instanceId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.recordPath = join(this.peersDir, `${this.instanceId}.json`);
  }

  async init(): Promise<void> {
    this.ensurePeersDir();
    this.token = await this.loadOrCreateToken();
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getPeerToken(): string {
    return this.token;
  }

  buildLocalPayload = async (): Promise<LocalPeerSessionPayload> => {
    const sessions = await this.listLocalSessions();
    return {
      instanceId: this.instanceId,
      port: this.localRecord?.port,
      cwd: this.localRecord?.cwd,
      sessions,
    };
  };

  register(port: number): void {
    this.ensurePeersDir();
    const record: PeerRecord = {
      protocol: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: this.startedAt,
      host: '127.0.0.1',
      port,
      cwd: process.cwd(),
      state: 'ready',
      capabilities: [PEER_CAPABILITY],
    };
    this.writePeerRecord(record);
    this.localRecord = record;
  }

  markDraining(): void {
    if (!this.localRecord) return;
    this.localRecord = {
      ...this.localRecord,
      state: 'draining',
    };
    this.writePeerRecord(this.localRecord);
  }

  unregister(): void {
    try {
      unlinkSync(this.recordPath);
    } catch {
    }
    this.localRecord = undefined;
  }

  async aggregateAllSessions(): Promise<NativeSessionInfo[]> {
    const peers = this.listPeerRecords().filter((peer) =>
      peer.protocol === PROTOCOL_VERSION
      && peer.state === 'ready'
      && peer.capabilities.includes(PEER_CAPABILITY),
    );

    const stalePeers: PeerRecord[] = [];
    const merged = new Map<string, NativeSessionInfo>();
    const queue = [...peers];

    const workers = Array.from(
      { length: Math.min(AGGREGATION_CONCURRENCY, Math.max(queue.length, 1)) },
      async () => {
        while (queue.length > 0) {
          const peer = queue.shift();
          if (!peer) continue;

          const sessions = await this.fetchPeerSessions(peer);
          if (!sessions) {
            stalePeers.push(peer);
            continue;
          }

          for (const session of sessions) {
            if (!session.sessionId) continue;
            const existing = merged.get(session.sessionId);
            if (!existing || this.sessionSortValue(session) > this.sessionSortValue(existing)) {
              merged.set(session.sessionId, session);
            }
          }
        }
      },
    );

    await Promise.all(workers);

    for (const stalePeer of stalePeers) {
      await this.cleanupPeerRecord(stalePeer);
    }

    return Array.from(merged.values()).sort(
      (a, b) => this.sessionSortValue(b) - this.sessionSortValue(a),
    );
  }

  private ensurePeersDir(): void {
    if (!existsSync(this.peersDir)) {
      mkdirSync(this.peersDir, { recursive: true });
    }
  }

  private async loadOrCreateToken(): Promise<string> {
    this.ensurePeersDir();
    return this.tokenLock.withLock(async () => {
      if (existsSync(this.tokenPath)) {
        const existing = readFileSync(this.tokenPath, 'utf-8').trim();
        if (existing.length > 0) {
          return existing;
        }
      }

      const created = randomBytes(32).toString('base64url');
      writeFileSync(this.tokenPath, created, { mode: 0o600 });
      return created;
    });
  }

  private writePeerRecord(record: PeerRecord): void {
    const tempPath = `${this.recordPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, JSON.stringify(record, null, 2));
    renameSync(tempPath, this.recordPath);
  }

  private listPeerRecords(): PeerRecord[] {
    this.ensurePeersDir();

    const entries = readdirSync(this.peersDir)
      .filter((name) => name.endsWith('.json'));

    const records: PeerRecord[] = [];
    for (const entry of entries) {
      const path = join(this.peersDir, entry);
      const parsed = this.readPeerRecord(path);
      if (parsed) {
        records.push(parsed);
      }
    }
    return records;
  }

  private readPeerRecord(path: string): PeerRecord | undefined {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PeerRecord>;
      if (
        parsed.protocol !== PROTOCOL_VERSION
        || typeof parsed.instanceId !== 'string'
        || typeof parsed.pid !== 'number'
        || typeof parsed.startedAt !== 'string'
        || typeof parsed.host !== 'string'
        || typeof parsed.port !== 'number'
        || typeof parsed.cwd !== 'string'
        || (parsed.state !== 'ready' && parsed.state !== 'draining')
        || !Array.isArray(parsed.capabilities)
      ) {
        return undefined;
      }

      return {
        protocol: parsed.protocol,
        instanceId: parsed.instanceId,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        host: parsed.host,
        port: parsed.port,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        state: parsed.state,
        capabilities: parsed.capabilities,
      };
    } catch {
      return undefined;
    }
  }

  private async fetchPeerSessions(peer: PeerRecord): Promise<NativeSessionInfo[] | undefined> {
    if (!this.isPidAlive(peer.pid)) {
      return undefined;
    }

    if (peer.instanceId === this.instanceId) {
      const sessions = await this.listLocalSessions();
      return sessions.map((session) => ({
        ...session,
        sourceInstanceId: this.instanceId,
        sourcePort: peer.port,
        sourceIsLocal: true,
        sourceCwd: peer.cwd,
      }));
    }

    try {
      const response = await fetch(`http://${peer.host}:${peer.port}/api/internal/sessions/native`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(PEER_QUERY_TIMEOUT_MS),
      });

      if (!response.ok) {
        return undefined;
      }

      const payload = await response.json() as LocalPeerSessionPayload;
      if (payload.instanceId !== peer.instanceId || !Array.isArray(payload.sessions)) {
        return undefined;
      }

      return payload.sessions.map((session) => ({
        ...session,
        sourceInstanceId: payload.instanceId,
        sourcePort: payload.port ?? peer.port,
        sourceIsLocal: false,
        sourceCwd: payload.cwd ?? peer.cwd,
      }));
    } catch {
      return undefined;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupPeerRecord(stalePeer: PeerRecord): Promise<void> {
    const lock = new FileLock(join(this.peersDir, `${stalePeer.instanceId}.lock`), {
      retryMs: 0,
      maxRetries: 0,
    });

    const lockAcquired = await lock.tryAcquire();
    if (!lockAcquired) return;

    try {
      const current = this.readPeerRecord(join(this.peersDir, `${stalePeer.instanceId}.json`));
      if (!current) return;

      const unchanged = current.instanceId === stalePeer.instanceId
        && current.startedAt === stalePeer.startedAt
        && current.pid === stalePeer.pid
        && current.port === stalePeer.port
        && current.cwd === stalePeer.cwd;
      if (!unchanged) return;

      try {
        unlinkSync(join(this.peersDir, `${stalePeer.instanceId}.json`));
      } catch {
      }
    } finally {
      lock.release();
    }
  }

  private sessionSortValue(session: NativeSessionInfo): number {
    if (session.updatedAt) {
      const parsed = new Date(session.updatedAt).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (session.sessionCreatedAt) {
      const parsed = new Date(session.sessionCreatedAt).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }
}
