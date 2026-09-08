import { useEffect, useRef, useState } from 'react';
import type { WorkSessionRole } from '../../../../src/core/types';
import { useAnchoredPopover, MetaPopoverPortal } from '../Card/MetaDropdown';
import { ROLE_LABELS, ROLE_OPTIONS } from './worksAssign';

interface WorkSessionMenuProps {
  /** The link's current role — ticked in the 역할 변경 group. */
  role?: WorkSessionRole;
  disabled?: boolean;
  onMove: () => void;
  onSetRole: (role: WorkSessionRole) => void;
  onUnlink: () => void;
}

/**
 * The `⋯` overflow menu on a Work's linked-session row. The row is already
 * dense, so the three session-level actions fold into one menu instead of
 * sitting next to 대화 as buttons:
 *
 *     ↪ 다른 Work로 이동…
 *     🏷 역할 변경 ▸ 개발 / 리뷰 / 디버그
 *     ⤺ 연결 해제 (Inbox로)
 *
 * 역할 변경 needs no endpoint of its own — a same-Work re-link refreshes the
 * link's role — and it lives here because "the Work is right, the role is wrong"
 * is most of what mis-assignment actually looks like.
 *
 * The role group expands inside this popover rather than flying out as a second
 * floating layer: three options do not justify a nested menu, and one popover
 * keeps focus trapping inside the detail dialog simple. Positioning reuses
 * `useAnchoredPopover`, which portals to the body so the dialog's `overflow`
 * cannot clip the menu (and which already closes on an outside pointerdown).
 *
 * `role="menu"` is a promise about the keyboard, so this honours it: opening
 * focuses the first item, ↑/↓ and Home/End walk them, and Escape closes the
 * menu **without** closing the Work detail dialog behind it — the hook's own
 * Escape listener is on `document`, so the key would otherwise reach
 * `DialogSkeleton` as well and take the dialog with it.
 */
export function WorkSessionMenu({
  role,
  disabled,
  onMove,
  onSetRole,
  onUnlink,
}: WorkSessionMenuProps) {
  // Anchored to the detail dialog: the row sits low enough that a downward
  // popover would hang past the dialog's bottom edge over the page behind it.
  const { open, setOpen, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover(220, {
    boundarySelector: '.kv2-dialog',
  });
  const [rolesOpen, setRolesOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setRolesOpen(false);
  };

  /** The menu's focusable items, in render order. */
  const items = (): HTMLButtonElement[] => Array.from(
    menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
  );

  // A menu that opens with focus left on its trigger cannot be driven by the
  // arrow keys it advertises.
  useEffect(() => {
    if (!open) return;
    const first = items()[0];
    first?.focus();
    // Re-running on `rolesOpen` would steal focus back to the first item every
    // time the role group expands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Stop it here: `document`-level listeners (this popover's own, and the
      // detail dialog's) would otherwise both act on one press.
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const focusable = items();
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
    <div className="kv2-meta-dropdown kv2-meta-dropdown--inline work-session-menu">
      <button
        type="button"
        ref={triggerRef}
        className="kv2-btn kv2-btn--small kv2-btn--ghost work-session-menu-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="세션 작업 메뉴"
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
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
            className="kv2-meta-dropdown-popover work-session-menu-popover"
            role="menu"
            aria-label="세션 작업"
            style={popoverStyle}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="kv2-meta-dropdown-option"
              onClick={() => {
                close();
                onMove();
              }}
            >
              <span className="kv2-meta-dropdown-option-label">↪ 다른 Work로 이동…</span>
            </button>

            <div className="work-session-menu-sep" role="separator" />

            <button
              type="button"
              // A `role="menu"` may only contain menu items; this row was the
              // one child without a role, so assistive tech read the group's
              // own toggle as a plain button inside a menu.
              role="menuitem"
              className="kv2-meta-dropdown-option"
              aria-expanded={rolesOpen}
              onClick={() => setRolesOpen((current) => !current)}
            >
              <span className="kv2-meta-dropdown-option-label">🏷 역할 변경</span>
              <span className="kv2-meta-dropdown-option-hint" aria-hidden="true">
                {role ? ROLE_LABELS[role] : '없음'} {rolesOpen ? '▾' : '▸'}
              </span>
            </button>
            {rolesOpen && ROLE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === role}
                className={`kv2-meta-dropdown-option work-session-menu-sub${option === role ? ' is-selected' : ''}`}
                onClick={() => {
                  close();
                  if (option !== role) onSetRole(option);
                }}
              >
                <span className="kv2-meta-dropdown-option-label">{ROLE_LABELS[option]}</span>
                {option === role && (
                  <span className="kv2-meta-dropdown-option-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}

            <div className="work-session-menu-sep" role="separator" />

            <button
              type="button"
              role="menuitem"
              className="kv2-meta-dropdown-option"
              onClick={() => {
                close();
                onUnlink();
              }}
            >
              <span className="kv2-meta-dropdown-option-label">⤺ 연결 해제 (Inbox로)</span>
            </button>
          </div>
        </MetaPopoverPortal>
      )}
    </div>
  );
}
