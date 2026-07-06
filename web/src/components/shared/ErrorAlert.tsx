export interface ErrorAlertProps {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  variant?: 'banner' | 'inline';
  className?: string;
}

export function ErrorAlert({
  title,
  message,
  actionLabel,
  onAction,
  onDismiss,
  variant = 'banner',
  className,
}: ErrorAlertProps) {
  const classes = ['kv2-alert', `kv2-alert--${variant}`, className].filter(Boolean).join(' ');

  return (
    <section className={classes} role="alert" aria-live="assertive" aria-atomic="true">
      <div className="kv2-alert__icon" aria-hidden="true">⚠</div>
      <div className="kv2-alert__content">
        <p className="kv2-alert__title">{title}</p>
        <p className="kv2-alert__message">{message}</p>
      </div>
      {(onAction || onDismiss) && (
        <div className="kv2-alert__actions">
          {onAction && actionLabel && (
            <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--small kv2-alert__action" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="kv2-alert__dismiss" onClick={onDismiss} aria-label="Dismiss alert">
              Dismiss
            </button>
          )}
        </div>
      )}
    </section>
  );
}
