import React, { useEffect, useRef } from 'react';
import { useAnchoredPopover, MetaPopoverPortal } from '../Card/MetaDropdown';

export interface BoardColumnMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

interface BoardColumnMenuProps {
  /** Column label, used to name the trigger for assistive tech. */
  columnLabel: string;
  items: BoardColumnMenuItem[];
}

/**
 * The column header's `⋯` menu. `Hide All` / `Done All` / `Archive All` used to
 * sit in the header as buttons, which squeezed the label down to `COMP…`; one
 * trigger leaves the label its full width.
 *
 * Keyboard follows `WorkSessionMenu`: opening focuses the first item, ↑/↓ and
 * Home/End walk them, Escape closes and returns focus to the trigger.
 * `useAnchoredPopover` portals to the body and closes on an outside pointerdown.
 */
export function BoardColumnMenu({ columnLabel, items }: BoardColumnMenuProps) {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover(160);
  const menuRef = useRef<HTMLDivElement>(null);

  const menuItems = (): HTMLButtonElement[] => Array.from(
    menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
  );

  // The popover's first frame is `visibility: hidden` until the hook has
  // measured it, and a hidden element ignores focus() — so wait for placement.
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
    <div className="kv2-meta-dropdown kv2-meta-dropdown--inline kv2-column-menu">
      <button
        type="button"
        ref={triggerRef}
        className="kv2-column-action kv2-column-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${columnLabel} column actions`}
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
            className="kv2-meta-dropdown-popover kv2-column-menu-popover"
            role="menu"
            aria-label={`${columnLabel} column actions`}
            style={popoverStyle}
            onKeyDown={handleMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="kv2-meta-dropdown-option"
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
