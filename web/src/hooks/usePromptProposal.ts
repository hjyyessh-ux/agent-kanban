import { useEffect, useRef, useState } from 'react';
import { parsePromptProposal, PROMPT_PROPOSAL_SKILL, type PromptProposalProvider } from '../utils/prompt-refinement-provider';
import { MAX_REFINEMENT_INPUT, type PromptLoopOptions } from '../utils/prompt-refinement';

export interface PromptProposalOptions { model: string; loop?: PromptLoopOptions }
/** Any change to source, provider, model or loop fields bumps the key: in-flight replies are aborted and dropped. */
export const proposalRequestKey = (source: string, options: PromptProposalOptions) =>
  JSON.stringify([source, options.model, options.loop ?? null]);

/** An adapter is injected explicitly; no ambient provider or API is used. */
export function usePromptProposal(source: string, provider: PromptProposalProvider | undefined, options: PromptProposalOptions) {
 const active = useRef<AbortController | null>(null);
 const generation = useRef(0);
 const [loading,setLoading] = useState(false);
 const key = proposalRequestKey(source, options);
 const latest = useRef(key); latest.current = key;
 useEffect(() => { generation.current++; active.current?.abort(); setLoading(false); }, [key,provider]);
 useEffect(() => () => { generation.current++; active.current?.abort(); }, []);
 const cancel = () => { generation.current++; active.current?.abort(); setLoading(false); };
 const generate = async () => {
   if (!provider || !options.model || !source.trim() || source.length > MAX_REFINEMENT_INPUT) return null;
   const request = ++generation.current; active.current?.abort();
   const controller = new AbortController(); active.current = controller; setLoading(true);
   const timeout = setTimeout(() => controller.abort(), 60000);
   const {model, loop} = options;
   try {
     const raw = await Promise.race([
       provider.propose({skill:PROMPT_PROPOSAL_SKILL,source,model,...(loop ? {loop} : {})},controller.signal),
       new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('cancelled')), {once:true})),
     ]);
     if (controller.signal.aborted || request !== generation.current || latest.current !== key) return null;
     return parsePromptProposal(source,raw,loop);
   } catch (error) {
     if (request !== generation.current || latest.current !== key) return null;
     throw error;
   } finally { clearTimeout(timeout); if (request === generation.current) setLoading(false); }
 };
 return {generate,cancel,loading};
}
