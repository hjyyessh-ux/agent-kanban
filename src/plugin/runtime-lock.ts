import { join } from 'node:path';
import { FileLock } from '../core/filelock';

const REFRESH_INTERVAL_MS = 10_000;

type RuntimeLockListener = (isOwner: boolean) => void | Promise<void>;

export class RuntimeLock {
  private readonly fileLock: FileLock;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private owner = false;
  private readonly listeners = new Set<RuntimeLockListener>();
  private ticking = false;

  constructor(dataDir: string, name: string) {
    this.fileLock = new FileLock(join(dataDir, `.${name}.lock`), {
      staleMs: REFRESH_INTERVAL_MS * 3,
      retryMs: 0,
      maxRetries: 0,
    });
  }

  async acquire(): Promise<boolean> {
    this.owner = await this.fileLock.tryAcquire();
    this.startHeartbeat();
    return this.owner;
  }

  onChange(listener: RuntimeLockListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private startHeartbeat(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.tick().catch(() => {});
    }, REFRESH_INTERVAL_MS);

    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      (this.intervalId as NodeJS.Timeout).unref();
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
    const previousOwner = this.owner;

    if (this.owner) {
      this.owner = this.fileLock.refresh();
    } else {
      this.owner = await this.fileLock.tryAcquire();
    }

    if (previousOwner !== this.owner) {
      for (const listener of this.listeners) {
        await listener(this.owner);
      }
    }
    } finally {
      this.ticking = false;
    }
  }

  isOwner(): boolean {
    return this.owner;
  }

  release(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.listeners.clear();
    this.fileLock.release();
    this.owner = false;
  }
}
