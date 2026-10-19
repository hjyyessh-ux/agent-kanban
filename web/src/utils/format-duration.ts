// Human-readable elapsed duration from milliseconds (e.g. "1h 12m", "45s").
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// Compact relative timestamp for dense board-card metadata.
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '';

  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

// Live elapsed time for a running card ("12분 34초", "1시간 2분 5초"). Seconds
// are always shown because it ticks every second — a value that only changes
// once a minute reads as frozen.
export function formatElapsedKo(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
}

// Run length of a finished card: the recorded `durationMs` wins, else the
// span between `startedAt` and `completedAt`; null when neither is known.
export function resolveRunDurationMs(run: {
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}): number | null {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) return run.durationMs;
  if (!run.startedAt || !run.completedAt) return null;
  const span = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(span) && span >= 0 ? span : null;
}
