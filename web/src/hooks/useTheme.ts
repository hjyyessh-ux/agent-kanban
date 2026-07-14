import { useState, useEffect, useCallback } from 'react';

/**
 * Theme preference / resolution, modelled on useFontScale: a hook that owns a
 * `:root`-level presentation choice (here `data-theme` on <html>), persists it
 * to localStorage, and keeps every hook instance + browser tab in sync.
 *
 * `system` follows `prefers-color-scheme`; `light`/`dark` pin the theme. The
 * inline FOUC script in index.html pre-applies the same resolution before first
 * paint — this hook takes over once React mounts and reacts to live changes.
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'kanban-theme';
/** Fired on every (re)apply so listeners (e.g. WikiGraph's canvas) can react. */
const CUSTOM_EVENT = 'kanban-theme-change';
const DEFAULT_PREFERENCE: ThemePreference = 'system';

function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch { /* ignore */ }
  return DEFAULT_PREFERENCE;
}

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch { return false; }
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return prefersDark() ? 'dark' : 'light';
  return pref;
}

interface ThemeChangeDetail {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

/** Stamp <html> and broadcast so sibling hook instances + the canvas re-read. */
function applyTheme(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  window.dispatchEvent(
    new CustomEvent<ThemeChangeDetail>(CUSTOM_EVENT, { detail: { preference: pref, resolved } }),
  );
  return resolved;
}

export interface ThemeHook {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

export function useTheme(): ThemeHook {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readPreference()));

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* ignore */ }
    setResolved(applyTheme(pref));
  }, []);

  // Keep <html> in sync with the current preference (also covers the initial
  // mount, so React owns the attribute the FOUC script seeded).
  useEffect(() => {
    setResolved(applyTheme(preference));
  }, [preference]);

  // Follow the OS scheme while in `system` mode.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readPreference() === 'system') setResolved(applyTheme('system'));
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Cross-tab (storage) + cross-instance (custom event) sync. The custom-event
  // handler only mirrors React state — the DOM was already stamped by whoever
  // dispatched, so it must not re-apply (which would loop).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = readPreference();
      setPreferenceState(next);
      setResolved(applyTheme(next));
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<ThemeChangeDetail>).detail;
      if (!detail) return;
      setPreferenceState(detail.preference);
      setResolved(detail.resolved);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom);
    };
  }, []);

  return { preference, resolved, setPreference };
}
