import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'kanban-font-scale';
const CUSTOM_EVENT = 'kanban-font-scale-change';
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.7;
const MAX_SCALE = 1.5;

function readScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed) && parsed >= MIN_SCALE && parsed <= MAX_SCALE) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_SCALE;
}

/** Current scale cached so the MutationObserver can read it synchronously. */
let currentScale = DEFAULT_SCALE;

function applyScale(value: number): void {
  currentScale = value;
  const strValue = String(value);
  document.documentElement.style.setProperty('--kv2-font-scale', strValue);
  const kv2Elements = document.querySelectorAll<HTMLElement>('.kv2');
  kv2Elements.forEach((el) => { el.style.setProperty('--kv2-font-scale', strValue); });
}

/**
 * MutationObserver that watches for newly-added .kv2 elements (e.g. dialog
 * overlays) and stamps `--kv2-font-scale` on them so they inherit the current
 * scale instead of falling back to the CSS default of 1.
 */
let observer: MutationObserver | null = null;

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (currentScale === DEFAULT_SCALE) return;
    const strValue = String(currentScale);
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        if (el.classList?.contains('kv2')) {
          el.style.setProperty('--kv2-font-scale', strValue);
        }
        const nested = el.querySelectorAll?.('.kv2');
        if (nested) {
          nested.forEach((child) => {
            (child as HTMLElement).style.setProperty('--kv2-font-scale', strValue);
          });
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export interface FontScaleHook {
  scale: number;
  setScale: (value: number) => void;
  min: number;
  max: number;
}

export function useFontScale(): FontScaleHook {
  const [scale, setScaleState] = useState(readScale);

  const setScale = useCallback((value: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 20) / 20));
    setScaleState(clamped);
    localStorage.setItem(STORAGE_KEY, String(clamped));
    applyScale(clamped);
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENT, { detail: clamped }));
  }, []);

  useEffect(() => {
    applyScale(scale);
    ensureObserver();
  }, [scale]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = readScale();
        setScaleState(next);
        applyScale(next);
      }
    };

    const onCustom = (e: Event) => {
      const value = (e as CustomEvent<number>).detail;
      setScaleState(value);
      applyScale(value);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom);
    };
  }, []);

  return { scale, setScale, min: MIN_SCALE, max: MAX_SCALE };
}
