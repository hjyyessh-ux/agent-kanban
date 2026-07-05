import { useEffect } from 'react';

export function usePolling(
  callback: () => void | Promise<void>,
  interval: number,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      void callback();
    }, interval);

    return () => clearInterval(id);
  }, [callback, interval, enabled]);
}
