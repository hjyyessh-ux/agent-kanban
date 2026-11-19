import { useCallback, useEffect, useState } from 'react';
import {
  buildDeepLinkPath,
  linkLocation,
  parseDeepLink,
  sameDeepLinkTarget,
  type DeepLinkTarget,
  type ParsedDeepLink,
} from '../utils/deep-link';

/** Marks a history entry this app pushed, so closing can pop it instead of stacking a new one. */
const PUSHED_MARK = 'agentKanbanDeepLink';

export interface DeepLinkRequest {
  link: ParsedDeepLink;
  /** 0 = the URL the tab was opened (or reloaded) with; +1 per back/forward. */
  seq: number;
}

function currentTarget(): DeepLinkTarget | null {
  const parsed = parseDeepLink(window.location.search);
  return parsed.kind === 'card' || parsed.kind === 'session' ? parsed : null;
}

function wasPushedHere(): boolean {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[PUSHED_MARK] === true;
}

/**
 * The URL half of deep links: what the address bar asks for (`request`, which
 * changes on load and on back/forward) and the writes the UI makes when it
 * opens or closes a linked layer. Resolving a request into open dialogs is the
 * caller's job — it needs the board data, which this hook knows nothing about.
 *
 * History model: opening a layer on top of the current screen **pushes**
 * (so Back closes it); swapping the content of a layer that is already open
 * **replaces**; closing pops the entry it pushed, or — for a layer that came
 * from the URL the tab was opened with — rewrites the URL to the parent.
 */
export function useDeepLinkHistory() {
  const [request, setRequest] = useState<DeepLinkRequest>(() => ({
    link: parseDeepLink(linkLocation().search),
    seq: 0,
  }));

  useEffect(() => {
    const onPopState = () => {
      setRequest((previous) => ({ link: parseDeepLink(window.location.search), seq: previous.seq + 1 }));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const write = useCallback((target: DeepLinkTarget | null, mode: 'push' | 'replace') => {
    if (sameDeepLinkTarget(currentTarget(), target)) return;
    const path = buildDeepLinkPath(window.location, target);
    if (mode === 'push') {
      window.history.pushState({ [PUSHED_MARK]: true }, '', path);
    } else {
      window.history.replaceState(window.history.state, '', path);
    }
  }, []);

  /** A new layer opened on top of what is shown. */
  const push = useCallback((target: DeepLinkTarget) => write(target, 'push'), [write]);
  /** The open layer now shows something else, or the URL must be corrected in place. */
  const replace = useCallback((target: DeepLinkTarget | null) => write(target, 'replace'), [write]);
  /**
   * The top layer closed; `parent` is what is still on screen. The dialog is
   * already closed by the caller — the resulting popstate only re-confirms it.
   */
  const close = useCallback((parent: DeepLinkTarget | null) => {
    if (sameDeepLinkTarget(currentTarget(), parent)) return;
    if (wasPushedHere()) {
      window.history.back();
      return;
    }
    write(parent, 'replace');
  }, [write]);

  return { request, push, replace, close };
}
