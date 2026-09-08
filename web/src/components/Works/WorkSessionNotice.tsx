import { useEffect, useRef, useState } from 'react';

/**
 * Outcome of a session-level action, shown as a transient bar. Owned by `App`
 * rather than the Work detail dialog because a move that empties the source Work
 * deletes it, which unmounts that dialog — the explanation has to outlive it.
 */
export interface WorkSessionNoticeState {
  /** `warn` for outcomes that removed something (an emptied Work). */
  tone: 'success' | 'warn';
  message: string;
  /**
   * Present only when the action is genuinely reversible. A move that deleted
   * the emptied source Work is not: re-creating it mints a new id and cannot
   * bring back its Summary or `createdAt`, so no undo is offered rather than one
   * that quietly lies about what it restores.
   */
  undo?: { label: string; run: () => Promise<void> };
}

/**
 * How long an undo stays reachable.
 *
 * 12s was shorter than the action it was offering to reverse: the notice appears
 * while the user is still reading the row that changed, and a 폐기 or a mis-aimed
 * 연결 is exactly the thing you notice a few seconds *after* pressing the key.
 * 30s is long enough to read, look, and reconsider, and still short enough that
 * the bar never becomes permanent chrome.
 */
const DISMISS_MS = 30_000;

interface WorkSessionNoticeProps {
  notice: WorkSessionNoticeState;
  onDismiss: () => void;
}

/**
 * Transient notice for the Works session actions (move / unlink), with an undo
 * button when the action can actually be reversed. Self-dismisses so it never
 * becomes permanent chrome; an undo failure is reported in place instead of
 * silently doing nothing.
 */
export function WorkSessionNotice({ notice, onDismiss }: WorkSessionNoticeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so an inline `onDismiss` from the parent cannot restart the
  // timer on every poll-driven re-render (the notice would never expire).
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // Reset per notice instance and restart the dismiss timer.
  useEffect(() => {
    setBusy(false);
    setError(null);
    const timer = window.setTimeout(() => dismissRef.current(), DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runUndo = () => {
    if (!notice.undo || busy) return;
    setBusy(true);
    setError(null);
    void notice.undo.run()
      .then(() => onDismiss())
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '되돌리지 못했습니다');
        setBusy(false);
      });
  };

  return (
    <div className={`work-session-notice work-session-notice--${notice.tone}`} role="status">
      <span className="work-session-notice-text">{notice.message}</span>
      {error && <span className="work-session-notice-error">⚠ {error}</span>}
      {notice.undo && (
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--outline work-session-notice-action"
          disabled={busy}
          onClick={runUndo}
        >
          {busy ? '되돌리는 중…' : notice.undo.label}
        </button>
      )}
      <button
        type="button"
        className="kv2-btn kv2-btn--small kv2-btn--ghost work-session-notice-action"
        aria-label="알림 닫기"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
