import { useEffect, useState } from 'react';
import { PROMPT_MODEL_PATTERN, PROMPT_PROPOSAL_PATH } from '../../../src/core/prompt-proposal';
import type { PromptProposalProvider } from '../utils/prompt-refinement-provider';

/** Provider/model metadata comes only from the server allow-list. Nothing is sent until `propose` is called. */
export function usePromptProposalProvider(injected?: PromptProposalProvider) {
  const [configured, setConfigured] = useState<PromptProposalProvider>();
  useEffect(() => {
    if (injected) return;
    const ctrl = new AbortController();
    void fetch(PROMPT_PROPOSAL_PATH, {signal:ctrl.signal, cache:'no-store'})
      .then(async (res) => {
        if (!res.ok || ctrl.signal.aborted) return;
        const data = await res.json() as {provider?: {provider?: string; model?: string; models?: unknown} | null};
        const value = data?.provider;
        if (ctrl.signal.aborted || (value?.provider !== 'OpenAI' && value?.provider !== 'Codex CLI') || typeof value.model !== 'string' ||
            !PROMPT_MODEL_PATTERN.test(value.model)) return;
        const {provider, model} = value;
        const listed = Array.isArray(value.models)
          ? value.models.filter((m): m is string => typeof m === 'string' && PROMPT_MODEL_PATTERN.test(m)) : [];
        setConfigured({
          provider, model, models: listed.includes(model) ? listed : [model, ...listed],
          propose: async ({source, model: selected, loop}, signal) => {
            const reply = await fetch(PROMPT_PROPOSAL_PATH, {
              method:'POST', cache:'no-store', signal,
              headers:{'content-type':'application/json'},
              body:JSON.stringify({source, provider, model:selected, consent:true, ...(loop ? {loop} : {})}),
            });
            if (!reply.ok) throw Error('provider_unavailable');
            return reply.json();
          },
        });
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [injected]);
  return injected ?? configured;
}
