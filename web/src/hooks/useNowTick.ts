import { useEffect, useState } from 'react';

/**
 * Current time (`Date.now()`), re-read every `intervalMs` while `enabled`.
 *
 * Only the component that calls it re-renders on each tick, so keep the call
 * inside the smallest leaf that shows the live value (e.g. a card's elapsed
 * time line) — never in a board/column component, or every card repaints once
 * a second. While disabled no timer runs and the returned value is frozen at
 * the last render.
 */
export function useNowTick(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);

  return now;
}
