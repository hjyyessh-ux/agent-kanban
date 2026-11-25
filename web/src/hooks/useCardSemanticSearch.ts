import { useEffect, useState } from 'react';
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

export function useCardSemanticSearch(query: string, scope: CardSemanticScope) {
  const active = !!query.trim();
  const [status, setStatus] = useState<CardSemanticStatus | null>(null);
  const [result, setResult] = useState<{ key: string; value: CardSemanticResult } | null>(null);
  const key = active ? JSON.stringify({ query: query.trim(), scope }) : '';

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const refresh = () => {
      void fetchCardSemanticStatus(controller.signal).then(value => {
        if (!controller.signal.aborted) setStatus(value);
      }).catch(() => {
        if (!controller.signal.aborted) setStatus(null);
      });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active]);

  const enabled = status?.enabled && status.state !== 'unavailable';
  const revision = status?.revision;
  const requestKey = key && revision ? key + '\0' + revision : '';
  useEffect(() => {
    if (!requestKey || !enabled) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const search = (canRetry: boolean) => {
      void jsonRequest<CardSemanticResult>(CARD_SEMANTIC_SEARCH_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key, signal: controller.signal,
      }).then(value => {
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, value });
        if (value.status === 'timeout' && canRetry) retry = setTimeout(() => search(false), 1_000);
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ key: requestKey, value: { status: 'failed', exact: [], semantic: [] } });
      });
    };
    search(true);
    return () => { controller.abort(); clearTimeout(retry); };
  }, [key, requestKey, enabled, status?.state]);

  return enabled && result?.key === requestKey ? result.value : null;
}
