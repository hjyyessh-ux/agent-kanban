import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDirectoryHistory } from "../../hooks/useDirectoryHistory";

interface DirectoryPickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  commitLabel?: string;
  cancelLabel?: string;
  onCommit?: (value: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  variant?: "create" | "meta";
}

function getDirectoryName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "Directory";
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export const DirectoryPicker: React.FC<DirectoryPickerProps> = ({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "/Users/user/workspace/...",
  commitLabel,
  cancelLabel = "Cancel",
  onCommit,
  onCancel,
  autoFocus = false,
  variant = "create",
}) => {
  const { dirHistory, saveDirToHistory, clearDirHistory } = useDirectoryHistory();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedValue = value.trim();
  const hasHistory = dirHistory.length > 0;
  const filteredHistory = useMemo(() => {
    if (!trimmedValue) return dirHistory;
    const query = trimmedValue.toLowerCase();
    return dirHistory.filter((dir) => dir.toLowerCase().includes(query));
  }, [dirHistory, trimmedValue]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select();
      setIsOpen(true);
    }
  }, [autoFocus]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const commitValue = (nextValue: string) => {
    const next = nextValue.trim();
    if (next) saveDirToHistory(next);
    onCommit?.(next);
    setIsOpen(false);
  };

  const selectHistory = (dir: string) => {
    onChange(dir);
    commitValue(dir);
  };

  return (
    <div
      ref={rootRef}
      className={`kv2-directory-picker kv2-directory-picker--${variant}${isOpen ? " is-open" : ""}`}
    >
      <div className="kv2-directory-control">
        <span className="kv2-directory-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3.5 6.5h6.2l1.8 2H20.5v9H3.5v-11Z" fill="#FACC15" stroke="#1F2233" strokeWidth="2" strokeLinejoin="round" />
            <path d="M3.5 8.5h17v9H3.5v-9Z" fill="#FFFFFF" stroke="#1F2233" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </span>
        <input
          id={id}
          ref={inputRef}
          className="kv2-directory-input"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitValue(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setIsOpen(false);
              onCancel?.();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
        />
        <button
          type="button"
          className="kv2-directory-toggle"
          onClick={() => {
            inputRef.current?.focus();
            setIsOpen((current) => !current);
          }}
          disabled={disabled}
          aria-label={isOpen ? "Close directory history" : "Open directory history"}
          aria-expanded={isOpen}
        >
          ▾
        </button>
      </div>

      {isOpen && !disabled && (
        <div className="kv2-directory-popover">
          <div className="kv2-directory-popover-head">
            <span>Recent directories</span>
            {hasHistory && (
              <button type="button" className="kv2-directory-clear" onClick={clearDirHistory}>
                Clear
              </button>
            )}
          </div>

          {filteredHistory.length > 0 ? (
            <div className="kv2-directory-list">
              {filteredHistory.map((dir) => (
                <button
                  type="button"
                  key={dir}
                  className={`kv2-directory-option${dir === trimmedValue ? " is-selected" : ""}`}
                  onClick={() => selectHistory(dir)}
                  title={dir}
                >
                  <span className="kv2-directory-option-name">{getDirectoryName(dir)}</span>
                  <span className="kv2-directory-option-path">{dir}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="kv2-directory-empty">
              {hasHistory ? "No matching directories" : "No directory history yet"}
            </div>
          )}

          {(onCommit || onCancel) && (
            <div className="kv2-directory-actions">
              {onCancel && (
                <button type="button" className="kv2-directory-action kv2-directory-action--ghost" onClick={onCancel}>
                  {cancelLabel}
                </button>
              )}
              {onCommit && (
                <button type="button" className="kv2-directory-action" onClick={() => commitValue(value)}>
                  {commitLabel ?? "Apply"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
