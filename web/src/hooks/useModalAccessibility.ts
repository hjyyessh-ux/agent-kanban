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

export function shouldCloseModalOnKey(key: string): boolean {
  return key === 'Escape';
}

export function resolveModalTabTarget<T>(
  activeElement: T | null,
  focusables: readonly T[],
  container: T,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) {
    return container;
  }

  const firstFocusable = focusables[0] ?? container;
  const lastFocusable = focusables[focusables.length - 1] ?? container;

  if (shiftKey) {
    return activeElement === firstFocusable || activeElement === container
      ? lastFocusable
      : null;
  }

  return activeElement === lastFocusable ? firstFocusable : null;
}

export function useModalAccessibility(
  enabled: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  restoreFocusRef?: HTMLElement | null,
  initialFocusRef?: RefObject<HTMLElement | null>,
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

    const requestedInitialFocus = initialFocusRef?.current;
    const firstFocusable = requestedInitialFocus
      && container.contains(requestedInitialFocus)
      && isVisibleFocusableElement(requestedInitialFocus)
      ? requestedInitialFocus
      : focusables[0] ?? container;

    container.focus();
    if (firstFocusable !== container) firstFocusable.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (shouldCloseModalOnKey(event.key)) {
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

      const nextTarget = resolveModalTabTarget(active, currentFocusables, container, event.shiftKey);
      if (nextTarget) {
        event.preventDefault();
        nextTarget.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [enabled, containerRef, initialFocusRef, restoreFocusRef]);
}
