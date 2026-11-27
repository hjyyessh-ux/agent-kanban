import { useEffect, useMemo, useState } from 'react';
import {
  CARD_SEMANTIC_SEARCH_PATH, CARD_SEMANTIC_SETTINGS_PATH,
  type CardSemanticConfig, type CardSemanticScope, type CardSemanticStatus, type CardSemanticResult,
} from '../../../src/core/card-semantic';

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw Error('의미 검색에 연결하지 못했습니다.');
  return response.json() as Promise<T>;
}

export function fetchCardSemanticStatus(signal?: AbortSignal) {
  return jsonRequest<CardSemanticStatus>(CARD_SEMANTIC_SETTINGS_PATH, { signal });
}

export function saveCardSemanticConfig(config: CardSemanticConfig) {
  return jsonRequest<CardSemanticStatus>(CARD_SEMANTIC_SETTINGS_PATH, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
  });
}

export function retryCardSemanticIndex() {
  return jsonRequest<CardSemanticStatus>(`${CARD_SEMANTIC_SETTINGS_PATH}/retry`, { method: 'POST' });
}

export function useCardSemanticSearchState(query: string, scope: CardSemanticScope) {
  const active = !!query.trim();
  const key = active ? JSON.stringify({ query: query.trim(), scope }) : '';
  const [status, setStatus] = useState<CardSemanticStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const request = useMemo(() => ({ key, revision: status?.revision, state: status?.state }),
    [key, status?.revision, status?.state]);
  const [result, setResult] = useState<{ request: typeof request; value: CardSemanticResult } | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const refresh = () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2_500)]);
      void fetchCardSemanticStatus(signal).then(value => {
        if (signal.aborted) return;
        setStatus(value);
        setStatusFailed(false);
      }).catch(() => {
        if (controller.signal.aborted) return;
        setStatus(null);
        setStatusFailed(true);
      });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active]);

  const enabled = status?.enabled && status.state !== 'unavailable';
  useEffect(() => {
    if (!request.key || !request.revision || !enabled) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const search = (canRetry: boolean) => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
      void jsonRequest<CardSemanticResult>(CARD_SEMANTIC_SEARCH_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.key, signal,
      }).then(value => {
        if (signal.aborted) return;
        setResult({ request, value });
        if (value.status === 'timeout' && canRetry) retry = setTimeout(() => search(false), 1_000);
      }).catch(() => {
        if (controller.signal.aborted) return;
        setResult({ request, value: { status: signal.aborted ? 'timeout' : 'failed', exact: [], semantic: [] } });
      });
    };
    search(true);
    return () => { controller.abort(); clearTimeout(retry); };
  }, [request, enabled]);

  const current = active && enabled && result?.request === request ? result.value : null;
  const phase: CardSemanticResult['status'] | 'pending' = current?.status ?? (statusFailed || status?.state === 'unavailable' ? 'failed'
    : !status || status.state === 'ready' ? 'pending' : status.state);
  return { result: current, phase };
}

export function useCardSemanticSearch(query: string, scope: CardSemanticScope) {
  return useCardSemanticSearchState(query, scope).result;
}
