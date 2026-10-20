import { useCallback, useEffect, useRef, useState } from 'react';

export const COPY_FEEDBACK_MS = 1500;

/**
 * Clipboard copy + a short-lived `copied` flag for in-place `✓ 복사됨` feedback.
 * `resetKey` clears the flag when the thing being copied changes (e.g. the
 * detail dialog switches cards) so stale feedback never shows on a new value.
 */
export function useCopyFeedback(resetKey?: string): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    clearTimer();
    setCopied(false);
  }, [resetKey]);

  useEffect(() => clearTimer, []);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      clearTimer();
      setCopied(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, COPY_FEEDBACK_MS);
    }, () => {
      // Clipboard denied (insecure origin / permissions) — no false "copied".
    });
  }, []);

  return { copied, copy };
}
