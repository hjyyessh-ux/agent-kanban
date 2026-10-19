import { useEffect, useRef } from 'react';
import { useAnchoredPopover, MetaPopoverPortal } from '../Card/MetaDropdown';

export interface WorksOverflowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** `danger` tints the item — 폐기 is the one destructive entry this menu holds. */
  tone?: 'danger';
}

interface WorksOverflowMenuProps {
  /** Accessible name of both the trigger and the menu. */
  label: string;
  items: WorksOverflowMenuItem[];
  disabled?: boolean;
  /**
   * Keep the popover inside this ancestor (`useAnchoredPopover`'s boundary) —
   * `.kv2-dialog` when the trigger sits in a dialog.
   */
  boundarySelector?: string;
}

/**
 * The Works tab's `⋯` menu — the Inbox header (폐기한 세션) and the assign
 * combobox (폐기 / ⤺ Inbox로 되돌리기). Its job is distance: a destructive action
 * that used to sit as a red button right beside the primary 배정 now needs a
 * deliberate second click.
 *
 * Keyboard follows `WorkSessionMenu` / `BoardColumnMenu`: opening focuses the
 * first item, ↑/↓ and Home/End walk them, Escape closes and returns focus to the
 * trigger without reaching a dialog behind it.
 */
export function WorksOverflowMenu({ label, items, disabled, boundarySelector }: WorksOverflowMenuProps) {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover(180, {
    boundarySelector,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const menuItems = (): HTMLButtonElement[] => Array.from(
    menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
  );

  // The first frame is `visibility: hidden` until the hook has measured it, and
  // a hidden element ignores focus() — so wait for placement.
  const placed = open && popoverStyle.visibility !== 'hidden';
  useEffect(() => {
    if (!placed) return;
    menuItems()[0]?.focus();
  }, [placed]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const focusable = menuItems();
    if (focusable.length === 0) return;
    event.preventDefault();
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? focusable.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + focusable.length) % focusable.length
          : (current - 1 + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  return (
    <div className="kv2-meta-dropdown kv2-meta-dropdown--inline works-overflow">
      <button
        type="button"
        ref={triggerRef}
        className="kv2-btn kv2-btn--small kv2-btn--ghost works-overflow-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={items.map((item) => item.label).join(' · ')}
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>

      {open && (
        <MetaPopoverPortal>
          <div
            ref={(node) => {
              popoverRef.current = node;
              menuRef.current = node;
            }}
            className="kv2-meta-dropdown-popover works-overflow-popover"
            role="menu"
            aria-label={label}
            style={popoverStyle}
            onKeyDown={handleMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`kv2-meta-dropdown-option${item.tone === 'danger' ? ' works-overflow-option--danger' : ''}`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="kv2-meta-dropdown-option-label">{item.label}</span>
              </button>
            ))}
          </div>
        </MetaPopoverPortal>
      )}
    </div>
  );
}
