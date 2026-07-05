import { RefObject, useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 480;
const MIN_HEIGHT = 300;
const DEBOUNCE_MS = 300;

interface PersistedSize {
  width: number;
  height: number;
}

function clampSize(width: number, height: number): PersistedSize {
  const maxW = window.innerWidth * 0.95;
  const maxH = window.innerHeight * 0.95;
  return {
    width: Math.round(Math.min(maxW, Math.max(MIN_WIDTH, width))),
    height: Math.round(Math.min(maxH, Math.max(MIN_HEIGHT, height))),
  };
}

function readSize(key: string, fallback: PersistedSize): PersistedSize {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSize;
      if (
        typeof parsed.width === 'number' &&
        typeof parsed.height === 'number' &&
        parsed.width >= MIN_WIDTH &&
        parsed.height >= MIN_HEIGHT
      ) {
        return clampSize(parsed.width, parsed.height);
      }
    }
  } catch { /* corrupt data */ }
  return fallback;
}

function writeSize(key: string, size: PersistedSize): void {
  try {
    localStorage.setItem(key, JSON.stringify(size));
  } catch { /* quota exceeded */ }
}

export function usePersistedDialogSize(
  storageKey: string | undefined,
  dialogRef: RefObject<HTMLElement | null>,
  defaultSize: PersistedSize,
): PersistedSize {
  const [size, setSize] = useState<PersistedSize>(
    () => storageKey ? readSize(storageKey, defaultSize) : defaultSize,
  );

  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const isProgrammatic = useRef(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !storageKeyRef.current) return;

    isProgrammatic.current = true;
    el.style.width = `${size.width}px`;
    el.style.height = `${size.height}px`;
  }, [dialogRef, size]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !storageKey) return;

    const observer = new ResizeObserver(() => {
      if (isProgrammatic.current) {
        isProgrammatic.current = false;
        return;
      }

      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width < 1 || height < 1) return;

      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const clamped = clampSize(width, height);
        setSize(clamped);
        if (storageKeyRef.current) {
          writeSize(storageKeyRef.current, clamped);
        }
      }, DEBOUNCE_MS);
    });

    observer.observe(el);
    return () => {
      clearTimeout(debounceTimer.current);
      observer.disconnect();
    };
  }, [dialogRef, storageKey]);

  return size;
}
