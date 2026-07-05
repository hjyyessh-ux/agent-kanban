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
  const classes = ['neo-alert', `neo-alert--${variant}`, className].filter(Boolean).join(' ');

  return (
    <section className={classes} role="alert" aria-live="assertive" aria-atomic="true">
      <div className="neo-alert__icon" aria-hidden="true">⚠</div>
      <div className="neo-alert__content">
        <p className="neo-alert__title">{title}</p>
        <p className="neo-alert__message">{message}</p>
      </div>
      {(onAction || onDismiss) && (
        <div className="neo-alert__actions">
          {onAction && actionLabel && (
            <button type="button" className="neo-button neo-button--ghost neo-alert__action" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="neo-alert__dismiss" onClick={onDismiss} aria-label="Dismiss alert">
              Dismiss
            </button>
          )}
        </div>
      )}
    </section>
  );
}
