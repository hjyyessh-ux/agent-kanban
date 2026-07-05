const locks = new Map<string, { token: symbol; promise: Promise<void> }>();

export async function withSpawnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key)?.promise ?? Promise.resolve();
  const token = Symbol(`lock-${key}`);
  let release: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  locks.set(key, { token, promise: previous.then(() => current) });
  await previous;

  try {
    return await fn();
  } finally {
    release!();
    if (locks.get(key)?.token === token) {
      locks.delete(key);
    }
  }
}
