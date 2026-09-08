import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface AnchorCoords {
  top: number;
  left: number;
  minWidth: number;
}

const HIDDEN_POPOVER_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  visibility: "hidden",
  pointerEvents: "none",
};

interface AnchoredPopoverOptions {
  /**
   * Selector for an ancestor the popover should stay inside, on top of the
   * viewport clamp — pass `.kv2-dialog` for a trigger in a dialog row, where a
   * downward popover would otherwise hang past the dialog's own bottom edge and
   * float over the page behind it. Opt-in: without it the popover only respects
   * the viewport (the behaviour the card sidebar's meta fields rely on).
   */
  boundarySelector?: string;
}

/**
 * Anchors a body-portal popover to a trigger button using fixed positioning.
 * This escapes the dialog's `overflow` clipping that breaks `position: absolute`
 * popovers rendered inside the scrollable detail dialog.
 */
export function useAnchoredPopover(
  minPopoverWidth = 200,
  { boundarySelector }: AnchoredPopoverOptions = {},
) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<AnchorCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const popover = popoverRef.current;
    const popoverHeight = popover?.offsetHeight ?? 0;
    const popoverWidth = popover?.offsetWidth ?? rect.width;
    const viewportWidth = window.innerWidth;
    // The popover may not leave the viewport, and — when a boundary is given —
    // not the anchoring box either. Whichever bottom is closer wins.
    const boundary = boundarySelector
      ? trigger.closest(boundarySelector)?.getBoundingClientRect()
      : undefined;
    const bottomLimit = Math.min(
      window.innerHeight,
      boundary?.bottom ?? Number.POSITIVE_INFINITY,
    );
    const topLimit = Math.max(gap, boundary?.top ?? gap);

    const spaceBelow = bottomLimit - rect.bottom;
    const spaceAbove = rect.top - topLimit;
    const openUp =
      popoverHeight > 0 && spaceBelow < popoverHeight + gap && spaceAbove > spaceBelow;
    const top = openUp
      ? Math.max(topLimit, rect.top - gap - popoverHeight)
      : rect.bottom + gap;

    let left = rect.left;
    const maxLeft = viewportWidth - popoverWidth - gap;
    if (left > maxLeft) left = Math.max(gap, maxLeft);

    setCoords({ top, left, minWidth: rect.width });
  }, [boundarySelector]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const popoverStyle: React.CSSProperties = coords
    ? {
        position: "fixed",
        top: coords.top,
        left: coords.left,
        minWidth: Math.max(coords.minWidth, minPopoverWidth),
      }
    : HIDDEN_POPOVER_STYLE;

  return { open, setOpen, triggerRef, popoverRef, popoverStyle };
}

/**
 * Renders popover content into a body-level fixed layer that sits above the
 * dialog overlay (z-index 1000). The layer itself is click-through; only the
 * popover content receives pointer events.
 */
export const MetaPopoverPortal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(<div className="kv2-meta-dropdown-portal">{children}</div>, document.body);

export interface MetaSelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface MetaSelectProps {
  value: string;
  options: MetaSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}

export const MetaSelect: React.FC<MetaSelectProps> = ({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  title,
}) => {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover();
  const selected = options.find((option) => option.value === value);

  return (
    <div className="kv2-meta-dropdown">
      <button
        type="button"
        ref={triggerRef}
        className="kv2-meta-dropdown-trigger"
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
      >
        <span className="kv2-meta-dropdown-trigger-label">{selected?.label ?? value}</span>
        <span className="kv2-meta-dropdown-trigger-arrow" aria-hidden="true">▾</span>
      </button>

      {open && (
        <MetaPopoverPortal>
          <div
            ref={popoverRef}
            className="kv2-meta-dropdown-popover"
            role="listbox"
            aria-label={ariaLabel}
            style={popoverStyle}
          >
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value || "__default"}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  className={`kv2-meta-dropdown-option${isSelected ? " is-selected" : ""}`}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="kv2-meta-dropdown-option-label">{option.label}</span>
                  {option.hint && <span className="kv2-meta-dropdown-option-hint">{option.hint}</span>}
                  {isSelected && <span className="kv2-meta-dropdown-option-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        </MetaPopoverPortal>
      )}
    </div>
  );
};
