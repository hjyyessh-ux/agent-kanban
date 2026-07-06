import React, { useRef } from "react";
import { useModalAccessibility } from "../../hooks/useModalAccessibility";
import { usePersistedDialogSize } from "../../hooks/usePersistedDialogSize";

interface DialogSkeletonProps {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
  className?: string;
  persistSizeKey?: string;
  defaultSize?: { width: number; height: number };
}

const DEFAULT_DIALOG_SIZE = { width: 900, height: 600 };

export const DialogSkeleton: React.FC<DialogSkeletonProps> = ({
  title,
  onClose,
  children,
  width = "900px",
  className,
  persistSizeKey,
  defaultSize,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useModalAccessibility(true, modalRef, onClose);
  usePersistedDialogSize(persistSizeKey, modalRef, defaultSize ?? DEFAULT_DIALOG_SIZE);

  const resizable = !!persistSizeKey;
  const dialogStyle: React.CSSProperties = resizable
    ? { resize: "both", overflow: "hidden" }
    : { maxWidth: width };

  return (
    <div
      className="kv2-dialog-overlay"
      ref={overlayRef}
      role="presentation"
    >
      <button
        type="button"
        className="kv2-dialog-backdrop"
        onClick={onClose}
        aria-label="Close dialog backdrop"
      />
      <div
        ref={modalRef}
        className={["kv2-dialog", resizable ? "kv2-dialog--resizable" : "", className].filter(Boolean).join(" ")}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "dialog-title" : undefined}
        aria-label={title ? undefined : "Dialog"}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
          }
          e.stopPropagation();
        }}
      >
        <div className="kv2-dialog-header">
          {title && (
            <h2 id="dialog-title" className="kv2-dialog-title">
              {title}
            </h2>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="kv2-dialog-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className="kv2-dialog-content">{children}</div>
      </div>
    </div>
  );
};
