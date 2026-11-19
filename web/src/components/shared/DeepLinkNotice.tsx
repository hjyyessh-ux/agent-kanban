import './DeepLinkNotice.css';

/**
 * Why a shared link could not be followed exactly — or followed with a caveat
 * (an archived card/session). Owned by `App` because a link resolves before
 * any dialog exists, and the reason has to stay readable after one opens.
 */
export interface DeepLinkNoticeState {
  /** `error`: nothing (or not the exact thing) opened. `info`: opened, with a caveat. */
  tone: 'error' | 'info';
  /** Stable machine-readable reason — tests and support read this, not the copy. */
  reason:
    | 'invalid'
    | 'card-not-found'
    | 'session-not-found'
    | 'message-not-found'
    | 'access-denied'
    | 'load-failed'
    | 'archived';
  title: string;
  message: string;
}

interface DeepLinkNoticeProps {
  notice: DeepLinkNoticeState;
  onDismiss: () => void;
}

/** Stays until dismissed: a link that failed silently is the bug this exists to fix. */
export function DeepLinkNotice({ notice, onDismiss }: DeepLinkNoticeProps) {
  return (
    <div
      className={`deep-link-notice deep-link-notice--${notice.tone}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-reason={notice.reason}
    >
      <div className="deep-link-notice-body">
        <strong className="deep-link-notice-title">{notice.title}</strong>
        <span className="deep-link-notice-message">{notice.message}</span>
      </div>
      <button
        type="button"
        className="kv2-btn kv2-btn--small kv2-btn--ghost deep-link-notice-dismiss"
        aria-label="링크 안내 닫기"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
