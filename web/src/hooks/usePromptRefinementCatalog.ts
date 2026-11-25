import { useCallback, useEffect, useState } from 'react';
import {
  PROMPT_PROPOSAL_PATH, PROMPT_REFINEMENT_DEFAULT_PATH, readPromptCatalog,
  type PromptModelRef, type PromptRefinementCatalog,
} from '../../../src/core/prompt-proposal';
import { readRefinementError } from './usePromptProposalProvider';

export type PromptCatalogStatus = 'loading' | 'ready' | 'error';

/**
 * Refinement model catalog (refinement only — card Model Visibility is separate).
 * `GET` never calls a model; the server checks config, login-file presence and
 * allow-lists. `saveDefault` is an explicit user action, validated server-side.
 */
export function usePromptRefinementCatalog(enabled = true) {
  const [catalog, setCatalog] = useState<PromptRefinementCatalog | null>(null);
  const [status, setStatus] = useState<PromptCatalogStatus>('loading');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setStatus('loading');
    void fetch(PROMPT_PROPOSAL_PATH, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw Error('catalog_unavailable');
        const next = readPromptCatalog(((await res.json()) as { catalog?: unknown })?.catalog);
        if (ctrl.signal.aborted) return;
        if (!next) throw Error('catalog_invalid');
        setCatalog(next); setStatus('ready');
      })
      .catch(() => { if (!ctrl.signal.aborted) { setCatalog(null); setStatus('error'); } });
    return () => ctrl.abort();
  }, [enabled, nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  /** `null` clears the saved default (server default applies again). */
  const saveDefault = useCallback(async (ref: PromptModelRef | null) => {
    const res = await fetch(PROMPT_REFINEMENT_DEFAULT_PATH, ref
      ? { method: 'PUT', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ref) }
      : { method: 'DELETE', cache: 'no-store' });
    if (!res.ok) { const error = await readRefinementError(res, 'save_failed'); reload(); throw error; }
    const next = readPromptCatalog(((await res.json()) as { catalog?: unknown })?.catalog);
    if (next) { setCatalog(next); setStatus('ready'); } else reload();
  }, [reload]);
  return { catalog, status, reload, saveDefault };
}

export const formatModelRef = (ref: PromptModelRef | null | undefined) => ref ? `${ref.provider} / ${ref.model}` : '없음';

/** User-facing text for server error codes. Never shows upstream/provider text. */
export function refinementErrorMessage(code: string): string {
  switch (code) {
    case 'provider_changed': case 'model_not_allowed': case 'model_not_selectable':
      return '서버가 이 모델을 지금 허용하지 않습니다. 목록을 새로 불러왔습니다.';
    case 'provider_not_ready':
      return '연결·로그인 상태가 확인되지 않아 보내지 않았습니다. 설정 › 다듬기 모델에서 상태를 확인하세요.';
    case 'proposal_busy': return '다른 제안 생성이 진행 중입니다. 잠시 후 다시 시도하세요.';
    case 'provider_unavailable': return '연결된 다듬기 모델이 없습니다.';
    case 'prefs_unavailable': case 'prefs_write_failed': case 'save_failed': return '기본값을 저장하지 못했습니다.';
    default: return 'AI 제안을 받지 못했습니다.';
  }
}
