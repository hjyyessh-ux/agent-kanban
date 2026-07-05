import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isVisibleFocusableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);

  if (element.hasAttribute('disabled') || element.tabIndex === -1) return false;
  if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) return false;
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;

  return element.getClientRects().length > 0;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isVisibleFocusableElement);
}

export function useModalAccessibility(
  enabled: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  restoreFocusRef?: HTMLElement | null,
): void {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    const previousActiveElement = (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null) ?? restoreFocusRef ?? null;

    const focusables = getFocusableElements(container);

    const firstFocusable = focusables[0] ?? container;
    const lastFocusable = focusables[focusables.length - 1] ?? container;

    container.focus();
    if (firstFocusable !== container) firstFocusable.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const currentFocusables = getFocusableElements(container);

      if (currentFocusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const firstFocusable = currentFocusables[0] ?? container;
      const lastFocusable = currentFocusables[currentFocusables.length - 1] ?? container;

      if (event.shiftKey) {
        if (active === firstFocusable || active === container) {
          event.preventDefault();
          lastFocusable.focus();
        }
        return;
      }

      if (active === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [enabled, containerRef, restoreFocusRef]);
}
