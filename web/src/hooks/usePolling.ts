import { useEffect } from 'react';

export function startPolling(
  callback: () => void | Promise<void>,
  interval: number,
  schedule: (
    callback: () => void,
    interval: number,
  ) => ReturnType<typeof setInterval> = (scheduledCallback, delay) => (
    setInterval(scheduledCallback, delay)
  ),
  cancel: (id: ReturnType<typeof setInterval>) => void = (id) => clearInterval(id),
): () => void {
  const id = schedule(() => {
    void callback();
  }, interval);
  return () => cancel(id);
}

export function usePolling(
  callback: () => void | Promise<void>,
  interval: number,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return;
    return startPolling(callback, interval);
  }, [callback, interval, enabled]);
}
